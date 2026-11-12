import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { shellDump } from "../../src/core/paths.ts";
import type { HistoryEntry } from "../../src/history/parse.ts";
import { readShellDumps } from "../../src/history/shell-dumps.ts";
import { detectEnvironment } from "../../src/profile/environment.ts";
import { detectRedFlags } from "../../src/profile/red-flags.ts";
import type { RedFlagKind } from "../../src/profile/red-flags.ts";
import { detectSignals } from "../../src/profile/signals.ts";
import type { SignalName } from "../../src/profile/signals.ts";
import { withTempHome } from "../helpers/env.ts";

function entries(lines: string[]): HistoryEntry[] {
  return lines.map((text, seq) => ({ text, seq, ts: null, durationSec: null }));
}

test("shell dumps parse aliases and filter framework functions without evaluating shell text", () => withTempHome(() => {
  expect(readShellDumps("bash")).toEqual({ aliases: [], functions: [], info: {}, capturedAt: null });
  mkdirSync(dirname(shellDump("bash", "aliases")), { recursive: true });
  writeFileSync(shellDump("bash", "aliases"), "alias ll='ls -l'\nalias -g -- GS='git status'\nalias -s txt='cat'\nalias x='echo $(touch never-created)'\n");
  writeFileSync(shellDump("bash", "functions"), "useful\n_ignored\n+ignored\n.ignored\n-ignored\na::b\nomz_theme\nprompt_foo\np10k\n_p9k\nstarship_init\nzle-widget\n__ghop_daily\nuseful\n");
  writeFileSync(shellDump("bash", "info"), "BASH_VERSION=5.2.37(1)-release\nHISTSIZE=150\nHISTFILESIZE=bad\nHISTCONTROL=ignoreboth:erasedups\nPROMPT_HISTORY_A=1\nOPT_histappend=1\nKEYMAP=emacs\nSTARSHIP=1\n");
  const dumps = readShellDumps("bash");
  expect(dumps.aliases).toEqual([{ name: "ll", expansion: "ls -l" }, { name: "GS", expansion: "git status" }, { name: "x", expansion: "echo $(touch never-created)" }]);
  expect(dumps.functions).toEqual(["useful"]);
  expect(dumps.capturedAt).not.toBeNull();
  const env = detectEnvironment("bash", dumps, name => name === "npm" ? "/fake/npm" : null);
  expect(env.shellVersion).toBe("5.2");
  expect(env.keymap).toBe("emacs");
  expect(env.packageManagers).toEqual(["npm"]);
  expect(env.installedTools).toEqual([]);
  expect(env.frameworks).toEqual(["starship"]);
  expect(env.history).toMatchObject({ sizeLimit: 150, fileLimit: null, ignoreSpace: true, ignoreDups: true, appendIncremental: true, shared: false });
  expect(env.options.histappend).toBe(true);
}));

test("zsh options, frameworks, and missing info use conservative environment values", () => {
  const empty = { aliases: [], functions: [], info: {}, capturedAt: null };
  expect(detectEnvironment("zsh", empty, () => null).history).toMatchObject({ ignoreSpace: null, ignoreDups: null, appendIncremental: null, shared: null });
  const env = detectEnvironment("zsh", { ...empty, capturedAt: "2026-11-12", info: { ZSH_VERSION: "5.9", HISTSIZE: "10000", SAVEHIST: "20000", OPTIONS: "autocd,correct,autopushd,extendedglob,histignorespace,histignorealldups,sharehistory", KEYMAP: "untrusted", OMZ: "1", P10K: "1" } }, () => null);
  expect(env.history).toMatchObject({ sizeLimit: 10000, fileLimit: 20000, ignoreSpace: true, ignoreDups: true, appendIncremental: true, shared: true });
  expect(env.frameworks).toEqual(["oh-my-zsh", "powerlevel10k"]);
  expect(env.keymap).toBe("unknown");
  expect(Object.values(env.options)).toEqual([true, true, true, true]);
});

