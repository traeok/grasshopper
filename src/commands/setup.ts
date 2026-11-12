import { outro } from "@clack/prompts";
import type { Command } from "commander";
import { loadConfig } from "../core/config.ts";
import { isoNow } from "../core/dates.ts";
import { GhopError, OmpError } from "../core/errors.ts";
import { toShellPath } from "../core/paths.ts";
import { setMeta } from "../core/state.ts";
import { detectShell, resolveSource, type Shell } from "../history/source.ts";
import { runAnalysis } from "../llm/analyze.ts";
import { OmpGateway } from "../llm/gateway.ts";
import { CONSENT_TEXT } from "../llm/prompts.ts";
import { harvestSensitiveLiterals } from "../privacy/literals.ts";
import { writeInitFile } from "../shell/init.ts";
import { bashProfileNeedsSourcing, installBashProfileSourcing, installRcBlock, rcPathFor, renderRcBlock } from "../shell/rc.ts";
import { printArt, PHRASES } from "../ui/art.ts";
import { confirm, requireTTY, select } from "../ui/prompts.ts";
import { renderRow } from "../ui/render.ts";
import { printStats } from "./analyze.ts";

type ConsentChoice = "send" | "daily" | "payload" | "none";
interface SetupDeps {
  confirm: typeof confirm;
  selectShell: (initial: Shell) => Promise<Shell>;
  selectConsent: () => Promise<ConsentChoice>;
  analyze: typeof runAnalysis;
  handshake: () => Promise<{ version: string }>;
  outro: typeof outro;
  requireTTY: typeof requireTTY;
}

export async function runSetup(options: { shell?: string; yes?: boolean } = {}, overrides: Partial<SetupDeps> = {}): Promise<void> {
  if (options.shell !== undefined && options.shell !== "bash" && options.shell !== "zsh" && options.shell !== "powershell") throw new GhopError("Shell must be bash, zsh, or powershell.");
  const deps: SetupDeps = {
    confirm,
    selectShell: (initial) => select<Shell>({ message: "Which shell should Grasshopper integrate with?", initialValue: initial, options: [{ value: "bash", label: "Bash (including Git Bash)" }, { value: "zsh", label: "Zsh" }, { value: "powershell", label: "PowerShell (pwsh or Windows PowerShell)" }] }),
    selectConsent: () => select<ConsentChoice>({ message: "What should Grasshopper send?", initialValue: "none", options: [
      { value: "send", label: "Send now" },
      { value: "daily", label: "Allow daily background analysis, but not now" },
      { value: "payload", label: "Show the exact payload first" },
      { value: "none", label: "Don't send anything" },
    ] }),
    analyze: runAnalysis,
    handshake: async () => {
      const config = loadConfig();
      return new OmpGateway({ command: config.llm.command, model: config.llm.model, timeoutMs: config.llm.timeoutSec * 1000, literals: await harvestSensitiveLiterals(config) }).handshake();
    },
    outro,
    requireTTY,
    ...overrides,
  };
  printArt();
  console.log(PHRASES.welcome);
  if (!options.yes) deps.requireTTY();
  const detected = options.shell ?? detectShell() ?? (process.platform === "win32" ? "powershell" : "bash");
  const shell = options.yes ? detected : await deps.selectShell(detected);
  try {
    const ready = await deps.handshake();
    console.log(`omp ${ready.version} is ready.`);
  } catch (error) {
    if (!(error instanceof OmpError)) throw error;
    console.error(error.message);
  }
  writeInitFile(shell);
  const rc = rcPathFor(shell);
  console.log(`Shell integration for ${rc}:\n${renderRcBlock(shell)}`);
  if (options.yes || await deps.confirm({ message: `Add it to ${rc}?`, initialValue: true })) {
    installRcBlock(shell);
    if (shell === "bash" && bashProfileNeedsSourcing()) {
      console.log("Your ~/.bash_profile does not source ~/.bashrc.\nProposed addition: test -f ~/.bashrc && . ~/.bashrc");
      if (options.yes || await deps.confirm({ message: "Add this to ~/.bash_profile?", initialValue: true })) installBashProfileSourcing();
    }
  }
  if (!options.yes) {
    const source = resolveSource({ shell, persist: false });
    const preview = await deps.analyze({ source, dryRun: true, interactive: true });
    if (!("messages" in preview)) throw new GhopError("Analysis did not return a dry-run preview.");
    printStats(preview.stats);
    console.log(CONSENT_TEXT);
    for (;;) {
      const choice = await deps.selectConsent();
      if (choice === "payload") {
        console.log(JSON.stringify(preview.messages, null, 2));
        continue;
      }
      if (choice === "send" || choice === "daily") {
        setMeta("consent", { granted: true, at: isoNow() });
        if (choice === "send") {
          const result = await deps.analyze({ source, interactive: true });
          if ("added" in result) {
            for (const rec of result.added) console.log(renderRow(rec));
            console.log(result.added.length ? "ghop to review · ghop chat <id> · ghop accept <id>" : PHRASES.empty);
          }
        }
      }
      break;
    }
  }
  const activationPath = `'${toShellPath(rc, shell).replaceAll("'", shell === "powershell" ? "''" : "'\\''")}'`;
  deps.outro(`Open a new terminal (or run: ${shell === "powershell" ? "." : "source"} ${activationPath}) to activate grasshopper.`);
}

export function register(program: Command): void {
  program.command("setup").description("Set up shell integration and review privacy consent")
    .option("--shell <bash|zsh|powershell>").option("--yes", "Install shell integration without granting consent")
    .action((options: { shell?: string; yes?: boolean }) => runSetup(options));
}
