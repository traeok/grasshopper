import { basename, join } from "node:path";
import { GhopError } from "../core/errors.ts";
import { homeDir, toNativePath } from "../core/paths.ts";

let parentBinary: string | null | undefined;

export function parentPowerShellBinary(): string | null {
  if (parentBinary !== undefined) return parentBinary;
  parentBinary = null;
  const binary = Bun.which("pwsh") ?? Bun.which("powershell");
  if (!binary) return null;
  const result = process.platform === "win32"
    ? Bun.spawnSync([binary, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $p = Get-Process -Id ${process.ppid} -ErrorAction SilentlyContinue; if ($p.ProcessName -in @('pwsh', 'powershell')) { $p.Path }`],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5000 })
    : Bun.spawnSync(["ps", "-p", String(process.ppid), "-o", "comm="],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5000 });
  if (result.exitCode !== 0) return null;
  const command = new TextDecoder().decode(result.stdout).trim();
  const name = basename(command.replaceAll("\\", "/")).replace(/\.exe$/i, "").toLowerCase();
  if (name === "pwsh" || name === "powershell") parentBinary = Bun.which(command) ?? Bun.which(name);
  return parentBinary;
}

export function powerShellBinary(): string | null {
  if (process.env.GHOP_POWERSHELL) return Bun.which(toNativePath(process.env.GHOP_POWERSHELL));
  return parentPowerShellBinary() ?? Bun.which("pwsh") ?? Bun.which("powershell");
}

/** Ask the selected engine so redirected Documents and Windows PowerShell use their real profile. */
export function powerShellProfile(): string {
  if (process.env.GHOP_POWERSHELL_PROFILE) return toNativePath(process.env.GHOP_POWERSHELL_PROFILE);
  const binary = powerShellBinary();
  if (!binary) throw new GhopError("PowerShell was not found. Install PowerShell or choose --shell bash or zsh.");
  const result = Bun.spawnSync([binary, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Write($PROFILE.CurrentUserAllHosts)"],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5000 });
  const profile = new TextDecoder().decode(result.stdout).trim();
  if (result.exitCode !== 0 || !profile) throw new GhopError("Cannot locate the PowerShell profile. Run setup from PowerShell.");
  return profile;
}

export function powerShellHistoryFile(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA ? toNativePath(process.env.APPDATA) : join(homeDir(), "AppData", "Roaming"),
      "Microsoft", "Windows", "PowerShell", "PSReadLine", "ConsoleHost_history.txt");
  }
  return join(process.env.XDG_DATA_HOME ? toNativePath(process.env.XDG_DATA_HOME) : join(homeDir(), ".local", "share"),
    "powershell", "PSReadLine", "ConsoleHost_history.txt");
}
