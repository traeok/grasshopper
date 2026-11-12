import type { Command } from "commander";
import { readFileSync, unlinkSync } from "node:fs";
import { freshFlag } from "../core/paths.ts";
import { log } from "../core/log.ts";
import { PHRASES, mark } from "../ui/art.ts";
import { bold, leaf } from "../ui/style.ts";

export function runNotify(): void {
  try {
    const count = Number(readFileSync(freshFlag(), "utf8").trim());
    if (Number.isSafeInteger(count) && count > 0) console.log(`${mark()} ${leaf(bold("grasshopper"))} · ${PHRASES.fresh(count)}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      try { log.warn("notify-failed", { categories: [error instanceof Error ? error.name : "unknown"] }); } catch { /* Never block a prompt. */ }
    }
  } finally { try { unlinkSync(freshFlag()); } catch { /* Another prompt may consume it first. */ } }
}
export function register(program: Command): void {
  program.command("notify", { hidden: true }).action(runNotify);
}
