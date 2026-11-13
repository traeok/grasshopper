import { describe, expect, test } from "bun:test";
import { GhopError } from "../../src/core/errors.ts";
import { DiscardReason, getRec, insertRecs, listRecs, topicExists, updateRec, type RecommendationInput, type Status } from "../../src/recs/store.ts";
import { withTempHome } from "../helpers/env.ts";

function recommendation(topic = "alias:git status"): RecommendationInput {
  return {
    topic, key: "git-status", actionKey: "alias:gs", analysisId: "fixture-analysis",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    evidence: ["template:git status"], status: "new", seenAt: null, acceptMode: null, discardReason: null,
    category: "alias", title: "Shorten git status", summary: "Use a shorter command", rationale: "Repeated git status",
    steps: ["Define the alias"], impact: "high", effort: "low", tool: null,
    action: { type: "alias", name: "gs", command: "git status" }, shell: "bash", applied: null,
  };
}

describe("recommendation storage", () => {
  test("a batch returns only inserted rows and preserves permanent UNIQUE topics in every status", () => withTempHome(() => {
    const statuses: Status[] = ["new", "accepted", "implemented", "discarded"];
    for (const status of statuses) {
      const topic = `shortcut:fixture-${status}`;
      const [original] = insertRecs([{ ...recommendation(topic), status }]);
      expect(original).toBeDefined();
      const changed = { ...recommendation(topic), key: "reworded-idea", title: "Entirely different wording" };
      expect(insertRecs([changed])).toEqual([]);
      expect(topicExists(topic)).toBe(true);
      expect(listRecs({ status }).some((rec) => rec.id === original?.id)).toBe(true);
    }
    const first = recommendation("alias:cd <path:0123456789>");
    const second = recommendation("tool:npm:fixture-tool");
    const added = insertRecs([first, { ...first, key: "renamed", action: { type: "alias", name: "renamed", command: "cd <path#7>" } }, second, second]);
    expect(added.map((rec) => rec.topic)).toEqual([first.topic, second.topic]);
    expect(listRecs()).toHaveLength(6);
  }));

  test("updates round-trip structured fields, status and local metadata", () => withTempHome(() => {
    const [inserted] = insertRecs([recommendation()]);
    if (!inserted) throw new Error("Fixture recommendation was not inserted");
    const patch = {
      status: "implemented" as const, acceptMode: "auto" as const, seenAt: "2026-02-01T00:00:00.000Z", discardReason: "already-doing" as const,
      evidence: ["template:cd <path:0123456789>", "signal:historyGrep"], steps: ["First", "Second"],
      tool: { name: "Fixture tool", npmPackage: "fixture-tool", verification: { status: "verified" as const, license: "MIT", checkedAt: "2026-02-01T00:00:00.000Z", checks: { npm: "verified" as const } } },
      action: { type: "snippet" as const, description: "Fixture snippet", lines: ["printf fixture"] },
      applied: { at: "2026-02-01T00:00:00.000Z", kind: "managed" as const, shell: "bash" as const, aliasNames: [], functionNames: ["fixture"] },
    };
    const updated = updateRec(inserted.id, patch);
    expect(updated).toMatchObject(patch);
    expect(updated.createdAt).toBe(inserted.createdAt);
    expect(updated.updatedAt).not.toBe(inserted.updatedAt);
    expect(getRec(inserted.id)).toEqual(updated);
    const install = { type: "install" as const, manager: "npm" as const, id: "fixture-tool", initLines: [] };
    const applied = { at: "2026-02-02T00:00:00.000Z", kind: "install" as const, shell: "bash" as const, argv: ["npm", "install", "--global", "fixture-tool"], manager: "npm" as const, id: "fixture-tool", initBlock: false, aliasNames: [], functionNames: [] };
    expect(updateRec(inserted.id, { action: install, applied })).toMatchObject({ action: install, applied });
    expect(updateRec(inserted.id, { action: null, applied: null, tool: null })).toMatchObject({ action: null, applied: null, tool: null });
    expect(() => getRec(999999)).toThrow(GhopError);
    expect(() => updateRec(999999, { status: "accepted" })).toThrow("No recommendation #999999");
  }));

  test("invalid batches insert nothing", () => withTempHome(() => {
    expect(() => insertRecs([recommendation("first"), { ...recommendation("second"), action: { type: "alias", name: "invalid name", command: "git status" } }])).toThrow();
    expect(listRecs()).toEqual([]);
  }));

  test("discard reasons accept only enum values or null without partially writing invalid input", () => withTempHome(() => {
    const [inserted] = insertRecs([recommendation()]);
    if (!inserted) throw new Error("Fixture recommendation was not inserted");
    for (const reason of [...DiscardReason.options, null]) {
      expect(updateRec(inserted.id, { discardReason: reason }).discardReason).toBe(reason);
    }
    const before = getRec(inserted.id);
    const invalidReason = "private local reason" as RecommendationInput["discardReason"];
    expect(() => updateRec(inserted.id, { status: "discarded", discardReason: invalidReason })).toThrow();
    expect(getRec(inserted.id)).toEqual(before);
    expect(() => insertRecs([
      recommendation("valid-batch"),
      { ...recommendation("invalid-batch"), discardReason: invalidReason },
    ])).toThrow();
    expect(listRecs()).toEqual([before]);
  }));
});
