import type { Command } from "commander";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "../core/config.ts";
import { localDate } from "../core/dates.ts";
import { writeTextAtomic } from "../core/fsx.ts";
import { tryLock } from "../core/lock.ts";
import { log } from "../core/log.ts";
import { dailyStamp, initFile, lockFile } from "../core/paths.ts";
import { getMeta } from "../core/state.ts";
import { listRecs } from "../recs/store.ts";
import { renderBanner } from "../ui/render.ts";
import { INIT_VERSION, writeInitFile } from "../shell/init.ts";

export function spawnBackground(): void {
  spawn(process.execPath, [Bun.main, "analyze", "--background"], { detached: true, stdio: "ignore", windowsHide: true, env: process.env }).unref();
}
export async function runDaily(deps: { spawnBackground?: () => void; now?: () => Date } = {}): Promise<void> {
  try {
    const now = (deps.now ?? (() => new Date()))();
    const today = localDate(now);
    // Kept for the day: releasing this claim would let a second terminal repeat the banner.
    if (!tryLock(`daily-${today}`, 36 * 3_600_000)) return;
    const directory = dirname(lockFile("daily"));
    for (const file of readdirSync(directory)) {
      if (!/^daily-\d{4}-\d{2}-\d{2}\.lock$/.test(file)) continue;
      const path = join(directory, file);
      try { if (now.getTime() - statSync(path).mtimeMs > 3 * 86400_000) unlinkSync(path); } catch { /* Another shell may prune it first. */ }
    }
    writeTextAtomic(dailyStamp(), today + "\n");
    const shell = process.env.GHOP_SHELL;
    if (shell === "bash" || shell === "zsh" || shell === "powershell") {
      const file = initFile(shell);
      if (!existsSync(file) || !readFileSync(file, "utf8").replace(/^\uFEFF/, "").split("\n", 1)[0]?.startsWith(`# ghop-init v${INIT_VERSION} `)) writeInitFile(shell);
    }
    const config = loadConfig();
    const pending = listRecs({ status: "new" });
    const error = getMeta("lastAnalysisError");
    if (config.daily.enabled && (pending.length || error)) console.log(renderBanner(pending, pending.length, error));
    const last = getMeta("lastAnalysisAt");
    if (config.analysis.auto && getMeta("consent")?.granted && (last === null || now.getTime() - Date.parse(last) >= config.analysis.minIntervalHours * 3_600_000)) (deps.spawnBackground ?? spawnBackground)();
  } catch (error) {
    try { log.warn("daily-failed", { categories: [error instanceof Error ? error.name : "unknown"] }); } catch { /* Shell startup must never fail. */ }
  }
}
export function register(program: Command): void {
  program.command("daily", { hidden: true }).action(async () => { await runDaily(); });
}
