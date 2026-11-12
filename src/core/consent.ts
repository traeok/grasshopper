import { getMeta, setMeta } from "./state.ts";
import { isoNow } from "./dates.ts";
import { GhopError } from "./errors.ts";
import { CONSENT_TEXT } from "../llm/prompts.ts";
import { confirm } from "../ui/prompts.ts";
import type { AnalysisStats } from "../profile/types.ts";

export async function ensureConsent({ interactive, yes, stats }: { interactive: boolean; yes: boolean; stats: AnalysisStats }): Promise<void> {
  if (getMeta("consent")?.granted) return;
  if (!yes) {
    if (!interactive || !process.stdin.isTTY || !process.stdout.isTTY) throw new GhopError("Consent required: run `ghop setup` or `ghop analyze --yes`.", 5);
    console.log(CONSENT_TEXT);
    console.log(`Entries: ${stats.entries} · kept: ${stats.kept} · fresh: ${stats.fresh} · payload bytes: ${stats.payloadBytes}`);
    if (!await confirm({ message: "Send this scrubbed summary to omp @smol now?", initialValue: false })) throw new GhopError("Consent not granted. Nothing was sent.", 5);
  }
  setMeta("consent", { granted: true, at: isoNow() });
}