const signalCases: [SignalName, string[], number][] = [
  ["historyGrep", ["history | grep checkout"], 1],
  ["retypedWithSudo", ["apt update", "sudo apt update"], 1],
  ["lastArgReuse", ["cat package.json", "less package.json"], 1],
  ["cdUp", ["cd ..", "cd ../..", "cd ../../"], 3],
  ["cdUpChains", ["cd ..", "cd ..", "cd ..", "pwd", "cd ..", "cd .."], 2],
  ["cdThenLs", ["cd src", "ls"], 1],
  ["mkdirThenCd", ["mkdir src", "cd src"], 1],
  ["clearScreen", ["clear", "cls", "reset"], 3],
  ["exitCommand", ["exit", "logout"], 2],
  ["uselessCat", ["cat package.json | grep version", "cat a b | grep x"], 1],
  ["grepRecursive", ["grep -rn TODO src", "grep --recursive TODO src"], 2],
  ["findByName", ["find . -iname '*.log'"], 1],
  ["psGrep", ["ps aux | grep node"], 1],
  ["manLookups", ["man git"], 1],
  ["helpLookups", ["git --help", "npm -h", "help cd"], 3],
  ["consecutiveRepeats", ["git status", "git status", "git status"], 2],
  ["longPipelines", ["cat a | grep b | sort | uniq", "cat a | sort | uniq"], 1],
  ["cdHome", ["cd", "cd ~"], 2],
  ["gitStatus", ["git status"], 1],
  ["gitAddAll", ["git add .", "git add -A", "git add --all"], 3],
  ["dirStack", ["pushd src", "popd", "cd -"], 3],
];
for (const [signal, lines, count] of signalCases) test(`signal ${signal}`, () => {
  const kept = entries(lines).map(entry => ({ entry, commands: [], ops: [] }));
  expect(detectSignals(kept)[signal]).toBe(count);
});

const riskCases: [RedFlagKind, string][] = [
  ["secret-file-view", "cat '.env.local'"], ["curl-pipe-shell", "curl https://example.dev/install | bash"],
  ["chmod-777", "chmod -R 0777 src"], ["rm-rf-risky", "rm -r -f \"$HOME\""],
  ["force-push", "git push -f origin main"], ["no-verify", "git commit -an"],
  ["reset-hard", "git reset --hard"], ["git-clean-force", "git clean -fd"],
  ["tls-disabled", "curl -sk https://example.dev"], ["sudo-npm-global", "sudo npm i -g foo"],
  ["docker-privileged", "docker run --privileged foo"], ["eval-remote", "eval \"$(curl https://example.dev)\""],
];
for (const [kind, line] of riskCases) test(`red flag ${kind}`, () => {
  const env = detectEnvironment("bash", { aliases: [], functions: [], info: {}, capturedAt: null }, () => null);
  const flags = detectRedFlags(entries([line, line]), [{ drop: null }, { drop: null }], env);
  expect(flags).toContainEqual({ kind, n: 2 });
});

test("drop-based risks, history caps, and force-with-lease remain counts only", () => {
  const env = detectEnvironment("bash", { aliases: [], functions: [], info: { HISTFILESIZE: "3" }, capturedAt: "2026-11-12" }, () => null);
  const flags = detectRedFlags(entries(["hidden secret", "hidden password", " hidden command"]), [{ drop: "secret" }, { drop: "possible-password" }, { drop: "leading-space" }], env);
  expect(flags).toContainEqual({ kind: "inline-secret", n: 1 });
  expect(flags).toContainEqual({ kind: "possible-password-typed", n: 1 });
  expect(flags).toContainEqual({ kind: "leading-space-recorded", n: 1 });
  expect(flags).toContainEqual({ kind: "history-truncated", n: 1 });
  env.history.ignoreSpace = true;
  expect(detectRedFlags(entries([" hidden command"]), [{ drop: "leading-space" }], env)).toEqual([]);
  expect(detectRedFlags(entries(["git push --force --force-with-lease", "git push -f --force-if-includes", "rm -rf ./build"]), [], { ...env, history: { ...env.history, fileLimit: null } })).toEqual([]);
});
