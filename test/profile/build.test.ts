import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ConfigSchema } from "../../src/core/config.ts";
import { shellDump } from "../../src/core/paths.ts";
import { parseBash, parsePowerShell, type HistoryEntry } from "../../src/history/parse.ts";
import { readShellDumps } from "../../src/history/shell-dumps.ts";
import { buildProfile } from "../../src/profile/build.ts";
import { detectEnvironment } from "../../src/profile/environment.ts";
import { validateProfile } from "../../src/privacy/egress.ts";
import { withTempHome } from "../helpers/env.ts";

function build(entries: HistoryEntry[], which: (name: string) => string | null = () => null) {
  const dumps = readShellDumps("bash");
  return buildProfile({ entries, source: { shell: "bash", file: "fixture" }, dumps,
    ledger: { firstUntimedDay: null, days: {} }, existing: [], config: ConfigSchema.parse({}),
    env: detectEnvironment("bash", dumps, name => ["npm", "winget"].includes(name) ? `/fixture/${name}` : null),
    fresh: entries, salt: "fixture-salt", which });
}

test("exit status grounds command typos and distinguishes failures followed by retries", () => withTempHome(() => {
  const entries: HistoryEntry[] = [
    ...Array.from({ length: 2 }, () => [
      { text: "gti status", exitCode: 127 }, { text: "git status", exitCode: 0 },
      { text: "gitt status", exitCode: 0 }, { text: "gitt status", exitCode: 1 },
      { text: "git push", exitCode: 1 }, { text: "sudo git push", exitCode: 0 },
    ]).flat(),
  ].map((entry, seq) => ({ ...entry, seq, ts: 1_790_000_000 + seq, durationSec: 1, cwdHash: "private-directory-hash", sessionId: "one-session" }));
  const { profile } = build(entries, name => name === "gti" ? "/installed/today/gti" : null);
  expect(profile.typos).toEqual([{ typed: "gti", meant: "git", n: 2 }]);
  expect(profile.retries).toContainEqual({ from: "git push", to: "sudo git push", n: 2, succeeded: 2 });
  expect(profile.retries.find(row => row.to === "git status")).toMatchObject({ n: 2, succeeded: 2 });
  expect(profile.retries.some(row => row.from === "git status")).toBe(false);
  validateProfile(profile);
}));

test("project workflows use private directory groups and measured duration on every shell", () => withTempHome(() => {
  for (const shell of ["bash", "zsh", "powershell"] as const) {
    const entries: HistoryEntry[] = [];
    for (const [cwdHash, commands] of [["private-hash-a", ["git status", "npm test"]], ["private-hash-b", ["git diff", "npm run build"]]] as const) {
      for (let run = 0; run < 4; run++) for (const text of commands) {
        const seq = entries.length;
        entries.push({ text, seq, ts: 1_790_000_000 + seq * 30, durationSec: 20, exitCode: 0, cwdHash, sessionId: cwdHash });
      }
    }
    const dumps = readShellDumps(shell);
    const { profile } = buildProfile({ entries, source: { shell, file: "fixture" }, dumps,
      ledger: { firstUntimedDay: null, days: {} }, existing: [], config: ConfigSchema.parse({}),
      env: detectEnvironment(shell, dumps, () => null), fresh: entries, salt: "fixture-salt", which: () => null });
    expect(profile.projects).toHaveLength(2);
    expect(profile.projects[0]).toMatchObject({ project: 1, n: 8, sequences: [{ seq: ["git status", "npm test"], n: 4 }] });
    expect(profile.projects[1]).toMatchObject({ project: 2, n: 8, sequences: [{ seq: ["git diff", "npm run build"], n: 4 }] });
    expect(profile.slow).toContainEqual({ t: "npm test", n: 4, avgSec: 20 });
    expect(profile.environment.history.timestamps).toBe(true);
    const wire = JSON.stringify(profile);
    expect(wire).not.toContain("private-hash");
    expect(wire).not.toContain("sessionId");
    validateProfile(profile);
  }
}));

