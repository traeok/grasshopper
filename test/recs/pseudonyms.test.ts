import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { findShellBinary } from "../../src/apply/shells.ts";
import { openDb } from "../../src/core/db.ts";
import { GhopError } from "../../src/core/errors.ts";
import type { PseudonymMap } from "../../src/privacy/pseudonyms.ts";
import { depseudonymizeForShell, loadPseudonyms, renderText, stripTerminalControls } from "../../src/recs/pseudonyms.ts";
import { dim, sprout } from "../../src/ui/style.ts";
import { withTempHome } from "../helpers/env.ts";

function saveMap(id: string, map: unknown): void {
  openDb().query("INSERT INTO analyses (id, created_at, shell, stats, profile, messages, pseudonyms) VALUES (?, '2026-11-12', 'bash', '{}', '{}', '[]', ?)").run(id, JSON.stringify(map));
}

const map: PseudonymMap = {
  "<path#1>": { type: "path", value: "~/work/project" },
  "<arg#1>": { type: "arg", value: 'a b\\c"$HOME`date`' },
};

describe("recommendation pseudonyms", () => {
  test("renders known values and dims generic and unknown placeholders", () => {
    expect(renderText("cd <path#1>; <path> <host#9>", map))
      .toBe(`cd ${sprout("~/work/project")}; ${dim("<path>")} ${dim("<host#9>")}`);
    expect(stripVTControlCharacters(renderText("<arg#1>", map))).toBe(map["<arg#1>"]!.value);
  });

  test("substitutes shell-safe values and quotes every shell-sensitive character", () => {
    expect(depseudonymizeForShell("cd <path#1>", map)).toBe("cd ~/work/project");
    expect(depseudonymizeForShell("printf '%s' <arg#1>", map)).toBe('printf \'%s\' "a b\\\\c\\"\\$HOME\\`date\\`"');
    expect(depseudonymizeForShell("echo <arg#2>", { "<arg#2>": { type: "arg", value: "" } })).toBe('echo ""');
    expect(depseudonymizeForShell("echo <host#1>", { "<host#1>": { type: "host", value: "user@box:22" } })).toBe("echo user@box:22");
    expect(depseudonymizeForShell("echo <arg#2>", { "<arg#2>": { type: "arg", value: "; touch /tmp/not-executed" } })).toBe('echo "; touch /tmp/not-executed"');
  });

  test.skipIf(!findShellBinary("bash"))("quoted and unquoted placeholders recover literal arguments without executing injected printf", () => withTempHome(() => {
    const bash = findShellBinary("bash")!;
    const values = [
      "/tmp/ghop-nonexistent;printf GHOP_INJECTED;#",
      'a b\'";printf GHOP_INJECTED;#$(printf GHOP_SUBSTITUTED)`printf GHOP_BACKTICK`\\tail',
    ];
    for (const value of values) for (const placeholder of ["<path#1>", '"<path#1>"', "'<path#1>'"]) {
      const fixture: PseudonymMap = { "<path#1>": { type: "path", value } };
      const command = depseudonymizeForShell(`capture ${placeholder}`, fixture);
      const result = Bun.spawnSync([bash, "--noprofile", "--norc", "-c", `capture() { printf 'ARG:%s\\n' "$@"; }\n${command}`], { env: process.env });
      expect(result.exitCode).toBe(0);
      expect(new TextDecoder().decode(result.stdout)).toBe(`ARG:${value}\n`);
      expect(new TextDecoder().decode(result.stderr)).toBe("");
      const cd = depseudonymizeForShell(`cd ${placeholder}`, fixture);
      const cdResult = Bun.spawnSync([bash, "--noprofile", "--norc", "-c", cd], { env: process.env });
      expect(cdResult.exitCode).not.toBe(0);
      expect(new TextDecoder().decode(cdResult.stdout)).toBe("");
    }
  }));

  test("refuses concatenated, nested, escaped, comment and heredoc placeholder contexts", () => {
    for (const text of [
      'echo "prefix <path#1>"', "echo '<path#1>/suffix'", "echo prefix<path#1>", "echo <path#1>suffix",
      'echo "${x:-<path#1>}"', 'echo "$(printf <path#1>)"', "echo `printf <path#1>`",
      "echo $'<path#1>'", 'echo $"<path#1>"', "echo \\<path#1>", "# <path#1>",
      "cat <<END\n<path#1>\nEND", "alias proj='cd <path#1>'",
    ]) expect(() => depseudonymizeForShell(text, map)).toThrow("not automatable:");
    expect(depseudonymizeForShell('echo "<path#1>"', map)).toBe('echo "~/work/project"');
  });

  test.skipIf(!findShellBinary("powershell"))("PowerShell placeholders remain literal data in every supported quote context", () => {
    const value = "a'\";$(Write-Output INJECTED)`tail\\日本";
    const fixture: PseudonymMap = { "<arg#1>": { type: "arg", value } };
    for (const placeholder of ["<arg#1>", '"<arg#1>"', "'<arg#1>'"]) {
      const command = depseudonymizeForShell(`capture ${placeholder}`, fixture, "powershell");
      const content = [
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
        "function capture { ConvertTo-Json -Compress -InputObject @($args) }",
        command,
      ].join("\n");
      const result = Bun.spawnSync([findShellBinary("powershell")!, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(content, "utf16le").toString("base64")], { env: process.env });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual([value]);
    }
  });

  test("PowerShell refuses nested, concatenated, escaped and here-string placeholders", () => {
    for (const text of [
      'Write-Output "prefix <arg#1>"', "Write-Output '<arg#1>suffix'",
      "Write-Output $(Write-Output <arg#1>)", "Write-Output { <arg#1> }",
      "Write-Output `<arg#1>", "# <arg#1>", "Write-Output @'\n<arg#1>\n'@",
    ]) expect(() => depseudonymizeForShell(text, map, "powershell")).toThrow("not automatable:");
    expect(depseudonymizeForShell("Write-Output <path#1>", map, "powershell")).toBe("Write-Output '~/work/project'");
    expect(depseudonymizeForShell("Write-Output <arg#2>", { "<arg#2>": { type: "arg", value: "" } }, "powershell")).toBe("Write-Output ''");
  });

  test("refuses unresolved numbered and generic placeholders", () => {
    for (const placeholder of ["<path>", "<host#99>", "<subshell>", "<heredoc>", "<flag>"]) {
      expect(() => depseudonymizeForShell(`echo ${placeholder}`, map)).toThrow(GhopError);
      expect(() => depseudonymizeForShell(`echo ${placeholder}`, map)).toThrow(`not automatable: unresolved ${placeholder}`);
    }
    expect(() => depseudonymizeForShell("echo <arg#1>", { "<arg#1>": { type: "arg", value: "<path>" } })).toThrow("not automatable: unresolved <path>");
    const generic: PseudonymMap = { "<path>": { type: "path", value: "/not-a-numbered-id" } };
    expect(renderText("<path>", generic)).toBe(dim("<path>"));
    expect(() => depseudonymizeForShell("cd <path>", generic)).toThrow("not automatable: unresolved <path>");
  });

  test("loads and memoizes each analysis independently and returns empty for a deleted analysis", () => withTempHome(() => {
    saveMap("first", map);
    saveMap("second", { "<path#1>": { type: "path", value: "/other" } });
    const first = loadPseudonyms("first");
    expect(first).toEqual(map);
    expect(loadPseudonyms("first")).toBe(first);
    expect(loadPseudonyms("second")["<path#1>"]?.value).toBe("/other");
    expect(loadPseudonyms("missing")).toEqual({});
  }));

  test("the memo key includes the database path across temporary homes", () => {
    withTempHome(() => {
      saveMap("shared-id", { "<path#1>": { type: "path", value: "/first-home" } });
      expect(loadPseudonyms("shared-id")["<path#1>"]?.value).toBe("/first-home");
    });
    withTempHome(() => {
      saveMap("shared-id", { "<path#1>": { type: "path", value: "/second-home" } });
      expect(loadPseudonyms("shared-id")["<path#1>"]?.value).toBe("/second-home");
    });
  });

  test("rejects corrupt maps, invalid types, and mismatched identifiers", () => withTempHome(() => {
    for (const [id, value] of Object.entries({
      "invalid-type": { "<path#1>": { type: "password", value: "fixture" } },
      "invalid-value": { "<path#1>": { type: "path", value: 42 } },
      "mismatch": { "<path#1>": { type: "host", value: "fixture" } },
      "generic-key": { "<path>": { type: "path", value: "fixture" } },
    })) {
      saveMap(id, value);
      expect(() => loadPseudonyms(id)).toThrow();
    }
  }));

  test("strips ANSI, OSC, carriage returns and other terminal controls before styling", () => {
    const dangerous = "before\x1b[2J\x1b]52;c;clipboard\x07after\r\b\x00\x9b";
    const rendered = renderText("\x1b[31m<path#1>\x1b[0m", { "<path#1>": { type: "path", value: dangerous } });
    expect(rendered).toBe(sprout("beforeafter"));
    expect(stripTerminalControls("a\nb\tc\r\bd")).toBe("a\nb\tcd");
  });
});
