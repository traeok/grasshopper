import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { GhopError } from "../core/errors.ts";
import { getMeta } from "../core/state.ts";
import type { HistoryEntry } from "./parse.ts";

interface AtuinRow {
  command: string;
  timestamp: bigint;
  duration: bigint;
  exit: bigint;
  cwd: string;
  session: string;
}

/** Read only completed, non-deleted commands; never modify Atuin's database. */
export function readAtuinHistory(file: string, maxEntries: number): HistoryEntry[] {
  let db: Database | undefined;
  try {
    db = new Database(file, { readonly: true, safeIntegers: true });
    const rows = db.query<AtuinRow, [number]>(`
      SELECT command, timestamp, duration, exit, cwd, session
      FROM history
      WHERE deleted_at IS NULL AND duration >= 0 AND exit >= 0
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `).all(Math.max(0, Math.floor(maxEntries)));
    const salt = getMeta("installSalt");
    return rows.reverse().map((row, seq) => ({
      text: row.command,
      ts: Number(row.timestamp / 1_000_000_000n) + Number(row.timestamp % 1_000_000_000n) / 1e9,
      durationSec: Number(row.duration) / 1e9,
      exitCode: Number(row.exit),
      cwdHash: row.cwd ? createHmac("sha256", salt).update(row.cwd).digest("hex") : null,
      sessionId: row.session || null,
      seq,
    }));
  } catch {
    throw new GhopError("Cannot read Atuin history database. Check the database path and schema, or select --source shell.");
  } finally {
    db?.close();
  }
}
