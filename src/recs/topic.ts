import type { LlmRecommendation, ToolRef } from "../llm/schema.ts";
import type { PseudonymMap } from "../privacy/pseudonyms.ts";
import { stableRef } from "../profile/evidence.ts";

export function canonicalTool(tool: ToolRef | null | undefined): string | null {
  if (tool?.githubRepo) return `gh:${tool.githubRepo.toLowerCase()}`;
  if (tool?.npmPackage) return `npm:${tool.npmPackage}`;
  if (tool?.wingetId) return `winget:${tool.wingetId.toLowerCase()}`;
  if (tool?.brewFormula) return `brew:${tool.brewFormula}`;
  return null;
}

export function topicKey(
  item: LlmRecommendation,
  pseudonyms: PseudonymMap,
  salt: string,
  vocabulary: ReadonlySet<string>,
): string {
  const tool = canonicalTool(item.tool);
  if (tool !== null) return `tool:${tool}`;
  if (item.action?.type === "alias") return `alias:${stableRef(item.action.command, pseudonyms, salt)}`;
  const evidence = item.evidence.filter((ref) => vocabulary.has(ref))
    .map((ref) => stableRef(ref, pseudonyms, salt)).sort();
  return evidence.length > 0 ? `${item.category}:${evidence.join("|")}` : `${item.category}:key:${item.key}`;
}
