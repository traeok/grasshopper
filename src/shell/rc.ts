import { copyFileSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeTextAtomic } from "../core/fsx.ts";
import { initFile, toNativePath, toShellPath } from "../core/paths.ts";
import type { Shell } from "../history/source.ts";
import { powerShellProfile } from "./powershell.ts";

const rcHome = (): string => process.env.HOME ? toNativePath(process.env.HOME) : homedir();
export function rcPathFor(shell: Shell): string {
  if (shell === "powershell") return powerShellProfile();
  const directory = shell === "zsh" && process.env.ZDOTDIR ? toNativePath(process.env.ZDOTDIR) : rcHome();
  return join(directory, `.${shell}rc`);
}

export function renderRcBlock(shell: Shell): string {
  const path = `'${toShellPath(initFile(shell), shell).replaceAll("'", shell === "powershell" ? "''" : "'\\''")}'`;
  const load = shell === "powershell" ? `if (Test-Path -LiteralPath ${path}) { . ${path} }` : `[ -f ${path} ] && . ${path}`;
  return `# >>> grasshopper >>>\n${load}\n# <<< grasshopper <<<\n`;
}

function backup(file: string): void {
  let time = Date.now();
  for (;;) {
    const date = new Date(time);
    const timestamp = `${date.getFullYear()}${[date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join("")}`;
    try {
      copyFileSync(file, `${file}.ghop-backup-${timestamp}`, constants.COPYFILE_EXCL);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      time += 1000;
    }
  }
}

export function installRcBlock(shell: Shell): void {
  const file = rcPathFor(shell);
  const exists = existsSync(file);
  const bytes = exists ? readFileSync(file) : Buffer.alloc(0);
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  const original = shell === "powershell" ? new TextDecoder(encoding, { ignoreBOM: true }).decode(bytes) : bytes.toString("utf8");
  const text = shell === "powershell" ? original.replace(/^\uFEFF/, "") : original;
  const block = renderRcBlock(shell);
  const pattern = /^# >>> grasshopper >>>\r?\n[\s\S]*?^# <<< grasshopper <<<(?:\r?\n|$)/m;
  const content = pattern.test(text) ? text.replace(pattern, () => block) : text + (text && !text.endsWith("\n") ? "\n" : "") + block;
  if (exists) backup(file);
  writeTextAtomic(file, (shell === "powershell" ? "\uFEFF" : "") + content);
}

export function bashProfileNeedsSourcing(): boolean {
  const file = join(rcHome(), ".bash_profile");
  return existsSync(file) && !/\.bashrc/.test(readFileSync(file, "utf8"));
}

export function installBashProfileSourcing(): void {
  if (!bashProfileNeedsSourcing()) return;
  const file = join(rcHome(), ".bash_profile");
  const original = readFileSync(file, "utf8");
  const content = original + (original.endsWith("\n") ? "" : "\n") + "test -f ~/.bashrc && . ~/.bashrc\n";
  backup(file);
  writeTextAtomic(file, content);
}
