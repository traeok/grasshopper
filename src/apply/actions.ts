import { loadConfig } from "../core/config.ts";
import { isoNow } from "../core/dates.ts";
import { tx } from "../core/db.ts";
import { GhopError } from "../core/errors.ts";
import { writeTextAtomic } from "../core/fsx.ts";
import { managedFile } from "../core/paths.ts";
import type { Shell } from "../history/source.ts";
import { tokenize } from "../history/tokenize.ts";
import { Action, ToolRef } from "../llm/schema.ts";
import type { PseudonymMap } from "../privacy/pseudonyms.ts";
import type { Profile } from "../profile/types.ts";
import { depseudonymizeForShell } from "../recs/pseudonyms.ts";
import type { StoredRecommendation } from "../recs/store.ts";
import { renderManaged, writeReload } from "./managed.ts";
import { findShellBinary, powerShellNames, renderAlias, syntaxCheck } from "./shells.ts";

export interface AutomationContext {
  shell: Shell;
  env: Profile["environment"];
  map: PseudonymMap;
  aliases?: readonly { name: string; expansion: string }[];
}
export interface ActionPreview {
  lines: string[];
  argv?: string[];
  warnings: string[];
}
export type AutomationStatus = { ok: true } | { ok: false; reason: string };

const reservedAliases: Record<string, true> = Object.fromEntries(
  "if then else elif fi case esac for while until do done in function select time coproc { } [[ ]] ! cd alias unalias source export exit return set unset eval exec builtin command"
    .split(" ").map((name) => [name, true as const]),
);
const riskyPatterns = [
  /\brm\s+-[a-zA-Z]*[rf]/,
  /\bsudo\b/,
  /\b(curl|wget)\b[^|]*\|\s*\w*sh\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /:\(\)\s*\{/,
  /chmod\s+(-R\s+)?777/,
  />\s*\/dev\/sd/,
  /\beval\s+"?\$\((curl|wget)/,
  /git\s+push\b.*--force(?!-with-lease)/,
  /\b(?:Remove-Item|del|erase|rd|rmdir|ri|rm)\b[^\n;|]*-(?:Recurse|Force|[rf])\b/i,
  /\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm|curl|wget)\b[^\n|]*\|\s*(?:Invoke-Expression|iex|powershell|pwsh)\b/i,
  /\b(?:Invoke-Expression|iex)\b/i,
  /\bStart-Process\b[^\n;|]*-Verb\s+['"]?RunAs\b/i,
  /\b(?:Format-Volume|Clear-Disk|Initialize-Disk)\b/i,
];

function requireSafeLines(lines: readonly string[]): void {
  for (const line of lines) {
    if (riskyPatterns.some((pattern) => pattern.test(line))) {
      throw new GhopError("Contains a risky construct; review and apply it yourself.");
    }
  }
}

function validatedAction(rec: StoredRecommendation): Action {
  if (!rec.action) throw new GhopError("This recommendation has no automatic change.");
  const parsed = Action.safeParse(rec.action);
  if (!parsed.success) throw new GhopError("This recommendation has an invalid automatic change.");
  if (parsed.data.type === "alias" && Object.hasOwn(reservedAliases, parsed.data.name)) {
    throw new GhopError(`Alias name ${parsed.data.name} is reserved; choose another name.`);
  }
  return parsed.data;
}

function installArgv(rec: StoredRecommendation, action: Extract<Action, { type: "install" }>): string[] {
  const identifier = action.manager === "winget" ? "wingetId" : action.manager === "npm" ? "npmPackage" : "brewFormula";
  const tool = ToolRef.safeParse(rec.tool);
  if (!tool.success || tool.data[identifier] !== action.id) {
    throw new GhopError("Install identifier does not match the verified tool.");
  }
  if (rec.tool?.verification.checks[action.manager] !== "verified"
    || (action.manager === "brew" && rec.tool.verification.checks.github !== "verified")) {
    throw new GhopError(`The ${action.manager} package has not been verified for automatic installation.`);
  }
  switch (action.manager) {
    case "winget": return ["winget", "install", "--id", action.id, "--exact", "--source", "winget"];
    case "npm": return ["npm", "install", "--global", action.id];
    case "brew": return ["brew", "install", action.id];
  }
}

function requireInstallManager(manager: Extract<Action, { type: "install" }>["manager"]): void {
  if (manager === "winget" && process.platform !== "win32") {
    throw new GhopError("winget automatic installation requires Windows.");
  }
  if (!Bun.which(manager)) throw new GhopError(`${manager} is not installed or not on PATH.`);
}

function prepareAction(rec: StoredRecommendation, ctx: AutomationContext): { action: Action; lines: string[]; argv?: string[] } {
  if (!loadConfig().automation.enabled) throw new GhopError("Automation is disabled (automation.enabled=false).");
  const action = validatedAction(rec);
  if ((action.type === "snippet" || (action.type === "install" && action.initLines.length > 0)
    || (action.type === "alias" && (rec.shell === "powershell" || ctx.shell === "powershell"))) && rec.shell !== ctx.shell) {
    throw new GhopError(`Written for ${rec.shell}; open ${rec.shell} to apply it automatically.`);
  }
  const resolve = (line: string): string => depseudonymizeForShell(line, ctx.map, ctx.shell);
  switch (action.type) {
    case "alias": {
      const command = resolve(action.command);
      requireSafeLines([command]);
      return { action, lines: renderAlias(ctx.shell, action.name, command) };
    }
    case "snippet": {
      const lines = resolve(action.lines.join("\n")).split("\n");
      requireSafeLines(lines);
      return { action, lines };
    }
    case "install": {
      const lines = action.initLines.length ? resolve(action.initLines.join("\n")).split("\n") : [];
      requireSafeLines(lines);
      const argv = installArgv(rec, action);
      requireInstallManager(action.manager);
      return { action, lines, argv };
    }
  }
}

export function automationStatus(rec: StoredRecommendation, ctx: AutomationContext): AutomationStatus {
  try {
    prepareAction(rec, ctx);
    return { ok: true };
  } catch (error) {
    if (error instanceof GhopError) return { ok: false, reason: error.message };
    throw error;
  }
}

export function previewAction(rec: StoredRecommendation, ctx: AutomationContext): ActionPreview {
  const { action, lines, argv } = prepareAction(rec, ctx);
  const warnings: string[] = [];
  if (action.type === "alias") {
    if (ctx.aliases?.some((alias) => alias.name === action.name)) warnings.push(`overrides existing alias ${action.name}`);
    const binary = Bun.which(action.name);
    if (binary) warnings.push(`shadows command ${binary}`);
  }
  if (lines.length > 0 && !findShellBinary(ctx.shell)) warnings.push(`(syntax check skipped: ${ctx.shell} not found)`);
  return { lines, ...(argv ? { argv } : {}), warnings };
}

function checkedManagedContent(shell: Shell, rec: StoredRecommendation, lines: string[]): string {
  const content = renderManaged(shell, rec, lines);
  const result = syntaxCheck(shell, content);
  if (!result.ok) throw new GhopError(`Syntax check failed: ${result.stderr}`);
  return content;
}

function applyManaged(shell: Shell, rec: StoredRecommendation, lines: string[]): void {
  tx(() => {
    const content = checkedManagedContent(shell, rec, lines);
    writeTextAtomic(managedFile(shell), content);
    writeReload(shell, []);
  });
}

/** Track static definitions, not words hidden inside quoted command bodies. */
function introducedNames(lines: readonly string[], shell: Shell): { aliasNames: string[]; functionNames: string[] } {
  if (shell === "powershell") return powerShellNames(lines.join("\n"));
  const aliasNames = new Set<string>();
  const functionNames = new Set<string>();
  const namePattern = /^[A-Za-z_][A-Za-z0-9_-]*$/;
  for (const line of lines) {
    const tokens = tokenize(line);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.kind !== "word" || token.quoted || token.expansion) continue;
      const previous = tokens[i - 1];
      const commandStart = !previous || previous.kind === "op" || ["{", "}", "then", "do", "else"].includes(previous.value);
      if (!commandStart) continue;
      if (token.value === "alias") {
        for (const arg of tokens.slice(i + 1)) {
          if (arg.kind === "op") break;
          const name = /^([A-Za-z_][A-Za-z0-9_-]*)=/.exec(arg.value)?.[1];
          if (name) aliasNames.add(name);
        }
      } else if (token.value === "function") {
        const name = tokens[i + 1];
        if (name?.kind === "word" && !name.quoted && namePattern.test(name.value)) functionNames.add(name.value);
      } else if (namePattern.test(token.value) && tokens[i + 1]?.value === "(" && tokens[i + 2]?.value === ")") {
        functionNames.add(token.value);
      }
    }
  }
  return { aliasNames: [...aliasNames], functionNames: [...functionNames] };
}

