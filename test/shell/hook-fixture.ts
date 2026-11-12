import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findShellBinary } from "../../src/apply/shells.ts";
import { toShellPath } from "../../src/core/paths.ts";
import type { Shell } from "../../src/history/source.ts";
import { renderInit } from "../../src/shell/init.ts";
import { parseCapture } from "../../src/history/telemetry.ts";
import { withTempHome } from "../helpers/env.ts";

export function registerHookTests(shell: Shell): void {
  const binary = findShellBinary(shell);
  describe(`${shell} real shell hooks`, () => {
    const runTest = binary ? test : test.skip;
    runTest("syntax, daily capture, notifications, wrapper reload and quoted roots", () => withTempHome((home) => {
      const root = join(process.env.GRASSHOPPER_HOME!, "young grasshopper's root");
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      mkdirSync(join(root, "managed"));
      const quote = (path: string) => `'${toShellPath(path, shell).replaceAll("'", "'\\''")}'`;
      const init = join(root, `init.${shell}`);
      writeFileSync(init, renderInit(shell, toShellPath(root, shell)));
      writeFileSync(join(root, "managed", `${shell}.sh`), "export GHOP_MANAGED_LOADED=yes\n");
      const fake = join(bin, "ghop");
      writeFileSync(fake, [
        "#!/bin/sh",
        `root=${quote(root)}`,
        'printf "%s\\n" "$*" >> "$root/calls.log"',
        'case "$1" in',
        '  daily) date +%Y-%m-%d > "$root/daily.stamp" ;;',
        '  notify) [ "${GHOP_FAIL_NOTIFY-}" = 1 ] && exit 9; rm -f "$root/fresh.flag" ;;',
        '  fail) [ "$#" -eq 2 ] && [ "$2" = "two words" ] || exit 8; exit 7 ;;',
        "esac",
        "exit 0",
        "",
      ].join("\n"));
      chmodSync(fake, 0o700);
      const args = shell === "bash" ? ["--noprofile", "--norc"] : ["-f"];
      const syntax = Bun.spawnSync([binary!, ...args, "-n", toShellPath(init, shell)], { env: process.env, stdout: "pipe", stderr: "pipe" });
      expect(new TextDecoder().decode(syntax.stderr)).toBe("");
      expect(syntax.exitCode).toBe(0);
      const run = (body: string, interactive = true, extra: Record<string, string> = {}) => {
        const script = `export HOME=${quote(home)}; export PATH=${quote(bin)}:$PATH; ${body}`;
        const result = Bun.spawnSync([binary!, ...args, ...(interactive ? ["-i"] : []), "-c", script], {
          stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000,
          env: { ...process.env, TERM: "xterm-256color", CI: "", GHOP_DISABLE: "", GHOP_TEST: "1", GHOP_FAIL_NOTIFY: "", ...extra },
        });
        expect(result.exitCode).toBe(0);
        return new TextDecoder().decode(result.stdout);
      };
      const calls = () => readFileSync(join(root, "calls.log"), "utf8").trim().split("\n");
      const promptSetup = shell === "bash" ? "PROMPT_COMMAND='echo prior';" : "prior() { :; }; precmd_functions=(prior);";
      const promptCheck = shell === "bash"
        ? 'printf "hooks=%s\\n" "$PROMPT_COMMAND"'
        : 'print -r -- "hooks=${(j:,:)precmd_functions}"';
      const first = run(`${promptSetup} source ${quote(init)}; source ${quote(init)}; alias zqx='echo hi'; zqfunc() { :; }; HISTFILE=${quote(join(home, "custom.history"))}; __ghop_precmd; __ghop_precmd; ${promptCheck}; printf 'managed=%s\\nhist=%s\\nroot=%s\\n' "$GHOP_MANAGED_LOADED" "$GHOP_HISTFILE" "$__ghop_home"`);
      expect(calls()).toEqual(["daily"]);
      expect(first).toContain("managed=yes");
      expect(first).toContain(`hist=${toShellPath(join(home, "custom.history"), shell)}`);
      expect(first).toContain(`root=${toShellPath(root, shell)}`);
      expect(first.match(/__ghop_precmd/g)?.length).toBe(1);
      expect(first.indexOf("prior")).toBeLessThan(first.indexOf("__ghop_precmd"));
      expect(readFileSync(join(root, "shell", `${shell}.aliases`), "utf8")).toContain("zqx=");
      expect(readFileSync(join(root, "shell", `${shell}.functions`), "utf8")).toContain("zqfunc");
      const info = readFileSync(join(root, "shell", `${shell}.info`), "utf8");
      expect(info).toContain("KEYMAP=");
      expect(info).toContain(shell === "bash" ? "BASH_VERSION=" : "ZSH_VERSION=");
      if (shell === "zsh") expect(info).toMatch(/OPTIONS=.+/);
      run(`source ${quote(init)}; __ghop_precmd`);
      expect(calls()).toEqual(["daily"]);
      writeFileSync(join(root, "daily.stamp"), "2000-01-01\n");
      run(`source ${quote(init)}; __ghop_precmd; __ghop_precmd`);
      expect(calls()).toEqual(["daily", "daily"]);
      writeFileSync(join(root, "fresh.flag"), "2");
      run(`source ${quote(init)}; __ghop_precmd; __ghop_precmd`);
      expect(calls()).toEqual(["daily", "daily", "notify"]);
      expect(existsSync(join(root, "fresh.flag"))).toBe(false);
      writeFileSync(join(root, "fresh.flag"), "2");
      run(`source ${quote(init)}; __ghop_precmd; __ghop_precmd`, true, { GHOP_FAIL_NOTIFY: "1" });
      expect(calls()).toEqual(["daily", "daily", "notify", "notify"]);
      expect(existsSync(join(root, "fresh.flag"))).toBe(false);
      writeFileSync(join(root, `reload.${shell}.sh`), "export GHOP_RELOADED=yes\n");
      const wrapper = run(`source ${quote(init)}; ghop fail 'two words'; printf 'wrapper=%s\\n' "$?"; printf 'reload=%s\\n' "$GHOP_RELOADED"`);
      expect(wrapper).toContain("wrapper=7");
      expect(wrapper).toContain("reload=yes");
      expect(calls().at(-1)).toBe("fail two words");
      expect(existsSync(join(root, `reload.${shell}.sh`))).toBe(false);
      const status = run(`source ${quote(init)}; false; __ghop_precmd; printf 'rc=%s\\n' "$?"`);
      expect(status).toContain("rc=1");
      const fallback = run(`source ${quote(init)}; unset HISTFILE; __ghop_precmd; printf 'shell=%s\\nhistory=%s\\n' "$GHOP_SHELL" "$GHOP_HISTFILE"`);
      expect(fallback).toContain(`shell=${shell}`);
      expect(fallback).toContain(`history=${toShellPath(join(home, shell === "bash" ? ".bash_history" : ".zsh_history"), shell)}`);
      for (const extra of [{ GHOP_DISABLE: "1" }, { CI: "1" }, { TERM: "dumb" }] as Record<string, string>[]) {
        expect(run(`source ${quote(init)}; command -v __ghop_precmd >/dev/null || printf disabled`, true, extra)).toContain("disabled");
      }
      expect(run(`source ${quote(init)}; command -v __ghop_precmd >/dev/null || printf noninteractive`, false)).toContain("noninteractive");
      // A missing executable must not create shell dumps or attempt daily work.
      const emptyRoot = join(root, "missing executable");
      mkdirSync(emptyRoot);
      const absentInit = join(emptyRoot, `init.${shell}`);
      writeFileSync(absentInit, renderInit(shell, toShellPath(emptyRoot, shell)));
      run(`source ${quote(absentInit)}; PATH=${quote(dirname(binary!))}; __ghop_precmd; :`);
      expect(existsSync(join(emptyRoot, "shell"))).toBe(false);
    }), 30000);

    runTest("records interactive command start, duration, failures and cwd without disturbing existing hooks", () => withTempHome(home => {
      const root = process.env.GRASSHOPPER_HOME!;
      const bin = join(root, "bin");
      const child = join(home, "child");
      mkdirSync(bin); mkdirSync(child);
      const quote = (value: string) => `'${toShellPath(value, shell).replaceAll("'", "'\\''")}'`;
      const init = join(root, `telemetry.${shell}`);
      writeFileSync(init, renderInit(shell, toShellPath(root, shell)));
      const fake = join(bin, "ghop");
      writeFileSync(fake, [
        "#!/bin/sh",
        `root=${quote(root)}`,
        'printf "%s\\n" "$*" >> "$root/argv.log"',
        'case "$1" in',
        '  record) cat >> "$root/records.bin" ;;',
        '  daily) date +%Y-%m-%d > "$root/daily.stamp" ;;',
        "esac",
      ].join("\n") + "\n");
      chmodSync(fake, 0o700);
      const prior = join(root, "prior.log"), debug = join(root, "debug.log");
      const setup = shell === "bash"
        ? `HISTCONTROL=ignorespace:ignoredups; prior() { printf "prior:%s\\n" "$?" >> ${quote(prior)}; }; PROMPT_COMMAND=prior; olddebug() { printf "debug:%s:%s\\n" "$1" "$2" >> ${quote(debug)}; }; trap 'olddebug "$?" "$BASH_COMMAND"' DEBUG`
        : `SAVEHIST=1000; setopt HIST_IGNORE_SPACE HIST_IGNORE_DUPS; precmd() { print -r -- "named:$?" >> ${quote(prior)}; }; prior() { print -r -- "prior:$?" >> ${quote(prior)}; }; oldpreexec() { print -r -- "$1" >> ${quote(debug)}; }; precmd_functions=(prior); preexec_functions=(oldpreexec)`;
      // Feed distinct interactive lines: -c does not populate interactive
      // history or exercise real DEBUG/preexec/PSReadLine command lifecycles.
      const script = [
        `export HOME=${quote(home)}; export PATH=${quote(bin)}:$PATH; HISTFILE=${quote(join(home, "history"))}; HISTSIZE=1000; ${setup}; cd ${quote(home)}; source ${quote(init)}; source ${quote(init)}`,
        "false",
        "printf 'command-status:%s\\n' \"$?\"",
        "true",
        "sleep 1.1",
        `cd ${quote(child)}`,
        "pwd",
        " echo ignored-by-history",
        "true",
        "true",
        "exit",
        "",
      ].join("\n");
      const before = Date.now() / 1000;
      const result = Bun.spawnSync([binary!, ...(shell === "bash" ? ["--noprofile", "--norc"] : ["-f"]), "-i"], {
        stdin: Buffer.from(script), stdout: "pipe", stderr: "pipe", timeout: 20000,
        env: { ...process.env, CI: "", GHOP_DISABLE: "", TERM: "xterm", PS1: "", PS2: "" },
      });
      expect(result.exitCode).toBe(0);
      expect(new TextDecoder().decode(result.stdout)).toContain("command-status:1");
      const fields = readFileSync(join(root, "records.bin"), "utf8").split("\0");
      expect(fields.pop()).toBe("");
      expect(fields.length % 8).toBe(0);
      const captures = [];
      for (let index = 0; index < fields.length; index += 8) captures.push(parseCapture(fields.slice(index, index + 8).join("\0") + "\0"));
      expect(captures.find(item => item.text === "false")!.exitCode).toBe(1);
      expect(captures.find(item => item.text === "true")!.exitCode).toBe(0);
      const slow = captures.find(item => item.text === "sleep 1.1")!;
      expect(slow.durationSec).toBeGreaterThanOrEqual(1);
      expect(slow.ts).toBeGreaterThanOrEqual(Math.floor(before));
      expect(slow.ts).toBeLessThanOrEqual(Date.now() / 1000);
      expect(captures.find(item => item.text.startsWith("cd "))!.cwd).toBe(toShellPath(home, shell));
      expect(captures.find(item => item.text === "pwd")!.cwd).toBe(toShellPath(child, shell));
      expect(captures.filter(item => item.text === "true")).toHaveLength(2);
      expect(captures.some(item => item.text.includes("ignored-by-history"))).toBe(false);
      expect(captures.every(item => item.sessionId === slow.sessionId && item.file === toShellPath(join(home, "history"), shell))).toBe(true);
      const argv = readFileSync(join(root, "argv.log"), "utf8").trim().split("\n");
      expect(argv.filter(line => line.startsWith("record"))).toEqual(captures.map(() => `record ${shell}`));
      expect(readFileSync(prior, "utf8")).toContain("prior:");
      const debugLog = readFileSync(debug, "utf8");
      expect(debugLog).toContain("false");
      if (shell === "bash") {
        expect(readFileSync(prior, "utf8")).toContain("prior:1");
        expect(debugLog).toContain("debug:0:false");
        expect(debugLog).toContain("debug:1:printf 'command-status:");
      }
      expect(argv.join("\n")).not.toContain("sleep");
      expect(argv.join("\n")).not.toContain(toShellPath(child, shell));
    }), 30000);

    if (shell === "bash") {
      runTest("preserves and de-duplicates array prompt hooks around status capture", () => withTempHome(home => {
        const root = process.env.GRASSHOPPER_HOME!;
        const bin = join(root, "bin");
        mkdirSync(bin);
        const quote = (path: string) => `'${toShellPath(path, "bash").replaceAll("'", "'\\''")}'`;
        const init = join(root, "array-init.bash");
        writeFileSync(init, renderInit("bash", toShellPath(root, "bash")));
        const records = join(root, "records.bin");
        const fake = join(bin, "ghop");
        writeFileSync(fake, `#!/bin/sh\nif [ "$1" = record ]; then cat >> ${quote(records)}; fi\n`);
        chmodSync(fake, 0o700);
        const script = [
          `export HOME=${quote(home)}; export PATH=${quote(bin)}:$PATH; HISTFILE=${quote(join(home, "history"))}; HISTSIZE=100; first() { printf 'first:%s\\n' "$?"; return 7; }; second() { printf 'second:%s\\n' "$?"; }; PROMPT_COMMAND=(first second); source ${quote(init)}; source ${quote(init)}`,
          "false",
          "exit 0",
          "",
        ].join("\n");
        const result = Bun.spawnSync([binary!, "--noprofile", "--norc", "-i"], {
          stdin: Buffer.from(script), stdout: "pipe", stderr: "pipe", timeout: 20000,
          env: { ...process.env, TERM: "xterm", CI: "", GHOP_DISABLE: "", PS1: "", PS2: "" },
        });
        expect(result.exitCode).toBe(0);
        expect(new TextDecoder().decode(result.stdout)).toBe("first:0\nsecond:0\nfirst:1\nsecond:1\n");
        const capture = parseCapture(readFileSync(records, "utf8"));
        expect(capture.text).toBe("false");
        expect(capture.exitCode).toBe(1);
      }), 30000);
    }
  });
}
