import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig } from "../core/config.ts";
import { homeDir, toNativePath } from "../core/paths.ts";
import { getMeta, setMeta } from "../core/state.ts";
import { GhopError } from "../core/errors.ts";
import { parentPowerShellBinary, powerShellHistoryFile } from "../shell/powershell.ts";

export type Shell = "bash" | "zsh" | "powershell";
export interface HistorySource { shell: Shell; file: string }
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
export function resolveSource(options: { shell?: string; histfile?: string; persist?: boolean } = {}): HistorySource {
  if (options.shell && !["bash", "zsh", "powershell"].includes(options.shell)) throw new GhopError("Shell must be bash, zsh, or powershell.");
  if (process.env.GHOP_SHELL && !["bash", "zsh", "powershell"].includes(process.env.GHOP_SHELL)) throw new GhopError("GHOP_SHELL must be bash, zsh, or powershell.");
  const cfg = loadConfig();
  const last = getMeta("lastSource");
  const explicitShell = options.shell ?? process.env.GHOP_SHELL;
  let shell = (explicitShell ?? cfg.history.shell ?? last?.shell ?? detectShell()) as Shell | null;
  const explicitFile = options.histfile ?? process.env.GHOP_HISTFILE;
  let file = explicitFile ?? cfg.history.file ?? (explicitShell ? null : last?.file);
  if (!shell) {
    if (existsSync(defaultHistoryFile("zsh"))) shell = "zsh";
    else if (existsSync(defaultHistoryFile("bash"))) shell = "bash";
    else if (existsSync(defaultHistoryFile("powershell"))) shell = "powershell";
  }
  if (!shell) throw new GhopError("No shell history found. Run `ghop setup` or `ghop config set history.file <path>`.");
  file = file ? toNativePath(file) : defaultHistoryFile(shell);
  const source = { shell, file };
  if (options.persist !== false && (explicitShell || explicitFile)) setMeta("lastSource", source);
  return source;
}
