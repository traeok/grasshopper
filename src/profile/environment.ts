import { readFileSync } from "node:fs";
import type { ShellDumps } from "../history/shell-dumps.ts";
import type { Shell } from "../history/source.ts";
import { PACKAGE_MANAGER_PROBES, TOOL_PROBES } from "../privacy/dictionary.ts";
import type { Profile } from "./types.ts";

export function detectEnvironment(shell: Shell, dumps: ShellDumps, which: (name: string) => string | null = Bun.which): Profile["environment"] {
  const { info } = dumps;
  let platform: Profile["environment"]["platform"] = process.platform === "darwin" ? "macos" : process.platform === "win32" ? shell === "bash" ? "windows-gitbash" : "windows" : "linux";
  if (process.platform === "linux") {
    try { if (/microsoft/i.test(readFileSync("/proc/version", "utf8"))) platform = "wsl"; }
    catch { /* A missing procfs does not prevent environment detection. */ }
  }
  const frameworks: Profile["environment"]["frameworks"] = [];
  if (info.OMZ === "1") frameworks.push("oh-my-zsh");
  if (info.STARSHIP === "1") frameworks.push("starship");
  if (info.P10K === "1") frameworks.push("powerlevel10k");
  const zshOptions = new Set((info.OPTIONS ?? "").split(","));
  const bashControl = new Set((info.HISTCONTROL ?? "").split(":"));
  const haveInfo = dumps.capturedAt !== null;
  const options: Record<string, boolean> = {};
  for (const option of shell === "powershell" ? [] : shell === "bash" ? ["autocd", "cdspell", "globstar", "histappend"] : ["autocd", "correct", "autopushd", "extendedglob"]) {
    options[option] = shell === "bash" ? info[`OPT_${option}`] === "1" : zshOptions.has(option);
  }
  const size = info.HISTSIZE ?? "";
  const file = (shell === "powershell" ? undefined : shell === "bash" ? info.HISTFILESIZE : info.SAVEHIST) ?? "";
  return {
    shell,
    shellVersion: /^(\d+\.\d+)/.exec((shell === "powershell" ? info.PS_VERSION : shell === "bash" ? info.BASH_VERSION : info.ZSH_VERSION) ?? "")?.[1] ?? null,
    platform,
    keymap: shell === "powershell" && info.KEYMAP === "windows" ? "windows" : info.KEYMAP === "emacs" || info.KEYMAP === "vi" ? info.KEYMAP : "unknown",
    frameworks,
    packageManagers: [...PACKAGE_MANAGER_PROBES].filter(name => !!which(name)),
    installedTools: [...TOOL_PROBES].filter(name => !!which(name)),
    history: {
      entries: 0,
      timestamps: false,
      sizeLimit: /^\d+$/.test(size) && Number.isSafeInteger(Number(size)) ? Number(size) : null,
      fileLimit: /^\d+$/.test(file) && Number.isSafeInteger(Number(file)) ? Number(file) : null,
      ignoreSpace: !haveInfo || shell === "powershell" ? null : shell === "bash" ? bashControl.has("ignorespace") || bashControl.has("ignoreboth") : zshOptions.has("histignorespace"),
      ignoreDups: !haveInfo ? null : shell === "powershell" ? info.HISTORY_NO_DUPLICATES === undefined ? null : info.HISTORY_NO_DUPLICATES === "1" : shell === "bash" ? bashControl.has("ignoredups") || bashControl.has("ignoreboth") || bashControl.has("erasedups") : zshOptions.has("histignoredups") || zshOptions.has("histignorealldups"),
      appendIncremental: !haveInfo ? null : shell === "powershell" ? info.HISTORY_SAVE_STYLE === undefined ? null : info.HISTORY_SAVE_STYLE === "SaveIncrementally" : shell === "bash" ? info.PROMPT_HISTORY_A === "1" : zshOptions.has("incappendhistory") || zshOptions.has("sharehistory"),
      shared: !haveInfo ? null : shell === "powershell" ? info.HISTORY_SAVE_STYLE === undefined ? null : info.HISTORY_SAVE_STYLE === "SaveIncrementally" : shell === "zsh" && zshOptions.has("sharehistory"),
    },
    options,
  };
}
