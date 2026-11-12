import type { Command } from "commander";
import { GhopError } from "../core/errors.ts";
import { tx } from "../core/db.ts";
import { getRec, updateRec } from "../recs/store.ts";
import { ToolRef } from "../llm/schema.ts";
import { removeBlock, writeReload } from "../apply/managed.ts";
import { confirm } from "../ui/prompts.ts";
import { parseRecommendationId } from "./list.ts";

export async function runUndo(id: number, options: { yes?: boolean } = {}): Promise<void> {
  const rec = getRec(id);
  const applied = rec.applied;
  if (!applied) throw new GhopError(`Nothing to undo for #${id}.`);
  const names = [...applied.aliasNames, ...applied.functionNames];
  if (names.some(name => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name))) throw new GhopError("Stored shell names are invalid; remove the managed block manually.");
  const cleanup = [
    ...applied.aliasNames.map(name => applied.shell === "powershell"
      ? `Remove-Item -LiteralPath 'Alias:${name}' -Force -ErrorAction SilentlyContinue`
      : `unalias ${name} 2>/dev/null`),
    ...applied.functionNames.map(name => applied.shell === "powershell"
      ? `Remove-Item -LiteralPath 'Function:${name}' -Force -ErrorAction SilentlyContinue`
      : `unset -f ${name} 2>/dev/null`),
  ];
  if (applied.kind === "install") {
    const field = applied.manager === "npm" ? "npmPackage" : applied.manager === "winget" ? "wingetId" : "brewFormula";
    if (!ToolRef.safeParse({ name: "undo", [field]: applied.id }).success) throw new GhopError("Stored install identifier is invalid; uninstall it manually.");
    const argv = applied.manager === "winget" ? ["winget", "uninstall", "--id", applied.id, "--exact"] : applied.manager === "npm" ? ["npm", "uninstall", "--global", applied.id] : ["brew", "uninstall", applied.id];
    console.log(argv.join(" "));
    if (!options.yes && !await confirm({ message: "Uninstall this tool?", initialValue: false })) return;
    const proc = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });
    const code = await proc.exited;
    if (code !== 0) throw new GhopError(`${applied.manager} exited with ${code}`);
    tx(() => {
      if (applied.initBlock) { removeBlock(applied.shell, id); writeReload(applied.shell, cleanup); }
      updateRec(id, { status: "accepted", acceptMode: "self", applied: null });
    });
  } else {
    tx(() => {
      removeBlock(applied.shell, id);
      writeReload(applied.shell, cleanup);
      updateRec(id, { status: "accepted", acceptMode: "self", applied: null });
    });
  }
  console.log(`Undone #${id}. Recommendation kept as accepted.`);
}
export function register(program: Command): void {
  program.command("undo <id>").description("Undo a grasshopper-managed change")
    .option("--yes", "Confirm uninstall without prompting")
    .action(async (id: string, options: { yes?: boolean }) => { await runUndo(parseRecommendationId(id), options); });
}
