import type { Command } from "commander";
import { tx } from "../core/db.ts";
import { GhopError } from "../core/errors.ts";
import { getRec, updateRec, type StoredRecommendation } from "../recs/store.ts";
import { PHRASES } from "../ui/art.ts";
import { parseRecommendationId } from "./list.ts";

export function performDone(id: number | string): StoredRecommendation {
  const recId = parseRecommendationId(id);
  const updated = tx(() => {
    const rec = getRec(recId);
    if (rec.status !== "new" && rec.status !== "accepted") {
      throw new GhopError(`Cannot mark ${rec.status} recommendation #${recId} done; only new or accepted recommendations can be completed.`);
    }
    return updateRec(recId, { status: "implemented" });
  });
  console.log(PHRASES.done);
  return updated;
}

export function register(program: Command): void {
  program.command("done").description("Mark a new or accepted recommendation implemented")
    .argument("<id>").action((id: string) => { performDone(id); });
}
