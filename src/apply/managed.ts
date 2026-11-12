import { readFileSync } from "node:fs";
import { localDate } from "../core/dates.ts";
import { writeTextAtomic } from "../core/fsx.ts";
import { managedFile, reloadFile, toShellPath } from "../core/paths.ts";
import type { Shell } from "../history/source.ts";
import type { StoredRecommendation } from "../recs/store.ts";
import { powerShellNames } from "./shells.ts";

export const MANAGED_HEADER = "# grasshopper managed file. Changes come from `ghop accept` / `ghop undo`; edits outside ghop blocks are kept.";

type BlockRecommendation = Pick<StoredRecommendation, "id" | "key">;

function readManaged(shell: Shell): string {
  try {
    return readFileSync(managedFile(shell), "utf8").replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function blockPattern(recId: number): RegExp {
  return new RegExp(`^# >>> ghop #${recId} [^\\n]* >>>\\n[\\s\\S]*?^# <<< ghop #${recId} <<<(?:\\n|$)`, "gm");
}

/** Read and render without writing, so callers can syntax-check before committing. */
export function renderManaged(shell: Shell, rec: BlockRecommendation, lines: string[]): string {
  let content = readManaged(shell);
  const block = `# >>> ghop #${rec.id} ${rec.key} (${localDate()}) >>>\n${lines.join("\n").replaceAll("\r\n", "\n")}\n# <<< ghop #${rec.id} <<<\n`;
  let replaced = false;
  content = content.replace(blockPattern(rec.id), () => {
    if (replaced) return "";
    replaced = true;
    return block;
  });
  if (!content.startsWith(MANAGED_HEADER + "\n")) {
    content = MANAGED_HEADER + "\n" + content;
  }
  if (!replaced) {
    if (!content.endsWith("\n")) content += "\n";
    content += block;
  }
  return shell === "powershell" ? "\uFEFF" + content : content;
}

export function upsertBlock(shell: Shell, rec: BlockRecommendation, lines: string[]): void {
  writeTextAtomic(managedFile(shell), renderManaged(shell, rec, lines));
}

export function removeBlock(shell: Shell, recId: number): void {
  const content = readManaged(shell);
  const next = content.replace(blockPattern(recId), "");
  if (next !== content) writeTextAtomic(managedFile(shell), (shell === "powershell" ? "\uFEFF" : "") + next);
}

export function writeReload(shell: Shell, prefixLines: string[]): void {
  const nativePath = toShellPath(managedFile(shell), shell);
  const path = nativePath.replaceAll("'", shell === "powershell" ? "''" : "'\\''");
  const lines = [...prefixLines, `${shell === "powershell" ? "." : "source"} '${path}'`];
  if (shell === "powershell") {
    const names = powerShellNames(readManaged(shell));
    for (const name of names.functionNames) {
      lines.push(`if (Test-Path -LiteralPath 'Function:${name}') { Set-Item -LiteralPath 'Function:global:${name}' -Value (Get-Item -LiteralPath 'Function:${name}').ScriptBlock }`);
    }
    for (const name of names.aliasNames) {
      lines.push(`if (Test-Path -LiteralPath 'Alias:${name}') { Set-Alias -Scope Global -Name '${name}' -Value (Get-Item -LiteralPath 'Alias:${name}').Definition -Force }`);
    }
  }
  writeTextAtomic(reloadFile(shell), (shell === "powershell" ? "\uFEFF" : "") + lines.join("\n").replaceAll("\r\n", "\n") + "\n");
}
