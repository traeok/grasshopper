import { describe, expect, spyOn, test } from "bun:test";
import { Command } from "commander";
import { openDb } from "../../src/core/db.ts";
import { GhopError } from "../../src/core/errors.ts";
import { listRecommendations, parseRecommendationId, register as registerList, selectRecs } from "../../src/commands/list.ts";
import { register as registerShow, showRecommendation } from "../../src/commands/show.ts";
import { performDiscard, register as registerDiscard } from "../../src/commands/discard.ts";
import { performDone, register as registerDone } from "../../src/commands/done.ts";
import { getRec, insertRecs, type RecommendationInput } from "../../src/recs/store.ts";
import { PHRASES } from "../../src/ui/art.ts";
import { withTempHome } from "../helpers/env.ts";

function recommendation(topic: string, patch: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    topic, key: "visit-project", actionKey: "alias:proj", analysisId: "review-fixture",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    status: "new", seenAt: null, acceptMode: null, discardReason: null, category: "alias",
    title: "Visit <path#1>", summary: "Use <path#1>", rationale: "Repeated cd <path#1>",
    steps: ["Run cd <path#1>"], impact: "high", effort: "low", evidence: ["path:<path:0123456789>"],
    tool: null, action: { type: "alias", name: "proj", command: "cd <path#1>" }, shell: "bash", applied: null,
    ...patch,
  };
}

