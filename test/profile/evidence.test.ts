import { expect, test } from "bun:test";
import type { PseudonymMap } from "../../src/privacy/pseudonyms.ts";
import { buildMemory, evidenceVocabulary, renderStableRef, stableRef } from "../../src/profile/evidence.ts";
import type { Profile } from "../../src/profile/types.ts";
import type { StoredRecommendation } from "../../src/recs/store.ts";

const salt = "0123456789abcdef0123456789abcdef";
const pseudonyms: PseudonymMap = {
  "<path#1>": { type: "path", value: "/work/private-project" },
  "<alias#1>": { type: "alias", value: "private-shortcut" },
  "<host#1>": { type: "host", value: "private.example.internal" },
};

function profile(): Profile {
  return {
    schema: "ghop-profile/1",
    environment: {
      shell: "bash", shellVersion: "5.2", platform: "linux", keymap: "emacs",
      frameworks: [], packageManagers: [], installedTools: [],
      history: { entries: 50, timestamps: false, sizeLimit: null, fileLimit: null, ignoreSpace: null, ignoreDups: null, appendIncremental: null, shared: null },
      options: {},
    },
    window: { entries: 50, kept: 50, dropped: 0, spanDays: null },
    topCommands: [], topSubcommands: [],
    templates: [{ t: "cd <path#1>", n: 10, len: 20 }],
    aliasCandidates: [{ t: "git status", n: 12, len: 10, savedChars: 72, coveredBy: "<alias#1>" }],
    sequences: [{ seq: ["cd <path#1>", "git status"], n: 5 }],
    repeats: [],
    paths: [{ p: "<path#1>", n: 10, depth: 2, viaCd: 10 }],
    hosts: [{ h: "<host#1>", n: 3, via: ["ssh"] }],
    aliases: [{ a: "<alias#1>", expands: "git status", used: 0, fullFormUsed: 12 }],
    functions: [], typos: [{ typed: "gti", meant: "git", n: 2 }],
    slow: [{ t: "npm test", n: 3, avgSec: 15 }],
    retries: [{ from: "git push", to: "sudo git push", n: 2, succeeded: 2 }],
    projects: [{ project: 1, n: 10, topCommands: [{ c: "git", n: 10 }], sequences: [{ seq: ["git status", "git diff"], n: 4 }] }],
    signals: {
      historyGrep: 3, retypedWithSudo: 0, lastArgReuse: 0, cdUp: 0, cdUpChains: 0,
      cdThenLs: 0, mkdirThenCd: 0, clearScreen: 0, exitCommand: 0, uselessCat: 0,
      grepRecursive: 0, findByName: 0, psGrep: 0, manLookups: 0, helpLookups: 0,
      consecutiveRepeats: 0, longPipelines: 0, cdHome: 0, gitStatus: 0, gitAddAll: 0, dirStack: 0,
    },
    redFlags: [{ kind: "force-push", n: 1 }],
    trends: {
      available: true, basis: "ingestion-days", recentDays: 7, baselineDays: 28,
      rising: [{ c: "git status", recent: 12, baseline: 8 }],
      falling: [{ c: "npm install", recent: 0, baseline: 20 }],
      new: [{ c: "bun test", recent: 5, baseline: 0 }],
    },
    memory: [],
  };
}

function recommendation(patch: Partial<StoredRecommendation> = {}): StoredRecommendation {
  return {
    id: 1, topic: "tip:key:history-search", key: "history-search", actionKey: null,
    analysisId: "fixture-analysis", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
    evidence: [], status: "new", seenAt: null, acceptMode: null, discardReason: null,
    category: "tip", title: "Search your history", summary: "Use history search.", rationale: "Repeated history searches.",
    steps: [], impact: "medium", effort: "low", tool: null, action: null, shell: "bash", applied: null,
    ...patch,
  };
}

const verification = { status: "verified" as const, license: "MIT", checkedAt: "2026-11-01T00:00:00.000Z", checks: {} };

test("evidence vocabulary contains every supported reference and only positive signals", () => {
  expect([...evidenceVocabulary(profile())].sort()).toEqual([
    "signal:historyGrep", "redFlag:force-push", "template:cd <path#1>", "template:git status",
    "sequence:cd <path#1> → git status", "alias:<alias#1>", "path:<path#1>", "host:<host#1>",
    "typo:gti", "slow:npm test", "trend:git status", "trend:npm install", "trend:bun test",
    "retry:git push → sudo git push", "sequence:git status → git diff",
    "history:timestamps", "history:fileLimit", "history:ignoreSpace", "history:ignoreDups", "history:appendIncremental",
  ].sort());
  const collecting = profile();
  collecting.trends = { available: false, reason: "collecting" };
  expect([...evidenceVocabulary(collecting)].some(ref => ref.startsWith("trend:"))).toBe(false);
});

