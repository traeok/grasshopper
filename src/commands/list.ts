import type { Command } from "commander";
import { GhopError } from "../core/errors.ts";
import { loadPseudonyms } from "../recs/pseudonyms.ts";
import { listRecs, Status, type StoredRecommendation } from "../recs/store.ts";
import { PHRASES } from "../ui/art.ts";
import { renderRow } from "../ui/render.ts";

export interface ListOptions { status?: string; all?: boolean; json?: boolean }

export function parseRecommendationId(value: string | number): number {
  const text = String(value);
  const id = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(id)) {
    throw new GhopError("Recommendation ID must be a positive integer.");
  }
  return id;
}

export function selectRecs(options: ListOptions = {}): StoredRecommendation[] {
  const status = options.status === undefined ? undefined : Status.safeParse(options.status);
  if (status && !status.success) throw new GhopError("Invalid status. Use new, accepted, implemented, or discarded.");
  const recs = listRecs(status?.success ? { status: status.data } : {});
  const statusRank = { new: 0, accepted: 1, implemented: 2, discarded: 3 };
  const impactRank = { high: 0, medium: 1, low: 2 };
  return recs.filter((rec) => options.status !== undefined || options.all || rec.status === "new" || rec.status === "accepted")
    .sort((a, b) => statusRank[a.status] - statusRank[b.status]
      || (a.status === "new" ? impactRank[a.impact] - impactRank[b.impact] : 0)
      || b.id - a.id);
}

/** Render a local JSON view without terminal styling or mutating stored text. */
export function renderRecommendationObject(rec: StoredRecommendation): unknown {
  const map = loadPseudonyms(rec.analysisId);
  function render(value: unknown): unknown {
    if (typeof value === "string") return value.replace(/<([a-z]+)#\d+>/g, (placeholder: string) => map[placeholder]?.value ?? placeholder);
    if (Array.isArray(value)) return value.map(render);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, render(item)]));
    }
    return value;
  }
  return render(rec);
}

export function listRecommendations(options: ListOptions = {}): void {
  const recs = selectRecs(options);
  if (options.json) console.log(JSON.stringify(recs.map(renderRecommendationObject), null, 2));
  else if (recs.length === 0) console.log(PHRASES.empty);
  else for (const rec of recs) console.log(renderRow(rec));
}

export function register(program: Command): void {
  program.command("list").description("List recommendations")
    .option("--status <s>", "Filter by recommendation status")
    .option("--all", "Include implemented and discarded recommendations")
    .option("--json", "Print locally rendered JSON")
    .action((options: ListOptions) => listRecommendations(options));
}
