import { Argument, type Command } from "commander";
import { parseCapture, recordTelemetry } from "../history/telemetry.ts";
import type { Shell } from "../history/source.ts";

export function register(program: Command): void {
  program.command("record", { hidden: true })
    .addArgument(new Argument("shell").choices(["bash", "zsh", "powershell"]))
    .action(async (shell: Shell) => {
      try {
        recordTelemetry(shell, parseCapture(await Bun.stdin.text()));
      } catch {
        // Prompt telemetry is best-effort; never log sensitive stdin or errors
        // that could contain it, and never interrupt the interactive shell.
        process.exitCode = 1;
      }
    });
}
