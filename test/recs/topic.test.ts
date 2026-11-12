import { describe, expect, test } from "bun:test";
import { LlmRecommendation } from "../../src/llm/schema.ts";
import { canonicalTool, topicKey } from "../../src/recs/topic.ts";

const item = LlmRecommendation.parse({
  key: "initial-idea", category: "shortcut", title: "Search your history",
  summary: "Use history search", rationale: "Repeated searches", impact: "high", effort: "low",
  evidence: ["signal:historyGrep"],
});
const vocabulary = new Set(["signal:historyGrep", "template:cd <path#1>", "template:cd <path#7>"]);

describe("permanent recommendation topics", () => {
  test("canonical tools follow identifier priority and normalize only case-insensitive registries", () => {
    expect(canonicalTool({ name: "tool", githubRepo: "Owner/Repo", npmPackage: "@scope/pkg", wingetId: "Owner.Tool", brewFormula: "tool" })).toBe("gh:owner/repo");
    expect(canonicalTool({ name: "tool", npmPackage: "@scope/pkg", wingetId: "Owner.Tool" })).toBe("npm:@scope/pkg");
    expect(canonicalTool({ name: "tool", wingetId: "Owner.Tool", brewFormula: "tool" })).toBe("winget:owner.tool");
    expect(canonicalTool({ name: "tool", brewFormula: "tool@2" })).toBe("brew:tool@2");
    expect(canonicalTool({ name: "tool" })).toBeNull();
    expect(canonicalTool(null)).toBeNull();
  });

  test("tool identity ignores wording, key, evidence, and actions", () => {
    const first = { ...item, tool: { name: "First name", githubRepo: "Owner/Repo" } };
    const second = { ...item, key: "other-key", title: "Different wording", evidence: [], tool: { name: "Other name", githubRepo: "owner/repo" }, action: { type: "alias" as const, name: "different", command: "git status" } };
    expect(topicKey(first, {}, "salt", vocabulary)).toBe("tool:gh:owner/repo");
    expect(topicKey(second, {}, "salt", vocabulary)).toBe(topicKey(first, {}, "salt", vocabulary));
  });

  test("alias renames and placeholder renumbering preserve expansion identity", () => {
    const first = { ...item, action: { type: "alias" as const, name: "proj", command: "cd <path#1>" } };
    const second = { ...item, key: "renamed-idea", title: "Another title", action: { type: "alias" as const, name: "work", command: "cd <path#7>" } };
    const original = topicKey(first, { "<path#1>": { type: "path", value: "/fixture/project" } }, "salt", vocabulary);
    expect(topicKey(second, { "<path#7>": { type: "path", value: "/fixture/project" } }, "salt", vocabulary)).toBe(original);
    expect(topicKey(second, { "<path#7>": { type: "path", value: "/fixture/other" } }, "salt", vocabulary)).not.toBe(original);
  });

  test("evidence identity ignores wording and ordering, filters invalid references, and stabilizes placeholders", () => {
    const first = { ...item, evidence: ["template:cd <path#1>", "signal:historyGrep", "signal:invented"] };
    const second = { ...item, key: "reworded", title: "Reworded advice", evidence: ["signal:historyGrep", "template:cd <path#7>"] };
    expect(topicKey(first, { "<path#1>": { type: "path", value: "/fixture/project" } }, "salt", vocabulary))
      .toBe(topicKey(second, { "<path#7>": { type: "path", value: "/fixture/project" } }, "salt", vocabulary));
    expect(topicKey({ ...item, evidence: ["unknown"] }, {}, "salt", vocabulary)).toBe("shortcut:key:initial-idea");
    expect(topicKey({ ...item, category: "tip" }, {}, "salt", vocabulary)).not.toBe(topicKey(item, {}, "salt", vocabulary));
  });
});