/** Only fixed, registry-verified install argv is executed; shell changes are written, never evaluated. */
export async function applyAction(rec: StoredRecommendation, preview: ActionPreview, shell: Shell): Promise<NonNullable<StoredRecommendation["applied"]>> {
  if (!loadConfig().automation.enabled) throw new GhopError("Automation is disabled (automation.enabled=false).");
  const action = validatedAction(rec);
  if ((action.type === "snippet" || (action.type === "install" && action.initLines.length > 0)
    || (action.type === "alias" && (rec.shell === "powershell" || shell === "powershell"))) && rec.shell !== shell) {
    throw new GhopError(`Written for ${rec.shell}; open ${rec.shell} to apply it automatically.`);
  }
  // Recheck the exact approved lines immediately before any side effect.
  for (const line of preview.lines) depseudonymizeForShell(line, {}, shell);
  requireSafeLines(preview.lines);
  if (action.type === "install") {
    const argv = installArgv(rec, action);
    requireInstallManager(action.manager);
    if (JSON.stringify(preview.argv) !== JSON.stringify(argv)) throw new GhopError("Install preview no longer matches the verified command.");
    if (preview.lines.length > 0) tx(() => { checkedManagedContent(shell, rec, preview.lines); });
    const child = Bun.spawn({ cmd: argv, stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });
    const code = await child.exited;
    if (code !== 0) throw new GhopError(`${action.manager} exited with ${code}`);
    if (preview.lines.length > 0) applyManaged(shell, rec, preview.lines);
    return { at: isoNow(), kind: "install", shell, argv, manager: action.manager, id: action.id, initBlock: preview.lines.length > 0, ...introducedNames(preview.lines, shell) };
  }
  applyManaged(shell, rec, preview.lines);
  return { at: isoNow(), kind: "managed", shell, ...introducedNames(preview.lines, shell) };
}
