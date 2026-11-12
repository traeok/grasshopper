import type { Command } from "commander";
import { loadConfig } from "../core/config.ts";
import { GhopError } from "../core/errors.ts";
import { detectShell } from "../history/source.ts";
import { readShellDumps } from "../history/shell-dumps.ts";
import { detectEnvironment } from "../profile/environment.ts";
import { getRec, updateRec } from "../recs/store.ts";
import { loadPseudonyms } from "../recs/pseudonyms.ts";
import { automationStatus, previewAction, applyAction } from "../apply/actions.ts";
import { syntaxCheck } from "../apply/shells.ts";
import { renderCard } from "../ui/render.ts";
import { confirm, select } from "../ui/prompts.ts";
import { dim } from "../ui/style.ts";
import { PHRASES } from "../ui/art.ts";
import { parseRecommendationId } from "./list.ts";
import { runChat } from "./chat.ts";

export async function runAccept(id: number, options: { mode?: string; yes?: boolean } = {}): Promise<void> {
  const rec = getRec(id);
  const shell = detectShell() ?? rec.shell;
  const dumps = readShellDumps(shell);
  const ctx = { shell, env: detectEnvironment(shell, dumps), aliases: dumps.aliases, map: loadPseudonyms(rec.analysisId) };
  const availability = automationStatus(rec, ctx);
  let mode = options.mode;
  if (mode && !["self", "guided", "auto"].includes(mode)) throw new GhopError("Mode must be self, guided, or auto.");
  if (!mode && process.stdin.isTTY && process.stdout.isTTY) {
    if (!availability.ok) console.log(dim(`Automatic change unavailable: ${availability.reason}`));
    const choices = [{ value: "self", label: "Do it myself" }, { value: "guided", label: "Guide me with smol" }];
    if (availability.ok) choices.push({ value: "auto", label: "Do it for me" });
    const configured = loadConfig().automation.defaultMode;
    mode = await select({ message: "How would you like to implement it?", options: choices, initialValue: choices.some(c => c.value === configured) ? configured : "self" });
  }
  mode ??= "self";
  if (mode === "self") {
    updateRec(id, { status: "accepted", acceptMode: "self" });
    console.log(renderCard(getRec(id), ctx.map));
    console.log(`When you're done: ghop done ${id}`);
    return;
  }
  if (mode === "guided") {
    updateRec(id, { status: "accepted", acceptMode: "guided" });
    await runChat(id, "guide");
    return;
  }
  if (!availability.ok) throw new GhopError(availability.reason);
  const preview = previewAction(rec, ctx);
  if (preview.argv) console.log(preview.argv.join(" "));
  for (const line of preview.lines) console.log(line);
  for (const warning of preview.warnings) console.log(`Warning: ${warning}`);
  if (preview.lines.length) {
    const check = syntaxCheck(shell, preview.lines.join("\n") + "\n");
    if (!check.ok) throw new GhopError(`Syntax check failed: ${check.stderr}`);
    if (check.skipped) console.log(`(syntax check skipped: ${shell} not found)`);
  }
  if (!options.yes && !await confirm({ message: "Apply this change?", initialValue: false })) return;
  const applied = await applyAction(rec, preview, shell);
  updateRec(id, { status: "implemented", acceptMode: "auto", applied });
  console.log(PHRASES.done);
  if (applied?.kind === "managed" && rec.action?.type === "snippet" && !applied.aliasNames.length && !applied.functionNames.length) console.log("Open a new terminal to pick it up.");
  else if (process.env.GHOP_SHELL) console.log("Active in this shell now.");
  else console.log("Open a new terminal to use it.");
}
export function register(program: Command): void {
  program.command("accept <id>").description("Accept and optionally implement a recommendation")
    .option("--mode <self|guided|auto>").option("--yes", "Confirm the exact automatic change")
    .action(async (id: string, options: { mode?: string; yes?: boolean }) => { await runAccept(parseRecommendationId(id), options); });
}
