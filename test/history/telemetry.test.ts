import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/core/config.ts";
import { closeDb, openDb, withStateSnapshot } from "../../src/core/db.ts";
import { getMeta } from "../../src/core/state.ts";
import { dbFile } from "../../src/core/paths.ts";
import { parseBash, readHistory, type HistoryEntry } from "../../src/history/parse.ts";
import type { HistorySource } from "../../src/history/source.ts";
import { enrichHistory, parseCapture, recordTelemetry, type CommandCapture } from "../../src/history/telemetry.ts";
import { withTempHome } from "../helpers/env.ts";

function capture(file: string, changes: Partial<CommandCapture> = {}): CommandCapture {
  return { version: 1, text: "git status", ts: Date.now() / 1000 + 60, durationSec: 1.25, exitCode: 0, cwd: "/private/project-telemetry", sessionId: "session-one", file, ...changes };
}
function entries(text: string): HistoryEntry[] { return parseBash(Buffer.from(text)); }

describe("private command telemetry", () => {
  test("rejects a newer unflushed duplicate even within the same history timestamp second", async () => withTempHome(async home => {
    const file = join(home, "history");
    writeFileSync(file, "#1700000000\ngit status\n");
    utimesSync(file, new Date(1700000000300), new Date(1700000000300));
    recordTelemetry("bash", capture(file, { ts: 1700000000.8, exitCode: 127 }));
    expect((await readHistory({ shell: "bash", file }, 1))[0]!.exitCode).toBeUndefined();
  }));

  test("matches PSReadLine history flushed between acceptance and engine start", async () => withTempHome(async home => {
    const file = join(home, "history");
    const now = Date.now() / 1000;
    writeFileSync(file, "git status\n");
    recordTelemetry("powershell", capture(file, { ts: now + 1, acceptedTs: now - 1, exitCode: 7 }));
    const result = await readHistory({ shell: "powershell", file }, 1);
    expect(result[0]!.exitCode).toBe(7);
    expect(result[0]!.ts).toBe(now + 1);
  }));

  test("does not invent an order for simultaneous buffered sessions", () => withTempHome(home => {
    const file = join(home, "history");
    const first = capture(file, { sessionId: "one", exitCode: 1 });
    recordTelemetry("bash", first);
    recordTelemetry("bash", { ...first, ts: first.ts + 1, sessionId: "two", exitCode: 0 });
    writeFileSync(file, "git status\ngit status\n");
    expect(enrichHistory({ shell: "bash", file }, entries("git status\ngit status\n")).map(entry => entry.exitCode)).toEqual([undefined, undefined]);
  }));

  test("adds telemetry to an existing database and to an old-database snapshot", async () => withTempHome(async home => {
    const old = new Database(dbFile(), { create: true });
    old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    old.close();
    await withStateSnapshot(async () => {
      recordTelemetry("bash", capture(join(home, "history")));
      expect(openDb().query("SELECT count(*) AS n FROM command_telemetry").get()).toEqual({ n: 1 });
    });
    closeDb();
    expect(openDb().query("SELECT count(*) AS n FROM command_telemetry").get()).toEqual({ n: 0 });
  }));

  test("accepts NUL fields and PowerShell JSON without allowing truncated or nonfinite values", () => {
    const item = capture("/tmp/history", { text: "printf 'one\\ntwo'\nfalse", cwd: "/private/é" });
    const wire = ["1", item.text, item.ts, item.durationSec, item.exitCode, item.cwd, item.sessionId, item.file].join("\0") + "\0";
    expect(parseCapture(wire)).toEqual(item);
    expect(parseCapture(JSON.stringify(item))).toEqual(item);
    expect(() => parseCapture(wire.slice(0, -1))).toThrow();
    expect(() => parseCapture(wire.replace("\0" + item.durationSec + "\0", "\0NaN\0"))).toThrow();
    expect(() => parseCapture(JSON.stringify({ ...item, raw: "not accepted" }))).toThrow();
  });

  test("stores only salted metadata and ignores blank/self commands", () => withTempHome(home => {
    const file = join(home, "history");
    const item = capture(file, { text: "deploy --password=SECRET_COMMAND_telemetry", cwd: "/SECRET_CWD_telemetry" });
    recordTelemetry("bash", item);
    recordTelemetry("bash", { ...item, text: " " });
    recordTelemetry("bash", { ...item, text: "ghop analyze" });
    const rows = openDb().query("SELECT * FROM command_telemetry").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    const salt = getMeta("installSalt");
    expect(rows[0]!.command_hash).toBe(createHmac("sha256", salt).update(item.text).digest("hex"));
    expect(rows[0]!.cwd_hash).toBe(createHmac("sha256", salt).update(item.cwd).digest("hex"));
    expect(rows[0]!.exit_code).toBe(0);
    expect(rows[0]!.duration_sec).toBe(1.25);
    const image = Buffer.from(openDb().serialize()).toString("utf8");
    expect(image).not.toContain("SECRET_COMMAND_telemetry");
    expect(image).not.toContain("SECRET_CWD_telemetry");
    expect(Object.keys(rows[0]!)).not.toContain("text");
    expect(Object.keys(rows[0]!)).not.toContain("cwd");
  }));

  test("preserves repeated executions with the same second-resolution start time", () => withTempHome(home => {
    const file = join(home, "history");
    const item = capture(file, { ts: 1700000000, exitCode: 1 });
    recordTelemetry("bash", item);
    recordTelemetry("bash", { ...item, exitCode: 0 });
    const input = entries("#1700000000\ngit status\n#1700000000\ngit status\n");
    expect(enrichHistory({ shell: "bash", file }, input).map(entry => entry.exitCode)).toEqual([1, 0]);
  }));

  test("matches timestamped duplicate occurrences, not a newer omitted duplicate", () => withTempHome(home => {
    const file = join(home, "history");
    const source: HistorySource = { shell: "bash", file };
    recordTelemetry("bash", capture(file, { ts: 1700000000.1, exitCode: 1 }));
    recordTelemetry("bash", capture(file, { ts: 1700000002.2, exitCode: 0 }));
    recordTelemetry("bash", capture(file, { ts: 1700000004.3, exitCode: 127 }));
    const input = entries("#1700000000\ngit status\n#1700000002\ngit status\n");
    const result = enrichHistory(source, input);
    expect(result).toHaveLength(2);
    expect(result.map(entry => entry.exitCode)).toEqual([1, 0]);
    expect(result.map(entry => entry.ts)).toEqual([1700000000.1, 1700000002.2]);
    expect(input[0]!.exitCode).toBeUndefined();
    expect(enrichHistory(source, entries("#1699999999\ngit status\n"))[0]!.exitCode).toBeUndefined();
    expect(enrichHistory({ ...source, shell: "zsh" }, input)).toEqual(input);
    expect(enrichHistory({ ...source, file: file + ".other" }, input)).toEqual(input);
  }));

  test("does not guess among timestamp duplicates in the same second", () => withTempHome(home => {
    const file = join(home, "history");
    recordTelemetry("bash", capture(file, { ts: 1700000000.1, exitCode: 1 }));
    recordTelemetry("bash", capture(file, { ts: 1700000000.8, exitCode: 0 }));
    const result = enrichHistory({ shell: "bash", file }, entries("#1700000000\ngit status\n"));
    expect(result[0]!.exitCode).toBeUndefined();
  }));

  test("never assigns unflushed telemetry to an older untimed identical command", () => withTempHome(home => {
    const file = join(home, "history");
    writeFileSync(file, "git status\n");
    utimesSync(file, new Date(100000), new Date(100000));
    recordTelemetry("bash", capture(file, { exitCode: 127 }));
    const source: HistorySource = { shell: "bash", file };
    expect(enrichHistory(source, entries("git status\n"))[0]!.exitCode).toBeUndefined();
    writeFileSync(file, "git status\ngit status\n");
    const result = enrichHistory(source, entries("git status\ngit status\n"));
    expect(result.map(entry => entry.exitCode)).toEqual([undefined, 127]);
  }));

  test("aligns buffered duplicates in occurrence order after a persisted byte boundary", async () => withTempHome(async home => {
    const file = join(home, "history");
    writeFileSync(file, "older command\ngit status\n");
    const first = capture(file, { exitCode: 1 });
    recordTelemetry("bash", first);
    recordTelemetry("bash", { ...first, ts: first.ts + 2, exitCode: 0 });
    writeFileSync(file, "older command\ngit status\ngit status\ngit status\n");
    const source: HistorySource = { shell: "bash", file };
    const result = await readHistory(source, 2);
    expect(result.map(entry => entry.seq)).toEqual([0, 1]);
    expect(result.map(entry => entry.exitCode)).toEqual([1, 0]);
    expect(result.map(entry => entry.sessionId)).toEqual(["session-one", "session-one"]);
    expect(result[0]!.cwdHash).toMatch(/^[a-f0-9]{64}$/);
  }));

  test("matches an already flushed untimed command but refuses rewritten prefixes", async () => withTempHome(async home => {
    const file = join(home, "history");
    writeFileSync(file, "prefix command\ngit status\n");
    recordTelemetry("bash", capture(file, { ts: Date.now() / 1000 - 5, exitCode: 7 }));
    expect((await readHistory({ shell: "bash", file }, 1))[0]!.exitCode).toBe(7);
    writeFileSync(file, "changed prefix\ngit status\n");
    expect((await readHistory({ shell: "bash", file }, 1))[0]!.exitCode).toBeUndefined();
  }));

  test("respects multiline shell framing and the reader's bounded tail", async () => withTempHome(async home => {
    for (const shell of ["bash", "zsh", "powershell"] as const) {
      const file = join(home, shell);
      const text = "echo first\necho second";
      writeFileSync(file, "older\r\n");
      recordTelemetry(shell, capture(file, { text, exitCode: 3 }));
      const persisted = shell === "powershell" ? "echo first`\r\necho second\r\n" : shell === "zsh" ? "echo first\\\r\necho second\r\n" : "#1700000000\necho first\necho second\n";
      if (shell === "bash") {
        // Bash multiline records require timestamp framing; matching stays
        // timestamp-safe rather than attaching metadata across mismatched time.
        writeFileSync(file, persisted);
        expect((await readHistory({ shell, file }, 1))[0]!.exitCode).toBeUndefined();
      } else {
        writeFileSync(file, "older\r\n" + persisted);
        const result = await readHistory({ shell, file }, 1);
        expect(result[0]!.text).toBe(text);
        expect(result[0]!.exitCode).toBe(3);
      }
    }
  }));

  test("bounds retention by analysis.maxEntries and installs the table in snapshots", async () => withTempHome(async home => {
    const config = loadConfig();
    config.analysis.maxEntries = 2;
    saveConfig(config);
    const file = join(home, "history");
    for (let index = 0; index < 3; index++) recordTelemetry("bash", capture(file, { text: "command " + index, ts: index + 1 }));
    expect(openDb().query("SELECT count(*) AS n FROM command_telemetry").get()).toEqual({ n: 2 });
    await withStateSnapshot(async () => {
      recordTelemetry("bash", capture(file, { text: "snapshot command" }));
      expect(openDb().query("SELECT count(*) AS n FROM command_telemetry").get()).toEqual({ n: 2 });
    });
    expect(openDb().query("SELECT ts FROM command_telemetry ORDER BY ts").all()).toEqual([{ ts: 2 }, { ts: 3 }]);
  }));
});
