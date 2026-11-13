import { describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { automationStatus, previewAction, applyAction, type AutomationContext } from "../../src/apply/actions.ts";
import { findShellBinary, syntaxCheck } from "../../src/apply/shells.ts";
import { setConfigValue } from "../../src/core/config.ts";
import { writeTextAtomic } from "../../src/core/fsx.ts";
import { managedFile, reloadFile, toShellPath } from "../../src/core/paths.ts";
import type { Action } from "../../src/llm/schema.ts";
import { getRec, insertRecs, updateRec, type StoredRecommendation } from "../../src/recs/store.ts";
import { runUndo } from "../../src/commands/undo.ts";
import { withTempHome } from "../helpers/env.ts";
import { renderInit } from "../../src/shell/init.ts";

function recommendation(action: Action | null = { type: "alias", name: "gs", command: "git status" }): StoredRecommendation {
  return {
    id: 12, topic: "alias:git status", key: "alias-git-status", actionKey: "alias:gs", analysisId: "apply-fixture",
    createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z", evidence: [],
    status: "new", seenAt: null, acceptMode: null, discardReason: null, category: "alias", title: "Use an alias",
    summary: "Shorten git status", rationale: "It repeats", steps: [], impact: "medium", effort: "low",
    tool: null, action, shell: "bash", applied: null,
  };
}

function context(): AutomationContext {
  return {
    shell: "bash", map: {},
    env: {
      shell: "bash", shellVersion: "5.2", platform: process.platform === "win32" ? "windows-gitbash" : "linux",
      keymap: "emacs", frameworks: [], packageManagers: ["npm", "winget", "brew"], installedTools: [],
      history: { entries: 0, timestamps: false, sizeLimit: null, fileLimit: null, ignoreSpace: null, ignoreDups: null, appendIncremental: null, shared: null },
      options: {},
    },
  };
}

function install(manager: "winget" | "npm" | "brew", initLines: string[] = []): StoredRecommendation {
  const ids = { winget: "Example.Tool", npm: "@example/tool", brew: "example-tool" };
  return {
    ...recommendation({ type: "install", manager, id: ids[manager], initLines }), category: "tool",
    tool: {
      name: "Example", githubRepo: "example/tool", wingetId: ids.winget, npmPackage: ids.npm, brewFormula: ids.brew,
      verification: { status: "verified", license: "MIT", checkedAt: "2026-11-12T00:00:00.000Z", checks: { github: "verified", winget: "verified", npm: "verified", brew: "verified" } },
    },
  };
}

const bash = findShellBinary("bash");
const powershell = findShellBinary("powershell");

function powerShellResult(script: string, binary = powershell!) {
  const content = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n" + script;
  return Bun.spawnSync([binary, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(content, "utf16le").toString("base64")], { env: process.env });
}

describe("automatic action safety", () => {
  test("honors disabled automation, missing actions, and unresolved placeholders", () => withTempHome(() => {
    expect(automationStatus(recommendation(null), context())).toEqual({ ok: false, reason: "This recommendation has no automatic change." });
    for (const placeholder of ["<path>", "<path#99>"]) {
      const rec = recommendation({ type: "alias", name: "proj", command: `cd ${placeholder}` });
      expect(automationStatus(rec, context())).toEqual({ ok: false, reason: `not automatable: unresolved ${placeholder}` });
      expect(() => previewAction(rec, context())).toThrow(`not automatable: unresolved ${placeholder}`);
    }
    setConfigValue("automation.enabled", "false");
    expect(automationStatus(recommendation(), context())).toEqual({ ok: false, reason: "Automation is disabled (automation.enabled=false)." });
  }));

  test("refuses placeholders inside quotes spanning snippet or install lines before writing", () => withTempHome(() => {
    const ctx = context();
    ctx.map["<path#1>"] = { type: "path", value: "';printf GHOP_INJECTED;#" };
    const lines = ["value='", "<path#1>", "'"];
    for (const rec of [recommendation({ type: "snippet", description: "quoted", lines }), install("npm", lines)]) {
      expect(automationStatus(rec, ctx).ok).toBe(false);
      expect(() => previewAction(rec, ctx)).toThrow("placeholder must be a complete");
      expect(existsSync(managedFile("bash"))).toBe(false);
      expect(existsSync(reloadFile("bash"))).toBe(false);
    }
  }));

  test("requires the authored shell for snippets and install initialization only", () => withTempHome(() => {
    const ctx = { ...context(), shell: "zsh" as const };
    expect(automationStatus(recommendation(), ctx)).toEqual({ ok: true });
    expect(automationStatus(recommendation({ type: "snippet", description: "option", lines: ["shopt -s autocd"] }), ctx))
      .toEqual({ ok: false, reason: "Written for bash; open bash to apply it automatically." });
    expect(automationStatus(install("npm", ["export EDITOR=vim"]), ctx).ok).toBe(false);
    const which = spyOn(Bun, "which").mockReturnValue("/fixture/npm");
    try { expect(automationStatus(install("npm"), ctx)).toEqual({ ok: true }); } finally { which.mockRestore(); }
  }));

  test("refuses every specified risky construct, including resolved pseudonyms", () => withTempHome(() => {
    const risky = [
      "rm -rf old", "sudo apt install fzf", "curl x | sh", "wget x | bash", "mkfs /dev/test", "dd if=image of=disk",
      ":() { :|:& };:", "chmod 777 file", "chmod -R 777 dir", "echo x > /dev/sda", 'eval "$(curl x)"', "git push origin main --force",
    ];
    for (const line of risky) {
      const rec = recommendation({ type: "snippet", description: "unsafe", lines: [line] });
      expect(automationStatus(rec, context())).toEqual({ ok: false, reason: "Contains a risky construct; review and apply it yourself." });
      expect(() => previewAction(rec, context())).toThrow("Contains a risky construct");
    }
    const ctx = context();
    ctx.map["<cmd#1>"] = { type: "cmd", value: "sudo" };
    expect(automationStatus(recommendation({ type: "alias", name: "bad", command: "<cmd#1> ls" }), ctx).ok).toBe(false);
    expect(automationStatus(recommendation({ type: "alias", name: "pushsafe", command: "git push --force-with-lease" }), context())).toEqual({ ok: true });
  }));

  test("rejects reserved alias names and warns on existing aliases and executables", () => withTempHome(() => {
    for (const name of ["if", "then", "case", "function", "cd", "alias", "source", "exit", "eval", "command"]) {
      expect(automationStatus(recommendation({ type: "alias", name, command: "git status" }), context()).ok).toBe(false);
      expect(() => previewAction(recommendation({ type: "alias", name, command: "git status" }), context())).toThrow("is reserved");
    }
    const which = spyOn(Bun, "which").mockImplementation((name) => name === "gs" ? "/fixture/gs" : null);
    try {
      const preview = previewAction(recommendation(), { ...context(), aliases: [{ name: "gs", expansion: "git show" }] });
      expect(preview.warnings).toContain("overrides existing alias gs");
      expect(preview.warnings).toContain("shadows command /fixture/gs");
    } finally { which.mockRestore(); }
  }));

  test("constructs fixed verified argv for each manager", () => withTempHome(() => {
    const which = spyOn(Bun, "which").mockReturnValue("/fixture/binary");
    try {
      expect(previewAction(install("npm"), context()).argv).toEqual(["npm", "install", "--global", "@example/tool"]);
      expect(previewAction(install("brew"), context()).argv).toEqual(["brew", "install", "example-tool"]);
      if (process.platform === "win32") {
        expect(previewAction(install("winget"), context()).argv).toEqual(["winget", "install", "--id", "Example.Tool", "--exact", "--source", "winget"]);
      } else expect(automationStatus(install("winget"), context())).toEqual({ ok: false, reason: "winget automatic installation requires Windows." });
    } finally { which.mockRestore(); }
  }));

  test("refuses unverified, mismatched, malformed, and missing install identifiers", () => withTempHome(() => {
    const which = spyOn(Bun, "which").mockReturnValue("/fixture/binary");
    try {
      const unverified = install("npm");
      unverified.tool!.verification.checks.npm = "unknown";
      expect(automationStatus(unverified, context()).ok).toBe(false);
      const brew = install("brew");
      brew.tool!.verification.checks.github = "rejected";
      expect(automationStatus(brew, context()).ok).toBe(false);
      const mismatch = install("npm");
      mismatch.action = { type: "install", manager: "npm", id: "other-tool", initLines: [] };
      expect(() => previewAction(mismatch, context())).toThrow("does not match");
      for (const id of ["--ignore-scripts", "tool;touch marker", "tool\nother", "https://private.invalid/tool"]) {
        const malformed = install("npm");
        malformed.action = { type: "install", manager: "npm", id, initLines: [] };
        malformed.tool!.npmPackage = id;
        expect(automationStatus(malformed, context()).ok).toBe(false);
      }
      const missing = install("npm");
      missing.tool = null;
      expect(automationStatus(missing, context()).ok).toBe(false);
    } finally { which.mockRestore(); }
    const missingManager = spyOn(Bun, "which").mockReturnValue(null);
    try { expect(automationStatus(install("npm"), context())).toEqual({ ok: false, reason: "npm is not installed or not on PATH." }); }
    finally { missingManager.mockRestore(); }
  }));

  test("reports skipped shell syntax checks without writing files", () => withTempHome(() => {
    const which = spyOn(Bun, "which").mockReturnValue(null);
    try {
      const preview = previewAction(recommendation(), { ...context(), shell: "zsh" });
      expect(preview.warnings).toContain("(syntax check skipped: zsh not found)");
      expect(existsSync(managedFile("zsh"))).toBe(false);
    } finally { which.mockRestore(); }
  }));

  test("prevents aliases crossing the PowerShell boundary and rejects native risky equivalents", () => withTempHome(() => {
    const ctx = { ...context(), shell: "powershell" as const };
    expect(automationStatus(recommendation(), ctx).ok).toBe(false);
    const native = { ...recommendation(), shell: "powershell" as const };
    expect(automationStatus(native, context()).ok).toBe(false);
    for (const line of [
      "Remove-Item -Recurse -Force old", "ri old -r", "irm https://example.invalid | iex",
      "Invoke-WebRequest https://example.invalid | powershell", "Start-Process pwsh -Verb RunAs", "Format-Volume D",
    ]) {
      const rec = { ...native, action: { type: "snippet" as const, description: "unsafe", lines: [line] } };
      expect(automationStatus(rec, ctx).ok).toBe(false);
    }
  }));
});

describe("applying approved actions", () => {
  test.skipIf(!bash)("quotes aliases, syntax-checks, preserves the exact command, and writes reload metadata", () => withTempHome(async () => {
    const command = "printf '%s\\n' \"$HOME\" 'a b'";
    const rec = recommendation({ type: "alias", name: "quoted", command });
    const preview = previewAction(rec, context());
    expect(syntaxCheck("bash", preview.lines.join("\n")).ok).toBe(true);
    const spawn = spyOn(Bun, "spawn");
    try {
      const applied = await applyAction(rec, preview, "bash");
      expect(applied).toMatchObject({ kind: "managed", shell: "bash", aliasNames: ["quoted"], functionNames: [] });
      expect(Number.isNaN(Date.parse(applied.at))).toBe(false);
      expect(spawn).not.toHaveBeenCalled();
    } finally { spawn.mockRestore(); }
    const result = Bun.spawnSync([bash!, "--noprofile", "--norc", "-c", 'source "$1"; printf "%s" "${BASH_ALIASES[quoted]}"', "fixture", toShellPath(managedFile("bash"), "bash")], { env: process.env });
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toBe(command);
    expect(readFileSync(reloadFile("bash"), "utf8")).toContain("source '");
  }));

  test.skipIf(!bash)("applied alias preserves a quoted placeholder as data when invoked", () => withTempHome(async () => {
    const value = "/tmp/ghop-nonexistent;printf GHOP_INJECTED;#";
    const ctx = context();
    ctx.map["<path#1>"] = { type: "path", value };
    const rec = recommendation({ type: "alias", name: "ghop_capture", command: 'capture "<path#1>"' });
    await applyAction(rec, previewAction(rec, ctx), "bash");
    const result = Bun.spawnSync([bash!, "--noprofile", "--norc", "-c", [
      "shopt -s expand_aliases",
      "capture() { printf 'ARG:%s\\n' \"$@\"; }",
      'source "$1"',
      "ghop_capture",
    ].join("\n"), "fixture", toShellPath(managedFile("bash"), "bash")], { env: process.env });
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toBe(`ARG:${value}\n`);
    expect(new TextDecoder().decode(result.stderr)).toBe("");
  }));

  test.skipIf(!bash)("records function names and never executes snippet content", () => withTempHome(async () => {
    const rec = recommendation({ type: "snippet", description: "functions", lines: ["one() { git status; }", "function two() { git log; }", "one() { git diff; }", "function three { git status; }", "alias first='git status' second='git log'; alias third='git diff'"] });
    const spawn = spyOn(Bun, "spawn");
    try {
      expect(await applyAction(rec, previewAction(rec, context()), "bash")).toMatchObject({ kind: "managed", aliasNames: ["first", "second", "third"], functionNames: ["one", "two", "three"] });
      expect(spawn).not.toHaveBeenCalled();
    } finally { spawn.mockRestore(); }
  }));

  test.skipIf(!bash)("failed syntax leaves managed and reload files unchanged", () => withTempHome(async () => {
    writeTextAtomic(managedFile("bash"), "# foreign content\nalias old='git status'\n");
    writeTextAtomic(reloadFile("bash"), "# previous reload\n");
    const rec = recommendation({ type: "snippet", description: "invalid", lines: ["if then"] });
    await expect(applyAction(rec, previewAction(rec, context()), "bash")).rejects.toThrow("Syntax check failed:");
    expect(readFileSync(managedFile("bash"), "utf8")).toBe("# foreign content\nalias old='git status'\n");
    expect(readFileSync(reloadFile("bash"), "utf8")).toBe("# previous reload\n");
  }));

  test("executes only verified install argv with inherited environment and stdio", () => withTempHome(async () => {
    const which = spyOn(Bun, "which").mockReturnValue("/fixture/binary");
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({ exited: Promise.resolve(0) }) as Bun.Subprocess);
    try {
      const rec = install("npm");
      const applied = await applyAction(rec, previewAction(rec, context()), "bash");
      expect(applied).toMatchObject({ kind: "install", shell: "bash", argv: ["npm", "install", "--global", "@example/tool"], manager: "npm", id: "@example/tool", initBlock: false, aliasNames: [], functionNames: [] });
      expect(spawn).toHaveBeenCalledWith({ cmd: ["npm", "install", "--global", "@example/tool"], stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });
      expect(existsSync(managedFile("bash"))).toBe(false);
      const tampered = previewAction(rec, context());
      tampered.argv = ["sh", "-c", "echo never"];
      await expect(applyAction(rec, tampered, "bash")).rejects.toThrow("preview no longer matches");
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally { spawn.mockRestore(); which.mockRestore(); }
  }));

  test.skipIf(!bash)("rejects invalid install initialization before spawning the manager", () => withTempHome(async () => {
    const originalWhich = Bun.which.bind(Bun);
    const which = spyOn(Bun, "which").mockImplementation((name) => name === "npm" ? "/fixture/npm" : originalWhich(name));
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({ exited: Promise.resolve(0) }) as Bun.Subprocess);
    try {
      const rec = install("npm", ["if then"]);
      await expect(applyAction(rec, previewAction(rec, context()), "bash")).rejects.toThrow("Syntax check failed:");
      expect(spawn).not.toHaveBeenCalled();
      expect(existsSync(managedFile("bash"))).toBe(false);
      expect(existsSync(reloadFile("bash"))).toBe(false);
    } finally { spawn.mockRestore(); which.mockRestore(); }
  }));

  test.skipIf(!bash)("writes install initialization only on success and retains no block after failed install", () => withTempHome(async () => {
    const originalWhich = Bun.which.bind(Bun);
    const which = spyOn(Bun, "which").mockImplementation((name) => name === "npm" ? "/fixture/npm" : originalWhich(name));
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({ exited: Promise.resolve(9) }) as Bun.Subprocess);
    try {
      const rec = install("npm", ["export EDITOR=vim"]);
      const preview = previewAction(rec, context());
      await expect(applyAction(rec, preview, "bash")).rejects.toThrow("npm exited with 9");
      expect(existsSync(managedFile("bash"))).toBe(false);
      expect(existsSync(reloadFile("bash"))).toBe(false);
      spawn.mockImplementation(() => ({ exited: Promise.resolve(0) }) as Bun.Subprocess);
      expect(await applyAction(rec, preview, "bash")).toMatchObject({ kind: "install", initBlock: true });
      expect(readFileSync(managedFile("bash"), "utf8")).toContain("export EDITOR=vim");
      expect(existsSync(reloadFile("bash"))).toBe(true);
    } finally { spawn.mockRestore(); which.mockRestore(); }
  }));

  test.skipIf(!bash)("undo removes snippet and install initialization names from the active shell and preserves foreign content", () => withTempHome(async () => {
    const lines = [
      "alias ghop_first='printf first' ghop_second='printf second'",
      "ghop_one() { printf one; }",
      "function ghop_two() { printf two; }",
      "function ghop_three { printf three; }",
    ];
    const foreign = "# foreign content\nalias foreign_alias='printf foreign'\nforeign_function() { :; }\n";
    const originalWhich = Bun.which.bind(Bun);
    const which = spyOn(Bun, "which").mockImplementation((name) => name === "npm" ? "/fixture/npm" : originalWhich(name));
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({ exited: Promise.resolve(0) }) as Bun.Subprocess);
    const output = spyOn(console, "log").mockImplementation(() => {});
    try {
      for (const kind of ["snippet", "install"] as const) {
        writeTextAtomic(managedFile("bash"), foreign);
        const fixture = kind === "snippet"
          ? recommendation({ type: "snippet", description: "shell helpers", lines })
          : install("npm", lines);
        const { id: _id, ...input } = fixture;
        const rec = insertRecs([{ ...input, topic: `undo:${kind}` }])[0]!;
        const applied = await applyAction(rec, previewAction(rec, context()), "bash");
        expect(applied).toMatchObject({ aliasNames: ["ghop_first", "ghop_second"], functionNames: ["ghop_one", "ghop_two", "ghop_three"] });
        updateRec(rec.id, { applied, status: "implemented", acceptMode: "auto" });
        const beforeUndo = readFileSync(managedFile("bash"), "utf8");
        await runUndo(rec.id, { yes: true });
        const afterUndo = readFileSync(managedFile("bash"), "utf8");
        expect(afterUndo).toContain(foreign);
        expect(afterUndo).not.toContain(`# >>> ghop #${rec.id}`);
        const cleanup = readFileSync(reloadFile("bash"), "utf8");
        const result = Bun.spawnSync([bash!, "--noprofile", "--norc", "-c", [
          beforeUndo,
          "alias ghop_first >/dev/null && alias ghop_second >/dev/null || exit 10",
          "declare -F ghop_one >/dev/null && declare -F ghop_two >/dev/null && declare -F ghop_three >/dev/null || exit 11",
          cleanup,
          "alias ghop_first >/dev/null 2>&1 && exit 20",
          "alias ghop_second >/dev/null 2>&1 && exit 21",
          "declare -F ghop_one >/dev/null && exit 22",
          "declare -F ghop_two >/dev/null && exit 23",
          "declare -F ghop_three >/dev/null && exit 24",
          "alias foreign_alias >/dev/null && declare -F foreign_function >/dev/null",
        ].join("\n")], { env: process.env });
        expect(result.exitCode).toBe(0);
        expect(getRec(rec.id)).toMatchObject({ status: "accepted", acceptMode: "self", applied: null });
      }
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally { output.mockRestore(); spawn.mockRestore(); which.mockRestore(); }
  }));

  test.skipIf(!powershell)("PowerShell forwarding aliases retain literal fixed and caller arguments across reload and undo", () => withTempHome(async () => {
    process.env.GRASSHOPPER_HOME += "/quoted ' 日本 root";
    const value = "日本 a'\";$([Console]::Write('INJECTED'))`tail";
    const ctx = {
      ...context(), shell: "powershell" as const,
      map: {
        "<cmd#1>": { type: "cmd" as const, value: "capture" },
        "<arg#1>": { type: "arg" as const, value },
      },
    };
    const { id: _id, ...input } = recommendation({ type: "alias", name: "ghop_capture", command: '"<cmd#1>" <arg#1>' });
    const rec = insertRecs([{ ...input, shell: "powershell" }])[0]!;
    const preview = previewAction(rec, ctx);
    expect(preview.lines.join("\n")).toContain("@args");
    const applied = await applyAction(rec, preview, "powershell");
    expect(applied).toMatchObject({ aliasNames: [], functionNames: ["ghop_capture"] });
    updateRec(rec.id, { applied, status: "implemented", acceptMode: "auto" });
    const beforeUndo = readFileSync(managedFile("powershell"), "utf8").replace(/^\uFEFF/, "");
    const reload = readFileSync(reloadFile("powershell"), "utf8").replace(/^\uFEFF/, "");
    for (const binary of new Set([powershell, Bun.which("pwsh"), Bun.which("powershell")].filter((item): item is string => !!item))) {
      const result = powerShellResult([
        "function capture { ConvertTo-Json -Compress -InputObject @($args) }",
        "Set-Alias ghop_capture Write-Output",
        `function Invoke-GhopReload { ${reload} }\nInvoke-GhopReload`,
        "ghop_capture 'caller literal'",
      ].join("\n"), binary);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual([value, "caller literal"]);
    }
    const output = spyOn(console, "log").mockImplementation(() => {});
    try { await runUndo(rec.id, { yes: true }); } finally { output.mockRestore(); }
    const cleanup = readFileSync(reloadFile("powershell"), "utf8").replace(/^\uFEFF/, "");
    const result = powerShellResult([
      beforeUndo,
      "if (!(Test-Path Function:ghop_capture)) { exit 10 }",
      `function Invoke-GhopReload { ${cleanup} }\nInvoke-GhopReload`,
      "if (Test-Path Function:ghop_capture) { exit 11 }",
    ].join("\n"));
    expect(result.exitCode).toBe(0);
    expect(getRec(rec.id).applied).toBeNull();
  }));

  test.skipIf(!powershell)("PowerShell rejects invalid syntax before write and tracks static snippet definitions for undo", () => withTempHome(async () => {
    const ctx = { ...context(), shell: "powershell" as const };
    const invalid = { ...recommendation({ type: "snippet", description: "invalid", lines: ["function broken {"] }), shell: "powershell" as const };
    await expect(applyAction(invalid, previewAction(invalid, ctx), "powershell")).rejects.toThrow("Syntax check failed:");
    expect(existsSync(managedFile("powershell"))).toBe(false);
    expect(existsSync(reloadFile("powershell"))).toBe(false);
    const lines = [
      "function ghop_one { 'one' }",
      "Set-Alias -Name 'ghop_first' -Value ghop_one",
      "New-Alias -Scope Global ghop_second ghop_one",
      "Write-Output 'function fake { }; Set-Alias fake ghop_one'",
    ];
    const { id: _id, ...input } = recommendation({ type: "snippet", description: "helpers", lines });
    const rec = insertRecs([{ ...input, shell: "powershell" }])[0]!;
    const applied = await applyAction(rec, previewAction(rec, ctx), "powershell");
    expect(applied).toMatchObject({ aliasNames: ["ghop_first", "ghop_second"], functionNames: ["ghop_one"] });
    updateRec(rec.id, { applied, status: "implemented", acceptMode: "auto" });
    const beforeUndo = readFileSync(managedFile("powershell"), "utf8").replace(/^\uFEFF/, "");
    const reload = readFileSync(reloadFile("powershell"), "utf8").replace(/^\uFEFF/, "");
    const loaded = powerShellResult([
      `function Invoke-GhopReload { ${reload} }\nInvoke-GhopReload`,
      "if (!(Test-Path Alias:ghop_first) -or !(Test-Path Alias:ghop_second) -or !(Test-Path Function:ghop_one)) { exit 12 }",
    ].join("\n"));
    expect(loaded.exitCode).toBe(0);
    const output = spyOn(console, "log").mockImplementation(() => {});
    try { await runUndo(rec.id, { yes: true }); } finally { output.mockRestore(); }
    const cleanup = readFileSync(reloadFile("powershell"), "utf8").replace(/^\uFEFF/, "");
    const result = powerShellResult([
      beforeUndo,
      "if (!(Test-Path Alias:ghop_first) -or !(Test-Path Alias:ghop_second)) { exit 10 }",
      `function Invoke-GhopReload { ${cleanup} }\nInvoke-GhopReload`,
      "if ((Test-Path Alias:ghop_first) -or (Test-Path Alias:ghop_second) -or (Test-Path Function:ghop_one)) { exit 11 }",
    ].join("\n"));
    expect(result.exitCode).toBe(0);
  }));
});