test("retry and workflow detection do not cross sessions, idle gaps, or filtered commands", () => withTempHome(() => {
  for (const boundary of ["session", "idle", "filtered", "directory"] as const) {
    const entries: HistoryEntry[] = [];
    for (let run = 0; run < 4; run++) {
      const start = entries.length;
      entries.push({ text: "git push", seq: start, ts: 1_790_000_000 + run * 2000, durationSec: 1, exitCode: 1, cwdHash: "a", sessionId: `start-${run}` });
      if (boundary === "filtered") entries.push({ text: " hidden-command", seq: entries.length, ts: null, durationSec: null });
      entries.push({ text: "git push --force", seq: entries.length, ts: 1_790_000_000 + run * 2000 + (boundary === "idle" ? 601 : 1),
        durationSec: 1, exitCode: 0, cwdHash: boundary === "directory" ? "b" : "a", sessionId: boundary === "session" ? `end-${run}` : `start-${run}` });
    }
    const { profile } = build(entries);
    expect(profile.retries).toEqual([]);
    expect(profile.projects.every(project => project.sequences.length === 0)).toBe(true);
    if (boundary !== "directory") expect(profile.sequences).toEqual([]);
  }
}));

describe("profile aggregation", () => {
  test("compresses mixed fixture history without carrying its literals", () => withTempHome(async () => {
    for (const kind of ["aliases", "info"] as const) {
      const target = shellDump("bash", kind);
      mkdirSync(join(target, ".."), { recursive: true });
      copyFileSync(new URL(`../fixtures/shell/bash.${kind}`, import.meta.url), target);
    }
    const realistic = await Bun.file(new URL("../fixtures/history/realistic-bash.txt", import.meta.url)).text();
    const leaks = await Bun.file(new URL("../fixtures/history/leak-corpus.txt", import.meta.url)).text();
    const entries = parseBash(new TextEncoder().encode(realistic + "\n" + leaks));
    const { profile, pseudonyms, stats } = build(entries);
    const gs = Object.entries(pseudonyms).find(([, p]) => p.type === "alias" && p.value === "gs")?.[0];
    expect(profile.aliasCandidates.find(a => a.t === "git status")?.coveredBy).toBe(gs);
    expect(profile.sequences.some(s => JSON.stringify(s.seq) === JSON.stringify(["git add .", "git commit -m <str>", "git push"]))).toBe(true);
    expect(profile.signals.historyGrep).toBeGreaterThanOrEqual(3);
    expect(profile.signals.cdUpChains).toBeGreaterThanOrEqual(1);
    expect(profile.signals.uselessCat).toBeGreaterThanOrEqual(2);
    expect(profile.typos).toContainEqual({ typed: "gti", meant: "git", n: 2 });
    for (const kind of ["inline-secret", "curl-pipe-shell", "force-push", "possible-password-typed", "leading-space-recorded", "history-truncated"]) expect(profile.redFlags.some(r => r.kind === kind)).toBe(true);
    expect(profile.paths.some(p => /^<path#\d+>$/.test(p.p) && p.viaCd >= 6)).toBe(true);
    expect(JSON.stringify(profile).toLowerCase()).not.toContain("zq");
    expect(stats.kept + Object.values(stats.dropped).reduce((a, b) => a + b, 0)).toBe(entries.length);
    expect(stats.payloadBytes).toBe(new TextEncoder().encode(JSON.stringify(profile)).length);
    expect(JSON.stringify(profile).length).toBeLessThanOrEqual(16_384);
  }));

  test("installed commands are not typos, while missing commands and subcommand typos remain", () => withTempHome(() => {
    const entries = parseBash(new TextEncoder().encode("jj status\ngitt status\ngit sttaus\n".repeat(4)));
    const { profile } = build(entries, name => ["jj", "sttaus"].includes(name) ? `/fixture/${name}` : null);
    expect(profile.typos.map(row => row.typed)).not.toContain("jj");
    expect(profile.typos).toContainEqual({ typed: "gitt", meant: "git", n: 4 });
    expect(profile.typos).toContainEqual({ typed: "git sttaus", meant: "git status", n: 4 });
  }));

  test("counts runs, host usage, slow commands, and copies the ledger", () => withTempHome(() => {
    const texts = ["git status", "git status", "git status", "ssh build.example.internal", "ssh build.example.internal", "ssh build.example.internal"];
    const entries = texts.map((text, seq) => ({ text, seq, ts: null, durationSec: 20 }));
    const result = build(entries);
    expect(result.profile.repeats.find(r => r.t === "git status")).toEqual({ t: "git status", runs: 1, maxRun: 3 });
    expect(result.profile.slow).toContainEqual({ t: "git status", n: 3, avgSec: 20 });
    expect(result.profile.hosts[0]).toMatchObject({ h: "<host#1>", n: 3, via: ["ssh"] });
    expect(result.profile.environment.installedTools).toEqual([]);
    const dumps = readShellDumps("bash");
    const ledger = { firstUntimedDay: null, days: {} };
    buildProfile({ entries, source: { shell: "bash", file: "fixture" }, dumps, ledger, existing: [], config: ConfigSchema.parse({}), env: detectEnvironment("bash", dumps, () => null), fresh: entries, salt: "fixture" });
    expect(ledger).toEqual({ firstUntimedDay: null, days: {} });
    expect(Object.keys(result.ledgerNext.days)).toHaveLength(1);
  }));

  test("enforces section and payload caps on varied normalized history", () => withTempHome(() => {
    const entries: HistoryEntry[] = [];
    for (let i = 0; i < 180; i++) for (let j = 0; j < 6; j++) entries.push({ text: `git diff branch-${i} -- src/file-${i}.ts`, seq: entries.length, ts: null, durationSec: null });
    const { profile, stats } = build(entries);
    expect(profile.templates.length).toBeLessThanOrEqual(30);
    expect(profile.aliasCandidates.length).toBeLessThanOrEqual(15);
    expect(profile.paths.length).toBeLessThanOrEqual(10);
    expect(profile.sequences.length).toBeLessThanOrEqual(15);
    expect(JSON.stringify(profile).length).toBeLessThanOrEqual(16_384);
    expect(stats.grammarSkips).toBe(0);
  }));
});

test("PowerShell profiles retain useful grammar and aliases without exposing private data", () => withTempHome(() => {
  const dumps = readShellDumps("powershell");
  dumps.aliases.push({ name: "PrivateListing", expansion: "Get-ChildItem -LiteralPath 'C:\\Private\\Folder'" });
  const texts = Array(3).fill([
    "Get-ChildItem -LiteralPath 'C:\\Private\\Folder'",
    "privatelisting",
    "PRIVATELISTING",
    "Get-Process | Select-Object -First 2",
  ].join("\r\n")).join("\r\n");
  const entries = parsePowerShell(new TextEncoder().encode("\ufeff" + texts + "\r\nInvoke-RestMethod -Headers @{ Authorization = 'Basic private-value' }\r\n"));
  const env = detectEnvironment("powershell", dumps, () => null);
  env.platform = "windows";
  env.keymap = "windows";
  const { profile, stats } = buildProfile({
    entries, source: { shell: "powershell", file: "fixture" }, dumps,
    ledger: { firstUntimedDay: null, days: {} }, existing: [], config: ConfigSchema.parse({}),
    env, fresh: entries, salt: "fixture-salt",
  });
  expect(profile.environment).toMatchObject({ shell: "powershell", platform: "windows", keymap: "windows" });
  expect(profile.window).toMatchObject({ kept: 12, dropped: 1, spanDays: null });
  expect(profile.topCommands).toContainEqual({ c: "get-childitem", n: 3 });
  expect(profile.templates.some(row => row.t === "get-process | select-object -first <num>")).toBe(true);
  expect(profile.aliases[0]).toMatchObject({ expands: "get-childitem -literalpath <path#1>", used: 6, fullFormUsed: 3 });
  expect(stats.grammarSkips).toBe(0);
  const wire = JSON.stringify(profile);
  for (const value of ["PrivateListing", "private-value", "Private", "Folder", "Authorization"]) expect(wire).not.toContain(value);
}));
