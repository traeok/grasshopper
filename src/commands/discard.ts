import type { Command } from "commander";
import { tx } from "../core/db.ts";
import { GhopError } from "../core/errors.ts";
import { getRec, updateRec, type StoredRecommendation } from "../recs/store.ts";
import { PHRASES } from "../ui/art.ts";
import { parseRecommendationId } from "./list.ts";

export function performDiscard(id: number | string, reason?: string): StoredRecommendation {
  const recId = parseRecommendationId(id);
  const updated = tx(() => {
    const rec = getRec(recId);
    if (rec.status === "implemented") throw new GhopError(`Already implemented; use ghop undo ${recId} first.`);
    if (rec.status === "discarded") throw new GhopError(`Recommendation #${recId} is already discarded.`);
    return updateRec(recId, { status: "discarded", discardReason: reason ?? null });
  });
  console.log(PHRASES.discarded);
  return updated;
}

export function register(program: Command): void {
  program.command("discard").description("Discard a new or accepted recommendation")
    .argument("<id>").option("--reason <text>", "Keep a local discard reason")
    .action((id: string, options: { reason?: string }) => { performDiscard(id, options.reason); });
}