describe("accepted alias reminders", () => {
  const runtimes = [
    { shell: "bash" as const, name: "bash", binary: bash },
    { shell: "zsh" as const, name: "zsh", binary: findShellBinary("zsh") },
    ...["pwsh", "powershell"].map(name => ({ shell: "powershell" as const, name, binary: Bun.which(name) })),
  ];
  for (const { shell, name, binary } of runtimes) {
    test.skipIf(!binary)(`${name} nudges once for literal long forms, retains status, and clears on undo`, () => withTempHome(async home => {
      const root = process.env.GRASSHOPPER_HOME!;
      const ctx = { ...context(), shell };
      const recs: StoredRecommendation[] = [];
      const commands = ["echo 'a b'", "echo 'a b' detail"];
      for (const [index, command] of commands.entries()) {
        const { id: _id, ...input } = recommendation({ type: "alias", name: `short${index}`, command });
        const rec = insertRecs([{ ...input, shell, topic: `nudge:${index}` }])[0]!;
        const applied = await applyAction(rec, previewAction(rec, ctx), shell);
        updateRec(rec.id, { applied, status: "implemented", acceptMode: "auto" });
        recs.push(rec);
      }
      const extension = shell === "powershell" ? ".ps1" : ".sh";
      const initial = join(root, "before-undo" + extension);
      writeFileSync(initial, readFileSync(managedFile(shell)));
      const cleanup: string[] = [];
      const output = spyOn(console, "log").mockImplementation(() => {});
      try {
        for (const rec of recs) {
          await runUndo(rec.id, { yes: true });
          cleanup.push(readFileSync(reloadFile(shell), "utf8").replace(/^\uFEFF/, ""));
        }
      } finally { output.mockRestore(); }
      const undo = join(root, "undo" + extension);
      writeFileSync(undo, (shell === "powershell" ? "\uFEFF" : "") + cleanup.join("\n"));
      const init = join(root, "init" + extension);
      writeFileSync(init, (shell === "powershell" ? "\uFEFF" : "") + renderInit(shell, toShellPath(root, shell)));
      const quote = (value: string) => `'${toShellPath(value, shell).replaceAll("'", shell === "powershell" ? "''" : "'\\''")}'`;
      let result: Bun.SyncSubprocess<"pipe", "pipe">;
      if (shell === "powershell") {
        const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Import-Module PSReadLine
Set-PSReadLineOption -HistorySavePath ${quote(join(home, "history"))}
function global:prompt { 'original> ' }
. ${quote(init)}
. ${quote(initial)}
$global:__ghop_started = $true
$global:__ghop_command = $null
function Invoke-CapturedLine([string]$Line) {
  $null = (Get-PSReadLineOption).AddToHistoryHandler.Invoke($Line)
  $pipeline = [Management.Automation.PowerShell]::Create([Management.Automation.RunspaceMode]::CurrentRunspace)
  $null = $pipeline.AddScript($Line)
  $settings = [Management.Automation.PSInvocationSettings]::new()
  $settings.AddToHistory = $true
  $null = $pipeline.Invoke($null, $settings)
  $pipeline.Dispose()
  if ((prompt) -ne 'original> ') { throw 'prompt changed' }
  $null = prompt
}
Invoke-CapturedLine ${quote(commands[0]!)}
Invoke-CapturedLine ${quote(commands[0] + " tail")}
Invoke-CapturedLine ${quote(commands[1]!)}
Invoke-CapturedLine 'short0'
Invoke-CapturedLine ${quote("echo 'a b'x")}
$global:LASTEXITCODE = 23
$null = prompt
Write-Host "status:$global:LASTEXITCODE"
. ${quote(undo)}
Invoke-CapturedLine ${quote(commands[0]!)}
# With PATH empty, a literal lookup must still work without executing its data.
$env:PATH = ''
$global:__ghop_nudges = @('echo $(throw "executed") *', 'literal')
__ghop_nudge 'echo $(throw "executed") *'
__ghop_nudge 'echo not-a-match'
exit 0
`;
        result = Bun.spawnSync([binary!, "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", script], {
          env: { ...process.env, CI: "", GHOP_DISABLE: "", TERM: "xterm" },
          stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000,
        });
        expect(new TextDecoder().decode(result.stderr)).toBe("");
      } else {
        const bin = join(root, "bin");
        mkdirSync(bin);
        writeFileSync(join(bin, "ghop"), "#!/bin/sh\nexit 0\n");
        chmodSync(join(bin, "ghop"), 0o700);
        const script = [
          `export PATH=${quote(bin)}:$PATH; HISTFILE=${quote(join(home, "history"))}; HISTSIZE=1000; source ${quote(init)}; source ${quote(initial)}; __ghop_started=1`,
          commands[0]!,
          commands[0] + " tail",
          commands[1]!,
          "short0",
          "echo 'a b'x",
          "false",
          "printf 'status:%s\\n' \"$?\"",
          `source ${quote(undo)}`,
          commands[0]!,
          "PATH=; __ghop_nudges=('echo $(printf executed) *' 'literal'); __ghop_nudge 'echo $(printf executed) *'; __ghop_nudge 'echo not-a-match'",
          "exit 0", "",
        ].join("\n");
        result = Bun.spawnSync([binary!, ...(shell === "bash" ? ["--noprofile", "--norc"] : ["-f"]), "-i"], {
          env: { ...process.env, CI: "", GHOP_DISABLE: "", TERM: "xterm", PS1: "", PS2: "" },
          stdin: Buffer.from(script), stdout: "pipe", stderr: "pipe", timeout: 20000,
        });
      }
      expect(result.exitCode).toBe(0);
      const stdout = new TextDecoder().decode(result.stdout);
      const stderr = new TextDecoder().decode(result.stderr);
      const reminders = (shell === "powershell" ? stdout : stderr).match(/^ghop: use .*$/gm);
      expect(reminders).toEqual([
        "ghop: use short0 instead of echo 'a b'",
        "ghop: use short0 instead of echo 'a b'",
        "ghop: use short1 instead of echo 'a b' detail",
        shell === "powershell" ? 'ghop: use literal instead of echo $(throw "executed") *' : "ghop: use literal instead of echo $(printf executed) *",
      ]);
      expect(stdout).toContain(shell === "powershell" ? "status:23" : "status:1");
    }), 30000);
  }
});