test("stable references survive placeholder renumbering without exposing literal values", () => {
  const ref = "sequence:cd <path#1> → ssh <host#1> → <alias#1> <arg>";
  const stable = stableRef(ref, pseudonyms, salt);
  expect(stable).toMatch(/^sequence:cd <path:[a-f0-9]{10}> → ssh <host:[a-f0-9]{10}> → <alias:[a-f0-9]{10}> <arg>$/);
  for (const literal of Object.values(pseudonyms)) expect(stable).not.toContain(literal.value);
  expect(renderStableRef(stable, pseudonyms, salt)).toBe(ref);
  const renumbered: PseudonymMap = {
    "<path#7>": pseudonyms["<path#1>"]!,
    "<host#3>": pseudonyms["<host#1>"]!,
    "<alias#2>": pseudonyms["<alias#1>"]!,
  };
  const currentRef = "sequence:cd <path#7> → ssh <host#3> → <alias#2> <arg>";
  expect(stableRef(currentRef, renumbered, salt)).toBe(stable);
  expect(renderStableRef(stable, renumbered, salt)).toBe(currentRef);
  expect(stableRef(ref, pseudonyms, "different-installation-salt")).not.toBe(stable);
  expect(renderStableRef(stable, {}, salt)).toBe("sequence:cd <path> → ssh <host> → <alias> <arg>");
  expect(renderStableRef(stable, pseudonyms, "different-installation-salt")).toBe("sequence:cd <path> → ssh <host> → <alias> <arg>");
  expect(stableRef("path:<path#99>", pseudonyms, salt)).toBe("path:<path>");
  expect(stableRef("template:git status <arg>", pseudonyms, salt)).toBe("template:git status <arg>");
});

test("memory retains every status and filters references against current vocabulary", () => {
  const existing = (["new", "accepted", "implemented", "discarded"] as const).map((status, index) => recommendation({
    id: index + 1, status,
    evidence: [stableRef("path:<path#1>", pseudonyms, salt), "signal:historyGrep", "signal:cdUp", "template:obsolete", "signal:historyGrep"],
    discardReason: "local-only-reason",
  }));
  const memory = buildMemory(profile(), existing, pseudonyms, salt);
  expect(memory).toEqual(existing.map(row => ({ category: row.category, status: row.status, evidence: ["path:<path#1>", "signal:historyGrep"], tool: null })));
  expect(JSON.stringify(memory)).not.toContain("local-only-reason");
  expect(existing[0]!.evidence).toHaveLength(5);
});

test("memory recovers alias expansion evidence from the stable topic", () => {
  const row = recommendation({
    category: "alias", status: "discarded", topic: `alias:${stableRef("cd <path#1>", pseudonyms, salt)}`,
    evidence: ["template:git status"],
  });
  expect(buildMemory(profile(), [row], pseudonyms, salt)).toEqual([
    { category: "alias", status: "discarded", evidence: ["template:git status", "template:cd <path#1>"], tool: null },
  ]);
  const missing = recommendation({ topic: "alias:obsolete command" });
  expect(buildMemory(profile(), [missing], pseudonyms, salt)[0]!.evidence).toEqual([]);
});

test("memory canonicalizes public tool identifiers with the specified priority", () => {
  const tools: NonNullable<StoredRecommendation["tool"]>[] = [
    { name: "first", githubRepo: "Owner/Repo", npmPackage: "ignored", wingetId: "Ignored.Id", brewFormula: "ignored", verification },
    { name: "second", npmPackage: "@scope/public-tool", wingetId: "Ignored.Id", verification },
    { name: "third", wingetId: "Publisher.Tool", brewFormula: "ignored", verification },
    { name: "fourth", brewFormula: "public-tool@2", verification },
    { name: "unidentified", verification },
  ];
  const memory = buildMemory(profile(), tools.map(tool => recommendation({ category: "tool", tool })), pseudonyms, salt);
  expect(memory.map(item => item.tool)).toEqual(["gh:owner/repo", "npm:@scope/public-tool", "winget:publisher.tool", "brew:public-tool@2", null]);
});

test("memory includes rows without matching evidence and sorts relevant rows before newest empty rows", () => {
  const existing = [
    recommendation({ category: "tip", updatedAt: "2026-11-12T00:00:00.000Z" }),
    recommendation({ category: "workflow", evidence: ["signal:historyGrep"], updatedAt: "2026-11-01T00:00:00.000Z" }),
    recommendation({ category: "tool", tool: { name: "tool", npmPackage: "public-tool", verification }, updatedAt: "2026-11-02T00:00:00.000Z" }),
    recommendation({ category: "shortcut", updatedAt: "2026-11-11T00:00:00.000Z" }),
  ];
  expect(buildMemory(profile(), existing, pseudonyms, salt).map(item => item.category)).toEqual(["tool", "workflow", "tip", "shortcut"]);
});

test("memory caps at 80 after ranking and leaves input rows unchanged", () => {
  const existing = Array.from({ length: 85 }, (_, index) => recommendation({
    id: index + 1, category: "tip", updatedAt: `2026-11-12T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
  }));
  existing.push(recommendation({ category: "alias", evidence: ["template:git status"], updatedAt: "2020-01-01T00:00:00.000Z" }));
  const memory = buildMemory(profile(), existing, pseudonyms, salt);
  expect(memory).toHaveLength(80);
  expect(memory[0]).toEqual({ category: "alias", status: "new", evidence: ["template:git status"], tool: null });
  expect(existing).toHaveLength(86);
  expect(existing[0]!.id).toBe(1);
});
