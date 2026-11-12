import { z } from "zod";
import { openDb, tx } from "../core/db.ts";
import { GhopError } from "../core/errors.ts";
import { Action, Category, Level, ToolRef } from "../llm/schema.ts";

export const Status = z.enum(["new", "accepted", "implemented", "discarded"]);
export type Status = z.infer<typeof Status>;
export const ToolVerification = z.object({
  status: z.enum(["verified", "unverified"]),
  license: z.string().nullable(),
  checkedAt: z.string(),
  checks: z.record(z.string(), z.enum(["verified", "rejected", "unknown"])),
});
const VerifiedTool = ToolRef.extend({ verification: ToolVerification });
const Shell = z.enum(["bash", "zsh", "powershell"]);
const Applied = z.discriminatedUnion("kind", [
  z.object({ at: z.string(), kind: z.literal("managed"), shell: Shell, aliasNames: z.array(z.string()), functionNames: z.array(z.string()) }),
  z.object({ at: z.string(), kind: z.literal("install"), shell: Shell, argv: z.array(z.string()), manager: z.enum(["winget", "npm", "brew"]), id: z.string(), initBlock: z.boolean(), aliasNames: z.array(z.string()), functionNames: z.array(z.string()) }),
]);
export const StoredRecommendation = z.object({
  id: z.number().int().positive(), topic: z.string(), key: z.string(), actionKey: z.string().nullable(),
  analysisId: z.string(), createdAt: z.string(), updatedAt: z.string(), evidence: z.array(z.string()),
  status: Status, seenAt: z.string().nullable(), acceptMode: z.enum(["self", "guided", "auto"]).nullable(), discardReason: z.string().nullable(),
  category: Category, title: z.string(), summary: z.string(), rationale: z.string(), steps: z.array(z.string()), impact: Level, effort: Level,
  tool: VerifiedTool.nullable(), action: Action.nullable(), shell: Shell, applied: Applied.nullable(),
});
export type StoredRecommendation = z.infer<typeof StoredRecommendation>;
const RecommendationInputSchema = StoredRecommendation.omit({ id: true });
export type RecommendationInput = z.infer<typeof RecommendationInputSchema>;

const columns = {
  topic: "topic", key: "key", actionKey: "action_key", analysisId: "analysis_id", createdAt: "created_at", updatedAt: "updated_at",
  status: "status", seenAt: "seen_at", acceptMode: "accept_mode", discardReason: "discard_reason", category: "category", title: "title",
  summary: "summary", rationale: "rationale", steps: "steps", impact: "impact", effort: "effort", evidence: "evidence", tool: "tool",
  action: "action", shell: "shell", applied: "applied",
} as const satisfies Record<keyof RecommendationInput, string>;
const keys = Object.keys(columns) as (keyof RecommendationInput)[];
const jsonKeys: Partial<Record<keyof RecommendationInput, true>> = { steps: true, evidence: true, tool: true, action: true, applied: true };

function decode(row: unknown): StoredRecommendation {
  const raw = z.record(z.string(), z.unknown()).parse(row);
  const result: Record<string, unknown> = { id: raw.id };
  for (const key of keys) {
    const value = raw[columns[key]];
    result[key] = jsonKeys[key] && typeof value === "string" ? JSON.parse(value) : value;
  }
  return StoredRecommendation.parse(result);
}
function encode(key: keyof RecommendationInput, value: RecommendationInput[keyof RecommendationInput]): string | number | null {
  if (jsonKeys[key]) return value === null ? null : JSON.stringify(value);
  return value as string | number | null;
}

export function listRecs(options: { status?: Status } = {}): StoredRecommendation[] {
  const db = openDb();
  const rows = options.status === undefined
    ? db.query("SELECT * FROM recommendations ORDER BY id DESC").all()
    : db.query("SELECT * FROM recommendations WHERE status = ? ORDER BY id DESC").all(Status.parse(options.status));
  return rows.map(decode);
}

export function getRec(id: number): StoredRecommendation {
  const row = openDb().query("SELECT * FROM recommendations WHERE id = ?").get(id);
  if (!row) throw new GhopError(`No recommendation #${id}`);
  return decode(row);
}

export function insertRecs(items: RecommendationInput[]): StoredRecommendation[] {
  const parsed = items.map((item) => RecommendationInputSchema.parse(item));
  return tx(() => {
    const statement = openDb().query(`INSERT INTO recommendations (${keys.map((key) => columns[key]).join(", ")}) VALUES (${keys.map(() => "?").join(", ")}) ON CONFLICT(topic) DO NOTHING`);
    const added: StoredRecommendation[] = [];
    for (const item of parsed) {
      const result = statement.run(...keys.map((key) => encode(key, item[key])));
      if (result.changes === 1) added.push(getRec(Number(result.lastInsertRowid)));
    }
    return added;
  });
}

export function updateRec(id: number, patch: Partial<RecommendationInput>): StoredRecommendation {
  return tx(() => {
    const current = getRec(id);
    const next = RecommendationInputSchema.parse({ ...current, ...patch, updatedAt: new Date().toISOString() });
    openDb().query(`UPDATE recommendations SET ${keys.map((key) => `${columns[key]} = ?`).join(", ")} WHERE id = ?`)
      .run(...keys.map((key) => encode(key, next[key])), id);
    return getRec(id);
  });
}

export function topicExists(topic: string): boolean {
  return openDb().query("SELECT 1 FROM recommendations WHERE topic = ? LIMIT 1").get(topic) !== null;
}
