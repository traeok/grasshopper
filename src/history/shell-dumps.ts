import { readFileSync, statSync } from "node:fs";
import { GhopError } from "../core/errors.ts";
import { shellDump } from "../core/paths.ts";
import type { Shell } from "./source.ts";
import { tokenize } from "./tokenize.ts";

export interface ShellDumps {
  aliases: { name: string; expansion: string }[];
  functions: string[];
  info: Record<string, string>;
  capturedAt: string | null;
}

function readOptional(file: string): string {
  try { return readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export function readShellDumps(shell: Shell): ShellDumps {
  const aliases: ShellDumps["aliases"] = [];
  const aliasText = readOptional(shellDump(shell, "aliases"));
  if (shell === "powershell" && aliasText.trim()) {
    let parsed: unknown;
    try { parsed = JSON.parse(aliasText); } catch { throw new GhopError("Invalid PowerShell alias snapshot. Open a new terminal to refresh it."); }
    if (!Array.isArray(parsed) || parsed.some(alias => !alias || typeof alias.name !== "string" || typeof alias.expansion !== "string")) {
      throw new GhopError("Invalid PowerShell alias snapshot. Open a new terminal to refresh it.");
    }
    for (const alias of parsed) aliases.push({ name: alias.name, expansion: alias.expansion });
  } else if (shell !== "powershell") {
    for (const line of aliasText.split(/\r?\n/)) {
      const match = /^alias (?:-g )?(?:-- )?([^=\s]+)=(.*)$/.exec(line);
      if (!match) continue;
      const expansion = tokenize(match[2]!).filter(token => token.kind === "word").map(word => word.value).join(" ");
      aliases.push({ name: match[1]!, expansion });
    }
  }
  const functions = [...new Set(readOptional(shellDump(shell, "functions")).split(/\r?\n/).map(name => name.trim()).filter(name =>
    name.length > 0 && !/^[_+.\-]/.test(name) && !name.includes("::") && !/^(?:omz_|prompt_|p10k|_p9k|starship_|zle-|__ghop)/.test(name),
  ))];
  const info: Record<string, string> = {};
  const file = shellDump(shell, "info");
  for (const line of readOptional(file).split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) Object.defineProperty(info, match[1]!, { value: match[2]!, enumerable: true, writable: true, configurable: true });
  }
  let capturedAt: string | null = null;
  try { capturedAt = statSync(file).mtime.toISOString(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { aliases, functions, info, capturedAt };
}
