import { createHmac } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { loadConfig } from "../core/config.ts";
import { openDb, tx } from "../core/db.ts";
import { toNativePath } from "../core/paths.ts";
import { getMeta } from "../core/state.ts";
import { parseBash, parsePowerShell, parseZsh, type HistoryEntry } from "./parse.ts";
import type { HistorySource, Shell } from "./source.ts";

/**
 * `ghop record <shell>` reads stdin only. POSIX: eight UTF-8 fields, each ending
 * in NUL: version("1"), text, start epoch seconds, duration seconds, exit code,
 * start cwd, session ID, history file. PowerShell sends the equivalent JSON
 * object (version: 1, text, ts, durationSec, exitCode, cwd, sessionId, file).
 * JSON may include acceptedTs (PSReadLine acceptance epoch seconds) because its
 * history file is flushed before Get-History's engine start timestamp.
 * No raw command or cwd is ever written to SQLite, logs, or argv.
 */
const Capture = z.object({
  version: z.literal(1), text: z.string().min(1),
  ts: z.number().finite().nonnegative(), durationSec: z.number().finite().nonnegative(),
  exitCode: z.number().int(), cwd: z.string().min(1), sessionId: z.string().min(1), file: z.string().min(1),
  acceptedTs: z.number().finite().nonnegative().optional(),
}).strict();
export type CommandCapture = z.infer<typeof Capture>;

export function parseCapture(input: string): CommandCapture {
  if (input.startsWith("\uFEFF")) input = input.slice(1);
  if (input.trimStart().startsWith("{")) return Capture.parse(JSON.parse(input));
  const fields = input.split("\0");
  if (fields.length !== 9 || fields.pop() !== "" || fields[0] !== "1") throw new Error("Invalid telemetry input");
  if (fields.slice(2, 5).some(value => !value || value.trim() !== value)) throw new Error("Invalid telemetry numbers");
  return Capture.parse({ version: 1, text: fields[1], ts: Number(fields[2]), durationSec: Number(fields[3]), exitCode: Number(fields[4]), cwd: fields[5], sessionId: fields[6], file: fields[7] });
}

function hash(salt: string, value: string | Uint8Array): string { return createHmac("sha256", salt).update(value).digest("hex"); }
function commandText(text: string): string { return text.replaceAll("\r\n", "\n").replace(/\n$/, ""); }
function sourceFile(file: string): string {
  const path = resolve(toNativePath(file));
  return process.platform === "win32" ? path.toLowerCase() : path;
}
interface HistoryRecord { entry: HistoryEntry; start: number }

/** Locate raw record boundaries while reusing the authoritative shell parsers. */
function records(bytes: Uint8Array, shell: Shell): HistoryRecord[] {
  const lines: { start: number; end: number; text: string }[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 10) continue;
    lines.push({ start, end: index + 1, text: Buffer.from(bytes.subarray(start, index)).toString("utf8").replace(/\r$/, "") });
    start = index + 1;
  }
  if (start < bytes.length) lines.push({ start, end: bytes.length, text: Buffer.from(bytes.subarray(start)).toString("utf8").replace(/\r$/, "") });
  const timestamp = /^#\d{9,11}$/;
  const timedBash = shell === "bash" && lines.some(line => timestamp.test(line.text));
  const result: HistoryRecord[] = [];
  let recordStart = 0;
  const append = (end: number) => {
    const chunk = bytes.subarray(recordStart, end);
    const parsed = shell === "bash" ? parseBash(chunk) : shell === "zsh" ? parseZsh(chunk) : parsePowerShell(chunk);
    for (const entry of parsed) result.push({ entry, start: recordStart });
    recordStart = end;
  };
  for (const line of lines) {
    if (timedBash) {
      if (timestamp.test(line.text)) { append(line.start); recordStart = line.start; }
    } else {
      const continued = shell === "powershell" ? line.text.endsWith("`") : shell === "zsh" && ((/\\+$/.exec(line.text)?.[0].length ?? 0) % 2 === 1);
      if (!continued) append(line.end);
    }
  }
  if (recordStart < bytes.length) append(bytes.length);
  return result;
}

