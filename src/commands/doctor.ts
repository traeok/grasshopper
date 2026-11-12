import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "../core/config.ts";
import { openDb } from "../core/db.ts";
import { getMeta } from "../core/state.ts";
import { ghopHome, initFile } from "../core/paths.ts";
import { GhopError } from "../core/errors.ts";
import { resolveSource } from "../history/source.ts";
import { readHistory } from "../history/parse.ts";
import { OmpGateway } from "../llm/gateway.ts";
import { ANALYZE_SYSTEM_PROMPT } from "../llm/prompts.ts";
import { harvestSensitiveLiterals } from "../privacy/literals.ts";
import { listRecs } from "../recs/store.ts";
import { INIT_VERSION } from "../shell/init.ts";
import { rcPathFor } from "../shell/rc.ts";
import { danger, leaf } from "../ui/style.ts";

export async function runDoctor(options: { ping?: boolean } = {}): Promise<void> {
  const config = loadConfig();
  const report = (ok: boolean, message: string) => console.log(`${ok ? leaf("✓") : danger("✗")} ${message}`);
  report(Bun.semver.satisfies(Bun.version, ">=1.3.14"), `Bun ${Bun.version} (requires ≥1.3.14; update Bun if older)`);
  const executable = config.llm.command[0]!;
  let gateway: OmpGateway | null = null;
  if (!Bun.which(executable)) report(false, "omp executable missing. Install @oh-my-pi/pi-coding-agent and run omp login.");
  else {
    gateway = new OmpGateway({ command: config.llm.command, model: config.llm.model, timeoutMs: config.llm.timeoutSec * 1000, literals: await harvestSensitiveLiterals(config) });
    try { const ready = await gateway.handshake(); report(true, `omp ${ready.version} · auth-gateway stdio`); }
    catch (error) { report(false, `${error instanceof GhopError ? error.message : "Gateway handshake failed"}. Run omp update and omp login.`); }
  }
  if (options.ping && gateway) {
    try {
      const result = await gateway.complete([{ role: "system", content: ANALYZE_SYSTEM_PROMPT }, { role: "user", content: 'Reply with {"recommendations":[]}.' }], { maxTokens: 200 });
      report(true, `Model ${result.model ?? "unknown"} · prompt ${result.usage?.prompt_tokens ?? "?"} / completion ${result.usage?.completion_tokens ?? "?"} tokens`);
    } catch (error) { report(false, `${error instanceof GhopError ? error.message : "Model ping failed"}. Check omp model roles and login.`); }
  }
  try {
    const source = resolveSource({ persist: false });
    const entries = await readHistory(source, config.analysis.maxEntries);
    report(true, `History ${source.shell}: ${source.file} · ${entries.length} entries · timestamps ${entries.some(e => e.ts !== null) ? "yes" : "no"}`);
    const init = initFile(source.shell);
    const current = existsSync(init) && readFileSync(init, "utf8").replace(/^\uFEFF/, "").split("\n", 1)[0]?.startsWith(`# ghop-init v${INIT_VERSION} `);
    report(!!current, `Init ${current ? "current" : "missing/outdated"}. ${current ? init : "Run ghop setup"}`);
    const rc = rcPathFor(source.shell);
    const integrated = existsSync(rc) && readFileSync(rc, "utf8").includes("# >>> grasshopper >>>");
    report(integrated, `Shell rc ${integrated ? "integrated" : "not integrated"}. ${integrated ? rc : "Run ghop setup"}`);
    report(process.env.GHOP_SHELL === source.shell, `Shell hook ${process.env.GHOP_SHELL === source.shell ? "active" : "not active"}. Open a new terminal after setup.`);
  } catch (error) { report(false, error instanceof GhopError ? error.message : "Cannot read shell history. Configure history.file and run ghop setup."); }
  report(!!getMeta("consent")?.granted, `Model consent ${getMeta("consent") ? "granted" : "not granted; run ghop setup or ghop analyze --yes"}`);
  const last = getMeta("lastAnalysisAt");
  const id = getMeta("lastAnalysisId");
  const analysis = id ? openDb().query<{ model: string | null }, [string]>("SELECT model FROM analyses WHERE id = ?").get(id) : null;
  const counts = { new: 0, accepted: 0, implemented: 0, discarded: 0 };
  for (const rec of listRecs({})) counts[rec.status]++;
  console.log(`Last analysis: ${last ?? "never"} · model ${analysis?.model ?? "unknown"}`);
  console.log(`Recommendations: ${JSON.stringify(counts)}`);
  console.log(`Next eligible: ${last ? new Date(Date.parse(last) + config.analysis.minIntervalHours * 3600000).toISOString() : "now"} · requires ≥${config.analysis.minNewEntries} new entries`);
  report(!getMeta("lastAnalysisError"), `Last analysis error: ${getMeta("lastAnalysisError") ?? "none"}`);
  console.log(`Data directory: ${ghopHome()}`);
}
export function register(program: Command): void {
  program.command("doctor").description("Diagnose runtime, model, history, and shell integration")
    .option("--ping", "Send a small static request to the configured model")
    .action(async (options: { ping?: boolean }) => { await runDoctor(options); });
}
