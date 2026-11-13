import { Option, type Command } from "commander";
import { tx } from "../core/db.ts";
import { GhopError } from "../core/errors.ts";
import { DiscardReason, getRec, updateRec, type StoredRecommendation } from "../recs/store.ts";
import { PHRASES } from "../ui/art.ts";
import { parseRecommendationId } from "./list.ts";

export function performDiscard(id: number | string, reason?: string | null): StoredRecommendation {
  const recId = parseRecommendationId(id);
  const parsedReason = DiscardReason.nullable().safeParse(reason ?? null);
  if (!parsedReason.success) throw new GhopError(`Invalid discard reason. Choose one of: ${DiscardReason.options.join(", ")}.`);
  const updated = tx(() => {
    const rec = getRec(recId);
    if (rec.status === "implemented") throw new GhopError(`Already implemented; use ghop undo ${recId} first.`);
    if (rec.status === "discarded") throw new GhopError(`Recommendation #${recId} is already discarded.`);
    return updateRec(recId, { status: "discarded", discardReason: parsedReason.data });
  });
  console.log(PHRASES.discarded);
  return updated;
}

export function register(program: Command): void {
  program.command("discard").description("Discard a new or accepted recommendation")
    .argument("<id>").addOption(new Option("--reason <reason>", "Record a discard reason").choices(DiscardReason.options))
    .action((id: string, options: { reason?: string }) => { performDiscard(id, options.reason); });
}
