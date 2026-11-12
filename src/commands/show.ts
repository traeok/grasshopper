import type { Command } from "commander";
import { isoNow } from "../core/dates.ts";
import { loadPseudonyms } from "../recs/pseudonyms.ts";
import { getRec, updateRec } from "../recs/store.ts";
import { renderCard } from "../ui/render.ts";
import { parseRecommendationId, renderRecommendationObject } from "./list.ts";

export function showRecommendation(id: string | number, options: { json?: boolean } = {}): void {
  const rec = getRec(parseRecommendationId(id));
  const seen = updateRec(rec.id, { seenAt: isoNow() });
  console.log(options.json ? JSON.stringify(renderRecommendationObject(seen), null, 2) : renderCard(seen, loadPseudonyms(seen.analysisId)));
}

export function register(program: Command): void {
  program.command("show").description("Show a recommendation and mark it seen")
    .argument("<id>").option("--json", "Print locally rendered JSON")
    .action((id: string, options: { json?: boolean }) => showRecommendation(id, options));
}
