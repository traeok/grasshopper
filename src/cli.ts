#!/usr/bin/env bun
import { Command } from "commander";
import { VERSION } from "./version.ts";
import { GhopError } from "./core/errors.ts";
import { log } from "./core/log.ts";
import { logFile } from "./core/paths.ts";
import { fg, palette } from "./ui/style.ts";
import { register as registerAnalyze } from "./commands/analyze.ts";
import { register as registerList } from "./commands/list.ts";
import { register as registerShow } from "./commands/show.ts";
import { register as registerDiscard } from "./commands/discard.ts";
import { register as registerDone } from "./commands/done.ts";
import { register as registerReview } from "./commands/review.ts";
import { register as registerChat } from "./commands/chat.ts";
import { register as registerAccept } from "./commands/accept.ts";
import { register as registerUndo } from "./commands/undo.ts";
import { register as registerInit } from "./commands/init.ts";
import { register as registerSetup } from "./commands/setup.ts";
import { register as registerDaily } from "./commands/daily.ts";
import { register as registerNotify } from "./commands/notify.ts";
import { register as registerDoctor } from "./commands/doctor.ts";
import { register as registerConfig } from "./commands/config.ts";
import { register as registerRecord } from "./commands/record.ts";

if (process.platform !== "win32") process.umask(0o077);
const program = new Command().name("ghop").description("A private shell-history mentor").version(VERSION);
program.addHelpText("after", `
Start:       ghop setup
Inspect:     ghop analyze --dry-run --shell bash --histfile <fixture>
Review:      ghop list · ghop show <id> · ghop chat <id>
Implement:   ghop accept <id> --mode self|guided|auto · ghop undo <id>

Privacy: history is classified, allowlist-normalized, pseudonymized, and guarded
before every model request. Inspect the exact messages with analyze --dry-run.
setup --yes installs shell integration but never grants model-send consent.
Automation always previews the exact change; --yes is explicit confirmation.
State: one local SQLite database plus editable config.json. Override its directory
with GRASSHOPPER_HOME. Discarded topics remain remembered and are not suggested again.
`);
try {
  registerAnalyze(program);
  registerList(program);
  registerShow(program);
  registerDiscard(program);
  registerDone(program);
  registerReview(program);
  registerChat(program);
  registerAccept(program);
  registerUndo(program);
  registerInit(program);
  registerSetup(program);
  registerDaily(program);
  registerNotify(program);
  registerDoctor(program);
  registerConfig(program);
  registerRecord(program);
  await program.parseAsync();
} catch (err) {
  if (err instanceof GhopError) {
    console.error(fg(palette.danger)(`✗ ${err.message}`));
    process.exitCode = err.exitCode;
  } else {
    const message = err instanceof Error ? err.message : "Unexpected error";
    log.error("unexpected-cli-error", { categories: [err instanceof Error ? err.name : "unknown"] });
    console.error(fg(palette.danger)(`✗ ${message} (details: ${logFile()})`));
    process.exitCode = 1;
  }
}
