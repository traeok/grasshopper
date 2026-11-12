import type { Command } from "commander";
import { withStateSnapshot } from "../core/db.ts";
import { resolveSource } from "../history/source.ts";
import { runAnalysis } from "../llm/analyze.ts";
import type { AnalysisStats } from "../profile/types.ts";
import { log } from "../core/log.ts";
import { PHRASES } from "../ui/art.ts";
import { renderRow } from "../ui/render.ts";
import { renderUnknownCommands } from "../ui/unknown-commands.ts";

export function printStats(stats: AnalysisStats): void {
  console.error(`Entries: ${stats.entries} · kept: ${stats.kept} · fresh: ${stats.fresh}`);
  console.error(`Drops: ${JSON.stringify(stats.dropped)}`);
  console.error(`Pseudonyms: ${JSON.stringify(stats.pseudonyms)}`);
  console.error(`Grammar skips: ${stats.grammarSkips} · payload bytes: ${stats.payloadBytes}`);
  console.error(renderUnknownCommands(stats.unknownCommands));
}
export function register(program: Command): void {
  program.command("analyze").description("Analyze a scrubbed summary of your shell history")
    .option("--dry-run", "Print request messages without saving or sending")
    .option("--yes", "Grant consent to send the scrubbed summary")
    .option("--background", "Run without prompts or terminal output")
    .option("--shell <bash|zsh|powershell>").option("--histfile <path>").option("--source <shell|atuin>", "History source (default: automatic detection)")
    .action(async (options: { source?: string; shell?: string; histfile?: string; dryRun?: boolean; yes?: boolean; background?: boolean }) => {
      const execute = async () => {
        const source = resolveSource({ ...options, persist: !options.dryRun });
        const result = await runAnalysis({ source, dryRun: !!options.dryRun, yes: !!options.yes, background: !!options.background, interactive: !!process.stdin.isTTY && !!process.stdout.isTTY });
        if ("messages" in result) {
          printStats(result.stats);
          console.log(JSON.stringify(result.messages, null, 2));
        } else if (!options.background) {
          for (const rec of result.added) console.log(renderRow(rec));
          console.log(result.added.length ? "ghop to review · ghop chat <id> · ghop accept <id>" : PHRASES.empty);
        }
      };
      try { if (options.dryRun) await withStateSnapshot(execute); else await execute(); }
      catch (error) { if (!options.background) throw error; log.warn("background-source-failed", { categories: [error instanceof Error ? error.name : "unknown"] }); }
    });
}
