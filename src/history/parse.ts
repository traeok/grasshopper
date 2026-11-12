import { GhopError } from "../core/errors.ts";
import type { HistorySource } from "./source.ts";
import { readAtuinHistory } from "./atuin.ts";
import { enrichHistory } from "./telemetry.ts";

export interface HistoryEntry {
  text: string;
  ts: number | null;
  durationSec: number | null;
  seq: number;
  exitCode?: number | null;
  cwdHash?: string | null;
  sessionId?: string | null;
}

function decodedLines(bytes: Uint8Array): string[] {
  const lines = new TextDecoder("utf-8", { fatal: false }).decode(bytes).split("\n");
  // A final line terminator does not contribute an extra command or multiline line.
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
}

export function parseBash(bytes: Uint8Array): HistoryEntry[] {
  const lines = decodedLines(bytes);
  const entries: HistoryEntry[] = [];
  const timestamp = /^#\d{9,11}$/;
  const timestamped = lines.some((line) => timestamp.test(line));
  let pending: { ts: number; lines: string[] } | null = null;

  const append = (text: string, ts: number | null) => {
    if (text.length > 0) entries.push({ text, ts, durationSec: null, seq: entries.length });
  };
  const flush = () => {
    if (pending) append(pending.lines.join("\n"), pending.ts);
  };

  for (const line of lines) {
    if (timestamped && timestamp.test(line)) {
      flush();
      pending = { ts: Number(line.slice(1)), lines: [] };
    } else if (pending) {
      pending.lines.push(line);
    } else {
      append(line, null);
    }
  }
  flush();
  return entries;
}

export function unmetafy(bytes: Uint8Array): Uint8Array {
  const decoded = new Uint8Array(bytes.length);
  let length = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    if (byte === 0x83 && i + 1 < bytes.length) {
      decoded[length++] = bytes[++i]! ^ 0x20;
    } else {
      // Retain a dangling marker for non-fatal UTF-8 decoding rather than losing data.
      decoded[length++] = byte;
    }
  }
  return decoded.subarray(0, length);
}

export function parseZsh(bytes: Uint8Array): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  let logical = "";
  let continued = false;
  const append = (line: string) => {
    if (line.length === 0) return;
    const extended = /^: (\d{9,11}):(\d+);([\s\S]*)$/.exec(line);
    entries.push({
      text: extended ? extended[3]! : line,
      ts: extended ? Number(extended[1]) : null,
      durationSec: extended ? Number(extended[2]) : null,
      seq: entries.length,
    });
  };

  for (const line of decodedLines(unmetafy(bytes))) {
    logical += line;
    const trailingSlashes = /\\+$/.exec(line)?.[0].length ?? 0;
    continued = trailingSlashes % 2 === 1;
    if (continued) {
      logical = logical.slice(0, -1) + "\n";
    } else {
      append(logical);
      logical = "";
    }
  }
  if (continued) append(logical);
  return entries;
}

export function parsePowerShell(bytes: Uint8Array): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  let logical = "";
  for (const line of decodedLines(bytes)) {
    // PSReadLine appends one marker to *every* embedded newline. It is not
    // shell escaping: even a run of two backticks still continues the record.
    const continued = line.endsWith("`");
    logical += continued ? line.slice(0, -1) + "\n" : line;
    if (!continued) {
      if (logical.length) entries.push({ text: logical, ts: null, durationSec: null, seq: entries.length });
      logical = "";
    }
  }
  if (logical.length) entries.push({ text: logical, ts: null, durationSec: null, seq: entries.length });
  return entries;
}

export async function readHistory(source: HistorySource, maxEntries: number): Promise<HistoryEntry[]> {
  if (source.kind === "atuin") return readAtuinHistory(source.file, maxEntries);
  let bytes: Uint8Array;
  try {
    bytes = await Bun.file(source.file).bytes();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GhopError(`History file not found: ${source.file}`);
    }
    throw error;
  }
  const entries = source.shell === "bash" ? parseBash(bytes) : source.shell === "powershell" ? parsePowerShell(bytes) : parseZsh(bytes);
  return enrichHistory(source, entries.slice(Math.max(0, entries.length - maxEntries)).map((entry, seq) => ({ ...entry, seq })));
}
