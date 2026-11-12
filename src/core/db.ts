import { Database } from "bun:sqlite";
import { existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDir, withReadOnlyFiles } from "./fsx.ts";
import { log } from "./log.ts";
import { dbFile } from "./paths.ts";
import { AsyncLocalStorage } from "node:async_hooks";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS watermarks (source TEXT PRIMARY KEY, tail_hashes TEXT NOT NULL, last_ts INTEGER);
CREATE TABLE IF NOT EXISTS analyses (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, shell TEXT NOT NULL, model TEXT,
  usage TEXT, stats TEXT NOT NULL, profile TEXT NOT NULL, messages TEXT NOT NULL,
  pseudonyms TEXT NOT NULL, response_text TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL UNIQUE, key TEXT NOT NULL,
  action_key TEXT, analysis_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('new','accepted','implemented','discarded')),
  seen_at TEXT, accept_mode TEXT, discard_reason TEXT,
  category TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, rationale TEXT NOT NULL,
  steps TEXT NOT NULL, impact TEXT NOT NULL, effort TEXT NOT NULL, evidence TEXT NOT NULL,
  tool TEXT, action TEXT, shell TEXT NOT NULL, applied TEXT
);
CREATE INDEX IF NOT EXISTS recommendations_status ON recommendations(status);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rec_id INTEGER NOT NULL REFERENCES recommendations(id),
  mode TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_rec ON chat_messages(rec_id, id);
CREATE TABLE IF NOT EXISTS ledger_days (day TEXT PRIMARY KEY, timed INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ledger_counts (
  day TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, key)
);
`;

let cached: { file: string; db: Database } | undefined;
const snapshot = new AsyncLocalStorage<Database>();

function isCorruption(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const sqliteError = error as Error & { code?: string; errno?: number; errcode?: number };
  return sqliteError.code === "SQLITE_CORRUPT"
    || sqliteError.code === "SQLITE_NOTADB"
    || [sqliteError.errno, sqliteError.errcode].some(
      (code) => typeof code === "number" && ((code & 0xff) === 11 || (code & 0xff) === 26),
    )
    || /\bSQLITE_(?:CORRUPT|NOTADB)\b|file is not a database|database disk image is malformed/i.test(error.message);
}

function createDb(file: string): Database {
  const db = new Database(file, { create: true, strict: true });
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    db.transaction(() => {
      db.exec(SCHEMA);
      db.query("INSERT INTO meta (key, value) VALUES ('schemaVersion', '1') ON CONFLICT(key) DO NOTHING").run();
    }).immediate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Open the current data directory's database, without retaining handles to old homes. */
export function openDb(): Database {
  const temporary = snapshot.getStore();
  if (temporary) return temporary;
  const file = dbFile();
  if (cached?.file === file) return cached.db;
  closeDb();
  ensureDir(dirname(file));

  let db: Database;
  try {
    db = createDb(file);
  } catch (error) {
    if (!isCorruption(error)) throw error;
    const suffix = `.corrupt-${Date.now()}`;
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
      if (existsSync(candidate)) renameSync(candidate, candidate + suffix);
    }
    log.warn("database-corrupt-recovered");
    db = createDb(file);
  }
  cached = { file, db };
  return db;
}

/** Close the memoized handle before cleanup or an explicit lifecycle change. */
export function closeDb(): void {
  if (!cached) return;
  cached.db.close();
  cached = undefined;
}

/** Immediate transactions serialize multi-statement writers across CLI processes. */
export function tx<T>(fn: () => T): T {
  return openDb().transaction(fn).immediate();
}

/** Dry-run callers can use the normal accessors without advancing persistent state. */
export async function withStateSnapshot<T>(fn: () => Promise<T>): Promise<T> {
  let db: Database;
  if (existsSync(dbFile())) {
    const source = new Database(dbFile(), { readonly: true });
    try {
      const image = source.serialize();
      // A memory database has no WAL sidecar; use rollback-journal header flags.
      image[18] = 1;
      image[19] = 1;
      db = Database.deserialize(image);
    } finally { source.close(); }
  } else db = new Database(":memory:");
  db.exec(SCHEMA);
  try { return await withReadOnlyFiles(() => snapshot.run(db, fn)); } finally { db.close(); }
}
