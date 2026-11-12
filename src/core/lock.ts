import { closeSync, fstatSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname } from "node:path";
import { isoNow } from "./dates.ts";
import { ensureDir } from "./fsx.ts";
import { lockFile } from "./paths.ts";

export function tryLock(name: string, staleMs: number): (() => void) | null {
  const file = lockFile(name);
  ensureDir(dirname(file));
  for (;;) {
    let fd: number;
    try {
      fd = openSync(file, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(file).mtimeMs < staleMs) return null;
        unlinkSync(file);
      } catch (staleError) {
        if ((staleError as NodeJS.ErrnoException).code !== "ENOENT") throw staleError;
      }
      continue;
    }

    const claim = `${process.pid} ${isoNow()}`;
    let identity: Stats;
    try {
      writeFileSync(fd, claim, "utf8");
      identity = fstatSync(fd);
    } catch (error) {
      closeSync(fd);
      unlinkSync(file);
      throw error;
    }
    closeSync(fd);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        const current = statSync(file);
        if (current.dev === identity.dev && current.ino === identity.ino && readFileSync(file, "utf8") === claim) {
          unlinkSync(file);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    };
  }
}
