import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig } from "../core/config.ts";
import { homeDir, toNativePath } from "../core/paths.ts";
import { getMeta, setMeta } from "../core/state.ts";
import { GhopError } from "../core/errors.ts";
import { parentPowerShellBinary, powerShellHistoryFile } from "../shell/powershell.ts";

export type Shell = "bash" | "zsh" | "powershell";
export interface HistorySource { shell: Shell; file: string; kind?: "atuin" }
export function detectShell(): Shell | null {
  if (process.env.GHOP_SHELL === "bash" || process.env.GHOP_SHELL === "zsh" || process.env.GHOP_SHELL === "powershell") return process.env.GHOP_SHELL;
  if (parentPowerShellBinary()) return "powershell";
  const shell = basename((process.env.SHELL ?? "").replaceAll("\\", "/")).replace(/\.exe$/i, "").toLowerCase();
  if (shell === "pwsh" || shell === "powershell") return "powershell";
  if (shell === "bash" || shell === "zsh") return shell;
  return process.env.MSYSTEM ? "bash" : null;
}
export function defaultHistoryFile(shell: Shell): string {
  if (shell === "powershell") return powerShellHistoryFile();
  return join(shell === "zsh" && process.env.ZDOTDIR ? toNativePath(process.env.ZDOTDIR) : homeDir(), `.${shell}_history`);
}
export function defaultAtuinFile(): string {
  return toNativePath(process.env.ATUIN_DB_PATH ?? join(process.env.XDG_DATA_HOME ? toNativePath(process.env.XDG_DATA_HOME) : join(homeDir(), ".local", "share"), "atuin", "history.db"));
}
export function resolveSource(options: { source?: string; shell?: string; histfile?: string; persist?: boolean } = {}): HistorySource {
  if (options.source !== undefined && options.source !== "shell" && options.source !== "atuin") throw new GhopError("Source must be shell or atuin.");
  if (options.shell && !["bash", "zsh", "powershell"].includes(options.shell)) throw new GhopError("Shell must be bash, zsh, or powershell.");
  if (process.env.GHOP_SHELL && !["bash", "zsh", "powershell"].includes(process.env.GHOP_SHELL)) throw new GhopError("GHOP_SHELL must be bash, zsh, or powershell.");
  const cfg = loadConfig();
  const last = getMeta("lastSource");
  const explicitShell = options.shell ?? process.env.GHOP_SHELL;
  let shell = (explicitShell ?? cfg.history.shell ?? last?.shell ?? detectShell()) as Shell | null;
  const selection = options.source ?? cfg.history.source;
  const shellFile = options.histfile ?? process.env.GHOP_HISTFILE ?? (cfg.history.source !== "atuin" ? cfg.history.file : null);
  // Hooks export both values on every prompt, even when Atuin is installed.
  // Only an independent environment override counts as an explicit custom path.
  const customShellFile = options.histfile ?? (cfg.history.source !== "atuin" ? cfg.history.file : null) ?? (!process.env.GHOP_SHELL ? process.env.GHOP_HISTFILE : null);
  const rememberedShell = !explicitShell && last && !last.kind ? last : null;
  const rememberedAtuin = last?.kind === "atuin" ? last : null;
  const atuinFile = defaultAtuinFile();
  const kind = selection === "atuin" || (selection === "auto" && !customShellFile &&
    !(rememberedShell && rememberedShell.file !== defaultHistoryFile(rememberedShell.shell)) &&
    (rememberedAtuin || existsSync(atuinFile))) ? "atuin" : undefined;
  let file = kind === "atuin"
    ? options.histfile ?? (cfg.history.source === "atuin" ? cfg.history.file : null) ?? (process.env.ATUIN_DB_PATH ? atuinFile : rememberedAtuin?.file) ?? atuinFile
    : shellFile ?? rememberedShell?.file;
  if (!shell) {
    if (existsSync(defaultHistoryFile("zsh"))) shell = "zsh";
    else if (existsSync(defaultHistoryFile("bash"))) shell = "bash";
    else if (existsSync(defaultHistoryFile("powershell"))) shell = "powershell";
  }
  // Atuin stores commands independently of the active shell; the shell still
  // supplies the tokenizer/environment dialect when no shell history exists.
  if (!shell && kind === "atuin") shell = process.platform === "win32" ? "powershell" : "bash";
  if (!shell) throw new GhopError("No shell history found. Run `ghop setup` or `ghop config set history.file <path>`.");
  file = file ? toNativePath(file) : defaultHistoryFile(shell);
  const source: HistorySource = kind ? { shell, file, kind } : { shell, file };
  if (options.persist !== false && (options.source || explicitShell || options.histfile || process.env.GHOP_HISTFILE)) setMeta("lastSource", source);
  return source;
}
