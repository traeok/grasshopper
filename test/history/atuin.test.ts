import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempHome } from "../helpers/env.ts";
import { getMeta, setMeta } from "../../src/core/state.ts";
import { withStateSnapshot } from "../../src/core/db.ts";
import { dbFile } from "../../src/core/paths.ts";
import { readHistory } from "../../src/history/parse.ts";
import { resolveSource } from "../../src/history/source.ts";

function fixture(file: string): void {
  const db = new Database(file);
  try {
    db.exec(`CREATE TABLE history (
      id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, duration INTEGER NOT NULL,
      exit INTEGER NOT NULL, command TEXT NOT NULL, cwd TEXT NOT NULL,
      session TEXT NOT NULL, hostname TEXT NOT NULL, deleted_at INTEGER
    )`);
    const insert = db.query("INSERT INTO history VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    // Intentionally out of chronological order, including a tied timestamp.
    insert.run("c", 1700000002250000000n, 1500000000n, 2, "git diff", "/private/project", "session-two", "private-host", null);
    insert.run("a", 1700000000125000000n, 0n, 0, "git status", "/private/project", "session-one", "private-host", null);
    insert.run("b", 1700000002250000000n, 250000000n, 127, "git missing", "/private/other", "session-one", "private-host", null);
    insert.run("deleted", 1700000003000000000n, 10n, 0, "deleted command", "/private/project", "session-two", "private-host", 1700000004000000000n);
    insert.run("unfinished", 1700000004000000000n, -1n, -1, "unfinished command", "/private/project", "session-two", "private-host", null);
    insert.run("unknown-exit", 1700000005000000000n, 10n, -1, "unknown exit", "", "", "private-host", null);
  } finally { db.close(); }
}

test("Atuin converts nanoseconds, preserves exit/session, hashes cwd and orders deterministically", () => withTempHome(async home => {
  const file = join(home, "history.db");
  fixture(file);
  const before = readFileSync(file);
  const salt = "0123456789abcdef0123456789abcdef";
  setMeta("installSalt", salt);
  const entries = await readHistory({ shell: "bash", file, kind: "atuin" }, 20);
  expect(entries).toEqual([
    { text: "git status", ts: 1700000000.125, durationSec: 0, exitCode: 0, sessionId: "session-one", cwdHash: createHmac("sha256", salt).update("/private/project").digest("hex"), seq: 0 },
    { text: "git missing", ts: 1700000002.25, durationSec: 0.25, exitCode: 127, sessionId: "session-one", cwdHash: createHmac("sha256", salt).update("/private/other").digest("hex"), seq: 1 },
    { text: "git diff", ts: 1700000002.25, durationSec: 1.5, exitCode: 2, sessionId: "session-two", cwdHash: createHmac("sha256", salt).update("/private/project").digest("hex"), seq: 2 },
  ]);
  expect(JSON.stringify(entries)).not.toContain("/private/");
  expect(JSON.stringify(entries)).not.toContain("private-host");
  expect(readFileSync(file)).toEqual(before);
  expect((await readHistory({ shell: "zsh", file, kind: "atuin" }, 2)).map(e => [e.text, e.seq])).toEqual([["git missing", 0], ["git diff", 1]]);
  expect(await readHistory({ shell: "bash", file, kind: "atuin" }, 0)).toEqual([]);
  setMeta("installSalt", "fedcba9876543210fedcba9876543210");
  const changed = await readHistory({ shell: "bash", file, kind: "atuin" }, 20);
  expect(changed[0]!.cwdHash).not.toBe(entries[0]!.cwdHash);
}));

test("selected corrupt or missing Atuin never silently falls back to shell history", () => withTempHome(async home => {
  process.env.GHOP_SHELL = "bash";
  writeFileSync(join(home, ".bash_history"), "git status\n");
  process.env.ATUIN_DB_PATH = join(home, "broken.db");
  writeFileSync(process.env.ATUIN_DB_PATH, "not sqlite");
  const detected = resolveSource({ persist: false });
  expect(detected.kind).toBe("atuin");
  await expect(readHistory(detected, 20)).rejects.toThrow("Cannot read Atuin history database");
  const missing = resolveSource({ source: "atuin", histfile: join(home, "missing.db"), persist: false });
  await expect(readHistory(missing, 20)).rejects.toThrow("Cannot read Atuin history database");
  expect(existsSync(missing.file)).toBe(false);
}));

test("Atuin preview snapshots leave no source or salt state behind", () => withTempHome(async home => {
  process.env.ATUIN_DB_PATH = join(home, "history.db");
  fixture(process.env.ATUIN_DB_PATH);
  await withStateSnapshot(async () => {
    const source = resolveSource({ source: "atuin", shell: "bash", persist: false });
    expect(await readHistory(source, 20)).toHaveLength(3);
    expect(getMeta("lastSource")).toBeNull();
  });
  expect(existsSync(dbFile())).toBe(false);
}));

test("Atuin missing cwd/session remain absent and committed WAL rows are visible", () => withTempHome(async home => {
  const file = join(home, "wal-history.db");
  fixture(file);
  const writer = new Database(file);
  try {
    writer.exec("PRAGMA journal_mode = WAL");
    writer.query("INSERT INTO history VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("latest", 1700000006000000000n, 500000000n, 0, "pwd", "", "", "private-host", null);
    const entries = await readHistory({ shell: "bash", file, kind: "atuin" }, 1);
    expect(entries).toEqual([{ text: "pwd", ts: 1700000006, durationSec: 0.5, exitCode: 0, cwdHash: null, sessionId: null, seq: 0 }]);
  } finally { writer.close(); }
}));