function seedAnalysis(value = "/fixture/project"): void {
  openDb().query("INSERT INTO analyses (id, created_at, shell, stats, profile, messages, pseudonyms) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("review-fixture", "2026-01-01T00:00:00.000Z", "bash", "{}", "{}", "[]", JSON.stringify({ "<path#1>": { type: "path", value } }));
}

function program(): Command {
  const command = new Command().exitOverride();
  registerList(command);
  registerShow(command);
  registerDiscard(command);
  registerDone(command);
  return command;
}

describe("review commands", () => {
  test("default order is new by impact then descending id, followed by accepted", () => withTempHome(() => {
    const rows = insertRecs([
      recommendation("low", { impact: "low" }), recommendation("high-old"), recommendation("high-new"),
      recommendation("medium", { impact: "medium" }), recommendation("accepted", { status: "accepted" }),
      recommendation("implemented", { status: "implemented" }), recommendation("discarded", { status: "discarded" }),
    ]);
    expect(selectRecs().map((rec) => rec.topic)).toEqual(["high-new", "high-old", "medium", "low", "accepted"]);
    expect(selectRecs({ all: true }).map((rec) => rec.topic)).toEqual(["high-new", "high-old", "medium", "low", "accepted", "implemented", "discarded"]);
    expect(selectRecs({ status: "discarded" }).map((rec) => rec.id)).toEqual([rows[6]!.id]);
    expect(() => selectRecs({ status: "invalid" })).toThrow(GhopError);
    expect(() => selectRecs({ status: "" })).toThrow(GhopError);
  }));

  test("list JSON resolves nested text locally without changing stored values or marking seen", () => withTempHome(async () => {
    seedAnalysis();
    const rec = insertRecs([recommendation("json")])[0]!;
    const output = spyOn(console, "log").mockImplementation(() => {});
    try {
      await program().parseAsync(["list", "--json"], { from: "user" });
      const rendered: unknown = JSON.parse(String(output.mock.calls[0]?.[0]));
      expect(rendered).toMatchObject([{ id: rec.id, title: "Visit /fixture/project", steps: ["Run cd /fixture/project"], action: { command: "cd /fixture/project" } }]);
      expect(getRec(rec.id).title).toBe("Visit <path#1>");
      expect(getRec(rec.id).seenAt).toBeNull();
    } finally { output.mockRestore(); }
  }));

  test("show marks seen and JSON contains rendered values", () => withTempHome(async () => {
    seedAnalysis();
    const rec = insertRecs([recommendation("show")])[0]!;
    const output = spyOn(console, "log").mockImplementation(() => {});
    try {
      await program().parseAsync(["show", String(rec.id), "--json"], { from: "user" });
      const shown: unknown = JSON.parse(String(output.mock.calls[0]?.[0]));
      expect(shown).toMatchObject({ title: "Visit /fixture/project", seenAt: getRec(rec.id).seenAt });
      expect(getRec(rec.id).seenAt).not.toBeNull();
      showRecommendation(rec.id);
      expect(String(output.mock.calls[1]?.[0])).toContain("/fixture/project");
    } finally { output.mockRestore(); }
  }));

  test("discard and done support only open-state transitions and enum discard reasons", () => withTempHome(async () => {
    const rows = insertRecs([
      recommendation("discard-new"), recommendation("discard-accepted", { status: "accepted" }),
      recommendation("done-new"), recommendation("done-accepted", { status: "accepted" }),
      recommendation("implemented", { status: "implemented" }), recommendation("discarded", { status: "discarded" }),
    ]);
    const output = spyOn(console, "log").mockImplementation(() => {});
    try {
      await program().parseAsync(["discard", String(rows[0]!.id), "--reason", "not-relevant"], { from: "user" });
      expect(getRec(rows[0]!.id)).toMatchObject({ status: "discarded", discardReason: "not-relevant" });
      expect(performDiscard(rows[1]!.id)).toMatchObject({ status: "discarded", discardReason: null });
      await program().parseAsync(["done", String(rows[2]!.id)], { from: "user" });
      expect(getRec(rows[2]!.id).status).toBe("implemented");
      expect(performDone(rows[3]!.id).status).toBe("implemented");
      expect(() => performDiscard(rows[4]!.id)).toThrow(`Already implemented; use ghop undo ${rows[4]!.id} first.`);
      expect(() => performDiscard(rows[5]!.id)).toThrow(GhopError);
      expect(() => performDone(rows[4]!.id)).toThrow(GhopError);
      expect(() => performDone(rows[5]!.id)).toThrow(GhopError);
      expect(output.mock.calls.map((call) => call[0])).toEqual([PHRASES.discarded, PHRASES.discarded, PHRASES.done, PHRASES.done]);
    } finally { output.mockRestore(); }
  }));

  test("invalid CLI and direct discard reasons leave recommendations unchanged", () => withTempHome(async () => {
    const rows = insertRecs([recommendation("invalid-new"), recommendation("invalid-accepted", { status: "accepted" })]);
    const output = spyOn(console, "log").mockImplementation(() => {});
    try {
      for (const row of rows) {
        for (const reason of ["private local reason", "", "NOT-NOW"]) {
          const cli = program().configureOutput({ writeErr: () => {} });
          await expect(cli.parseAsync(["discard", String(row.id), "--reason", reason], { from: "user" })).rejects.toThrow(/allowed choices/i);
          expect(getRec(row.id)).toEqual(row);
          expect(() => performDiscard(row.id, reason)).toThrow("Invalid discard reason. Choose one of:");
          expect(getRec(row.id)).toEqual(row);
        }
      }
      expect(output.mock.calls).toEqual([]);
      expect(performDiscard(rows[0]!.id, null)).toMatchObject({ status: "discarded", discardReason: null });
    } finally { output.mockRestore(); }
  }));

  test("IDs reject fractions, signs, zero, trailing text and unsafe integers", () => withTempHome(() => {
    for (const id of ["0", "-1", "+1", "1.2", "1e2", "1abc", " 1", "9007199254740992"]) {
      expect(() => parseRecommendationId(id)).toThrow(GhopError);
      expect(() => showRecommendation(id)).toThrow(GhopError);
      expect(() => performDiscard(id)).toThrow(GhopError);
      expect(() => performDone(id)).toThrow(GhopError);
    }
    expect(parseRecommendationId("12")).toBe(12);
    expect(() => showRecommendation(999)).toThrow("No recommendation #999");
    expect(() => performDiscard(999)).toThrow("No recommendation #999");
    expect(() => performDone(999)).toThrow("No recommendation #999");
  }));

  test("empty JSON remains a JSON array and missing maps preserve placeholders", () => withTempHome(() => {
    const output = spyOn(console, "log").mockImplementation(() => {});
    try {
      listRecommendations({ json: true });
      expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual([]);
      insertRecs([recommendation("missing-analysis")]);
      listRecommendations({ json: true });
      expect(String(output.mock.calls[1]?.[0])).toContain("<path#1>");
    } finally { output.mockRestore(); }
  }));

  test("pseudonym memoization stays scoped to each database", async () => {
    for (const path of ["/fixture/first", "/fixture/second"]) {
      await withTempHome(() => {
        seedAnalysis(path);
        insertRecs([recommendation("same-analysis-id")]);
        const output = spyOn(console, "log").mockImplementation(() => {});
        try {
          listRecommendations({ json: true });
          expect(String(output.mock.calls[0]?.[0])).toContain(path);
        } finally { output.mockRestore(); }
      });
    }
  });
});