export function recordTelemetry(shell: Shell, raw: CommandCapture): void {
  const capture = Capture.parse(raw);
  const text = commandText(capture.text);
  if (!text.trim() || /(?:^|[\s;&|])(?:command\s+)?(?:ghop|__ghop_[\w]+)(?:\s|$)/.test(text)) return;
  const salt = getMeta("installSalt");
  const source = { shell, file: sourceFile(capture.file) };
  // Keep an authenticated boundary, not command text. Without a timestamp in
  // history, a newer, not-yet-flushed duplicate must never match an older one.
  let count = -1, boundary = "";
  let fd: number | undefined;
  try {
    fd = openSync(source.file, "r");
    const before = fstatSync(fd);
    // A bounded tail is sufficient even for multi-gigabyte history files.
    const tailStart = Math.max(0, before.size - 65536);
    const tail = Buffer.alloc(before.size - tailStart);
    const length = readSync(fd, tail, 0, tail.length, tailStart);
    const after = fstatSync(fd);
    if (length === tail.length && before.size === after.size && before.mtimeMs === after.mtimeMs) {
      count = before.size;
      const last = records(tail, shell).at(-1);
      if (last && (tailStart === 0 || last.start > 0) && commandText(last.entry.text) === text && after.mtimeMs >= (capture.acceptedTs ?? capture.ts) * 1000 &&
        (last.entry.ts === null || Math.floor(last.entry.ts) === Math.floor(capture.ts))) count = tailStart + last.start;
      boundary = hash(salt, tail.subarray(Math.max(0, count - tailStart - 4096), count - tailStart));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") { count = 0; boundary = hash(salt, ""); }
    // Unreadable/unstable histories can still match by their own timestamps.
  } finally { if (fd !== undefined) closeSync(fd); }
  const maxEntries = loadConfig().analysis.maxEntries;
  tx(() => {
    const db = openDb();
    db.query(`INSERT INTO command_telemetry
      (command_hash, shell, history_file, ts, duration_sec, exit_code, cwd_hash, session_id, boundary_count, boundary_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(hash(salt, text), shell, source.file, capture.ts, capture.durationSec, capture.exitCode, hash(salt, capture.cwd), capture.sessionId, count, boundary);
    db.query("DELETE FROM command_telemetry WHERE id <= (SELECT MAX(id) FROM command_telemetry) - ?").run(maxEntries);
  });
}

interface Row {
  id: number; command_hash: string; ts: number; duration_sec: number; exit_code: number;
  cwd_hash: string; session_id: string; boundary_count: number; boundary_hash: string;
}

/** Enrich existing occurrences only; never invent entries from telemetry. */
export function enrichHistory(source: HistorySource, entries: HistoryEntry[]): HistoryEntry[] {
  if (!entries.length || (source as HistorySource & { kind?: string }).kind === "atuin") return entries;
  const rows = openDb().query<Row, [string, string]>(`SELECT id, command_hash, ts, duration_sec, exit_code, cwd_hash, session_id, boundary_count, boundary_hash
    FROM command_telemetry WHERE shell = ? AND history_file = ? ORDER BY ts, id`).all(source.shell, sourceFile(source.file));
  if (!rows.length) return entries;
  const salt = getMeta("installSalt");
  const hashes = entries.map(entry => hash(salt, commandText(entry.text)));
  const matches = new Map<number, Row>();
  const used = new Set<number>();
  // Timestamped duplicate groups are aligned only when occurrence counts agree;
  // sub-second timestamps never override a conflicting history timestamp.
  const timedEntries = new Map<string, number[]>();
  const timedRows = new Map<string, Row[]>();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.ts === null) continue;
    const key = hashes[index] + ":" + Math.floor(entry.ts);
    const group = timedEntries.get(key) ?? [];
    group.push(index); timedEntries.set(key, group);
  }
  for (const row of rows) {
    const key = row.command_hash + ":" + Math.floor(row.ts);
    const group = timedRows.get(key) ?? [];
    group.push(row); timedRows.set(key, group);
  }
  for (const [key, indexes] of timedEntries) {
    const group = timedRows.get(key);
    if (!group || indexes.length !== group.length || (group.length > 1 && new Set(group.map(row => row.session_id)).size > 1)) continue;
    if (indexes.some((index, position) => !Number.isInteger(entries[index]!.ts) && entries[index]!.ts !== group[position]!.ts)) continue;
    indexes.forEach((index, offset) => { matches.set(index, group[offset]!); used.add(group[offset]!.id); });
  }
  // The reader passes a bounded tail with re-numbered seq. Authenticate each
  // byte boundary, then translate full-file indexes into the selected tail.
  try {
    const bytes = readFileSync(source.file);
    const framed = records(bytes, source.shell);
    const all = framed.map(record => record.entry);
    const offset = all.length - entries.length;
    if (offset >= 0 && entries.every((entry, index) => commandText(entry.text) === commandText(all[index + offset]!.text) && entry.ts === all[index + offset]!.ts)) {
      const anchors = new Map<number, string>();
      // Even timestamped history has only second precision. Its byte boundary
      // disambiguates an unflushed newer duplicate started in the same second.
      for (const [index, row] of matches) {
        if (row.boundary_count < 0 || row.boundary_count > bytes.length) continue;
        const anchor = hash(salt, bytes.subarray(Math.max(0, row.boundary_count - 4096), row.boundary_count));
        anchors.set(row.boundary_count, anchor);
        if (anchor === row.boundary_hash && framed[index + offset]!.start < row.boundary_count) {
          matches.delete(index); used.delete(row.id);
        }
      }
      const positions = new Map<string, number[]>();
      all.forEach((entry, index) => {
        const key = hash(salt, commandText(entry.text));
        const group = positions.get(key) ?? [];
        group.push(index); positions.set(key, group);
      });
      const boundarySessions = new Map<string, string>();
      const ambiguous = new Set<string>();
      for (const row of rows) {
        const key = `${row.command_hash}:${row.boundary_count}:${row.boundary_hash}`;
        const previous = boundarySessions.get(key);
        if (previous !== undefined && previous !== row.session_id) ambiguous.add(key);
        boundarySessions.set(key, row.session_id);
      }
      const cursors = new Map<string, number>();
      for (const row of rows) {
        if (ambiguous.has(`${row.command_hash}:${row.boundary_count}:${row.boundary_hash}`)) continue;
        if (row.boundary_count < 0 || row.boundary_count > bytes.length) continue;
        let anchor = anchors.get(row.boundary_count);
        if (anchor === undefined) {
          anchor = hash(salt, bytes.subarray(Math.max(0, row.boundary_count - 4096), row.boundary_count));
          anchors.set(row.boundary_count, anchor);
        }
        if (anchor !== row.boundary_hash) continue;
        const group = positions.get(row.command_hash);
        if (!group) continue;
        let cursor = cursors.get(row.command_hash) ?? 0;
        while (cursor < group.length && framed[group[cursor]!]!.start < row.boundary_count) cursor++;
        const fullIndex = group[cursor];
        if (fullIndex === undefined) continue;
        const index = fullIndex - offset;
        const candidate = all[fullIndex]!;
        // Reserve this occurrence even if it is outside the selected tail.
        cursors.set(row.command_hash, cursor + 1);
        if (used.has(row.id) || index < 0 || matches.has(index) || candidate.ts !== null) continue;
        matches.set(index, row); used.add(row.id);
      }
    }
  } catch { /* A changed/unavailable history has no safe untimed alignment. */ }
  return entries.map((entry, index) => {
    const row = matches.get(index);
    return row ? { ...entry, ts: row.ts, durationSec: row.duration_sec, exitCode: row.exit_code, cwdHash: row.cwd_hash, sessionId: row.session_id } : entry;
  });
}
