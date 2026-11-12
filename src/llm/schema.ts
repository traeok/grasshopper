import { z } from "zod";

export const Level = z.enum(["low", "medium", "high"]);
export type Level = z.infer<typeof Level>;
export const Category = z.enum(["workflow", "alias", "tip", "red-flag", "tool", "shortcut"]);
export type Category = z.infer<typeof Category>;

export const ToolRef = z.object({
  name: z.string().max(60),
  githubRepo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
  npmPackage: z.string().max(214).regex(/^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/).optional(),
  wingetId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]{1,100}$/).optional(),
  brewFormula: z.string().regex(/^[a-z0-9][a-z0-9@._+-]{0,100}$/).optional(),
});
export type ToolRef = z.infer<typeof ToolRef>;

const shellLine = z.string().max(300).refine((line) => !line.includes("\n"), "Must be a single line");
export const Action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("alias"), name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/), command: shellLine }),
  z.object({ type: z.literal("snippet"), description: z.string().max(200), lines: z.array(shellLine).min(1).max(30) }),
  z.object({ type: z.literal("install"), manager: z.enum(["winget", "npm", "brew"]), id: z.string().max(214), initLines: z.array(z.string()).max(10).default([]) }),
]);
export type Action = z.infer<typeof Action>;

export const LlmRecommendation = z.object({
  key: z.string().max(60).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  category: Category,
  title: z.string().min(5).max(90),
  summary: z.string().max(400),
  rationale: z.string().max(700),
  steps: z.array(z.string().max(300)).max(8).default([]),
  impact: Level,
  effort: Level,
  evidence: z.array(z.string().max(200)).max(3).default([]),
  tool: ToolRef.optional(),
  action: Action.optional(),
});
export type LlmRecommendation = z.infer<typeof LlmRecommendation>;

export function actionKey(action: Action): string {
  switch (action.type) {
    case "alias": return `alias:${action.name}`;
    case "snippet": return `snippet:${new Bun.CryptoHasher("sha256").update(action.lines.join("\n")).digest("hex").slice(0, 12)}`;
    case "install": return `install:${action.manager}:${action.id.toLowerCase()}`;
  }
}
