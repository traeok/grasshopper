import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { isoNow } from "./dates.ts";
import { logFile } from "./paths.ts";

// Metadata is restricted to counts, categories, IDs, and durations. Never pass
// history, literals, prompts, model output, or exception objects here.
export type LogMeta = Record<string, string | number | boolean | null | string[]>;
type Level = "info" | "warn" | "error";

function append(level: Level, msg: string, meta?: LogMeta): void {
  const line = JSON.stringify({ ...meta, at: isoNow(), level, msg }) + "\n";
  const file = logFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    if (statSync(file).size > 1_048_576) renameSync(file, `${file}.1`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
  if (process.env.GHOP_DEBUG === "1") process.stderr.write(line);
}

export const log = {
  info(msg: string, meta?: LogMeta): void { append("info", msg, meta); },
  warn(msg: string, meta?: LogMeta): void { append("warn", msg, meta); },
  error(msg: string, meta?: LogMeta): void { append("error", msg, meta); },
};
