import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Shell } from "../history/source.ts";

type DumpKind = "aliases" | "functions" | "info";

export function toNativePath(p: string): string {
  let result = p.replace(/^~(?=[/\\]|$)/, homedir());
  if (process.platform !== "win32") return result;

  const msysDrive = /^\/([a-zA-Z])(?:\/|$)/.exec(result);
  if (msysDrive) {
    return `${msysDrive[1]!.toUpperCase()}:\\${result.slice(msysDrive[0].length).replaceAll("/", "\\")}`;
  }
  if (/^[a-zA-Z]:\//.test(result)) return result.replaceAll("/", "\\");
  if (result.startsWith("/")) {
    const cygpath = Bun.which("cygpath");
    if (cygpath) {
      const converted = Bun.spawnSync([cygpath, "-w", result], { stdout: "pipe", stderr: "ignore" });
      if (converted.exitCode === 0) {
        result = new TextDecoder().decode(converted.stdout).trimEnd();
      }
    }
  }
  return result;
}

export function homeDir(): string {
  if (process.env.HOME) {
    const home = toNativePath(process.env.HOME);
    try {
      if (existsSync(home) && statSync(home).isDirectory()) return home;
    } catch {
      // An inaccessible HOME is not usable as a directory.
    }
  }
  return homedir();
}

export function ghopHome(): string {
  if (process.env.GRASSHOPPER_HOME) return toNativePath(process.env.GRASSHOPPER_HOME);
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA
      ? toNativePath(process.env.LOCALAPPDATA)
      : join(homeDir(), "AppData", "Local");
    return join(base, "grasshopper");
  }
  const base = process.env.XDG_DATA_HOME
    ? toNativePath(process.env.XDG_DATA_HOME)
    : join(homeDir(), ".local", "share");
  return join(base, "grasshopper");
}

export const configFile = (): string => join(ghopHome(), "config.json");
export const dbFile = (): string => join(ghopHome(), "ghop.db");
export const shellDump = (shell: Shell, kind: DumpKind): string => join(ghopHome(), "shell", `${shell}.${kind}`);
export const initFile = (shell: Shell): string => join(ghopHome(), "init", `ghop.${shell}${shell === "powershell" ? ".ps1" : ""}`);
export const managedFile = (shell: Shell): string => join(ghopHome(), "managed", `${shell}.${shell === "powershell" ? "ps1" : "sh"}`);
export const reloadFile = (shell: Shell): string => join(ghopHome(), `reload.${shell}.${shell === "powershell" ? "ps1" : "sh"}`);
export const dailyStamp = (): string => join(ghopHome(), "daily.stamp");
export const freshFlag = (): string => join(ghopHome(), "fresh.flag");
export const lockFile = (name: string): string => join(ghopHome(), "locks", `${name}.lock`);
export const logFile = (): string => join(ghopHome(), "logs", "ghop.log");

export function toShellPath(p: string, shell: Shell): string {
  if (process.platform === "win32" && shell === "bash") {
    return p.replace(/^([a-zA-Z]):[\\/]/, (_, drive: string) => `/${drive.toLowerCase()}/`).replaceAll("\\", "/");
  }
  return p;
}
