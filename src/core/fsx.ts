import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ZodType } from "zod";
import { log } from "./log.ts";
import { AsyncLocalStorage } from "node:async_hooks";

const readOnlyFiles = new AsyncLocalStorage<boolean>();
export function withReadOnlyFiles<T>(fn: () => T): T {
  return readOnlyFiles.run(true, fn);
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function readJson<T>(file: string, schema: ZodType<T>, fallback: T): T {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    if (readOnlyFiles.getStore()) return fallback;
    renameSync(file, `${file}.corrupt-${Date.now()}`);
    log.warn("config-corrupt");
    return fallback;
  }
}

const retryWait = new Int32Array(new SharedArrayBuffer(4));

export function writeTextAtomic(file: string, text: string): void {
  ensureDir(dirname(file));
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
    for (let retries = 0; ; retries++) {
      try {
        renameSync(temporary, file);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if ((code !== "EPERM" && code !== "EBUSY") || retries >= 5) throw error;
        Atomics.wait(retryWait, 0, 0, 50);
      }
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
