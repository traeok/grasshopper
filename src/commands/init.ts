import { InvalidArgumentError, type Command } from "commander";
import { ghopHome, toShellPath } from "../core/paths.ts";
import type { Shell } from "../history/source.ts";
import { renderInit } from "../shell/init.ts";

export function register(program: Command): void {
  program.command("init")
    .description("Print shell integration for Bash, Zsh, or PowerShell")
    .argument("<shell>", "bash, zsh, or powershell", (value: string) => {
      if (value !== "bash" && value !== "zsh" && value !== "powershell") throw new InvalidArgumentError("Shell must be bash, zsh, or powershell.");
      return value;
    })
    .option("--root <dir>", "Embed this shell-form data directory verbatim")
    .action((shell: Shell, options: { root?: string }) => {
      process.stdout.write(renderInit(shell, options.root ?? toShellPath(ghopHome(), shell)));
    });
}
