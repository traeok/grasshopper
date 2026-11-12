import { expect, test } from "bun:test";
import { openDb } from "../../src/core/db.ts";
import { EgressBlockedError, GhopError } from "../../src/core/errors.ts";
import {
  appendChat, buildChatMessages, buildContextMessage, extractActionProposal, loadAnalysis, loadChat,
  type ChatAnalysis, type ChatTranscriptMessage,
} from "../../src/llm/chat.ts";
import { CHAT_SYSTEM_PROMPT, GUIDE_SYSTEM_PROMPT } from "../../src/llm/prompts.ts";
import { assertOutboundSafe } from "../../src/privacy/egress.ts";
import { detectSignals } from "../../src/profile/signals.ts";
import type { Profile } from "../../src/profile/types.ts";
import { insertRecs, type StoredRecommendation } from "../../src/recs/store.ts";
import { withTempHome } from "../helpers/env.ts";

function recommendation(patch: Partial<StoredRecommendation> = {}): StoredRecommendation {
  return { id: 1, topic: "alias:git status", key: "alias-git-status", actionKey: null, analysisId: "fixture-analysis",
    createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z", evidence: ["template:git status"],
    status: "new", seenAt: null, acceptMode: null, discardReason: null, category: "alias", title: "Shorten git status",
    summary: "Check git status quickly.", rationale: "You ran git status repeatedly.", steps: ["Use a short alias."],
    impact: "medium", effort: "low", tool: null, action: { type: "alias", name: "gs", command: "git status" },
    shell: "bash", applied: null, ...patch };
}

function profile(): Profile {
  return {
    schema: "ghop-profile/1",
    environment: { shell: "bash", shellVersion: "5.2", platform: "linux", keymap: "emacs", frameworks: [],
      packageManagers: ["npm"], installedTools: [], history: { entries: 100, timestamps: false, sizeLimit: 5000, fileLimit: 5000,
        ignoreSpace: true, ignoreDups: true, appendIncremental: true, shared: null }, options: { histappend: true } },
    window: { entries: 100, kept: 100, dropped: 0, spanDays: null },
    topCommands: [{ c: "git", n: 30 }], topSubcommands: [{ c: "git status", n: 15 }],
    templates: [{ t: "git status", n: 15, len: 10 }], aliasCandidates: [], sequences: [], repeats: [], paths: [], hosts: [],
    aliases: [], functions: [], typos: [], slow: [], signals: detectSignals([]), redFlags: [{ kind: "force-push", n: 2 }],
    trends: { available: false, reason: "collecting" }, memory: [],
  };
}

function context(rec: StoredRecommendation, analysis: ChatAnalysis | null): {
  recommendation: Record<string, unknown>; environment?: Profile["environment"];
  evidence?: { signals: Profile["signals"]; redFlags: Profile["redFlags"]; matches: unknown[] };
} {
  const message = buildContextMessage(rec, analysis);
  expect(message.role).toBe("user");
  expect(message.content.startsWith("Context (JSON):\n")).toBe(true);
  return JSON.parse(message.content.slice("Context (JSON):\n".length));
}

function actionBlock(value: unknown, tag = "ghop-action"): string {
  return `\`\`\`${tag}\n${JSON.stringify(value)}\n\`\`\``;
}

test("extractActionProposal picks the last valid action and ignores later malformed or invalid blocks", () => {
  const first = { type: "alias", name: "gs", command: "git status" } as const;
  const last = { type: "alias", name: "gst", command: "git status --short" } as const;
  const reply = ["Here is an option:", actionBlock(first), "And another:", actionBlock(last),
    "```ghop-action\nnot valid JSON\n```", actionBlock({ type: "alias", name: "not valid", command: "git status" }),
    actionBlock(first, "json")].join("\n");
  expect(extractActionProposal(reply)).toEqual(last);
  expect(extractActionProposal("```ghop-action\n{broken}\n```")).toBeNull();
  expect(extractActionProposal(actionBlock({ type: "install", manager: "unknown", id: "tool" }))).toBeNull();
  expect(extractActionProposal("There is no proposal.")).toBeNull();
});

test("extractActionProposal accepts CRLF and applies action schema defaults", () => {
  const reply = actionBlock({ type: "install", manager: "npm", id: "npm-check-updates" }).replaceAll("\n", "\r\n");
  expect(extractActionProposal(reply)).toEqual({ type: "install", manager: "npm", id: "npm-check-updates", initLines: [] });
});

test("context includes only recommendation fields without an available analysis", () => {
  const rec = recommendation({ discardReason: "local-only-note" });
  const value = context(rec, null);
  expect(value).toEqual({ recommendation: { key: rec.key, category: rec.category, title: rec.title, summary: rec.summary,
    rationale: rec.rationale, steps: rec.steps, action: rec.action, tool: rec.tool } });
  expect(JSON.stringify(value)).not.toContain("local-only-note");
  expect(value).not.toHaveProperty("environment");
  expect(value).not.toHaveProperty("evidence");
});

test("context selects shared commands and numbered placeholders across every evidence collection", () => {
  const p = profile();
  p.templates.push({ t: "echo <path#2>", n: 4, len: 15 });
  p.aliasCandidates = [{ t: "git diff", n: 5, len: 8, savedChars: 20, coveredBy: null }];
  p.sequences = [{ seq: ["git add .", "git commit -m <str>"], n: 5 }];
  p.paths = [{ p: "<path#1>", n: 8, depth: 3, viaCd: 8 }, { p: "<path#2>", n: 5, depth: 2, viaCd: 5 }];
  p.hosts = [{ h: "<host#1>", n: 3, via: ["ssh"] }, { h: "<host#2>", n: 3, via: ["ssh"] }];
  p.aliases = [{ a: "<alias#1>", expands: "git status", used: 3, fullFormUsed: 15 }];
  p.typos = [{ typed: "gti", meant: "git", n: 2 }];
  p.slow = [{ t: "git fetch", n: 3, avgSec: 20 }];
  const rec = recommendation({ title: "Streamline git.", summary: "Revisit <path#1> and <host#1>.", rationale: "", steps: [], action: null });
  const map = { "<path#1>": { type: "path" as const, value: "/fixture/private-zq-project" } };
  const value = context(rec, { profile: p, pseudonyms: map });
  expect(value.environment).toEqual(p.environment);
  expect(value.evidence?.signals).toEqual(p.signals);
  expect(value.evidence?.redFlags).toEqual(p.redFlags);
  expect(value.evidence?.matches).toEqual([p.templates[0], p.aliasCandidates[0], p.sequences[0], p.paths[0], p.hosts[0], p.aliases[0], p.typos[0], p.slow[0]]);
  expect(JSON.stringify(value)).not.toContain("private-zq-project");
  expect(JSON.stringify(value.evidence?.matches)).not.toContain("<path#2>");
  expect(JSON.stringify(value.evidence?.matches)).not.toContain("<host#2>");
});

test("context matches action references and command boundaries rather than substrings", () => {
  const p = profile();
  p.templates.push({ t: "cd <path#1>", n: 5, len: 20 });
  const rec = recommendation({ title: "Widget shortcut", summary: "", rationale: "", steps: [],
    action: { type: "alias", name: "work", command: "cd <path#1>" } });
  expect(context(rec, { profile: p, pseudonyms: {} }).evidence?.matches).toEqual([p.templates[1]]);
  expect(context({ ...rec, action: null }, { profile: p, pseudonyms: {} }).evidence?.matches).toEqual([]);
});

test("context limits relevant matches to twenty, without unrelated items consuming the limit", () => {
  const p = profile();
  const irrelevant = { t: "npm run dev", n: 5, len: 11 };
  const relevant = Array.from({ length: 25 }, (_, index) => ({ t: "git status", n: index + 2, len: 10 }));
  p.templates = [irrelevant, ...relevant];
  p.aliasCandidates = [{ t: "git diff", n: 5, len: 8, savedChars: 20, coveredBy: null }];
  const result = context(recommendation(), { profile: p, pseudonyms: {} });
  expect(result.evidence?.matches).toEqual(relevant.slice(0, 20));
});

test("chat messages retain static prompts and silently redact stored assistant content without mutation", () => {
  const secret = "ghp_Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LzXcVb";
  const transcript: ChatTranscriptMessage[] = [
    { mode: "discuss", role: "user", content: "Use <path#1>." },
    { mode: "discuss", role: "assistant", content: `Use /fixture/project, host bastion.zq-int.net and ${secret}.` },
  ];
  const ctx = { literals: [{ value: "bastion.zq-int.net", kind: "hostname" }],
    pseudonyms: { "<path#1>": { type: "path" as const, value: "/fixture/project" } } };
  const messages = buildChatMessages("discuss", recommendation(), null, transcript, ctx);
  expect(messages[0]).toEqual({ role: "system", content: CHAT_SYSTEM_PROMPT });
  expect(messages[2]).toEqual({ role: "user", content: transcript[0]!.content });
  expect(messages[3]?.content).toContain("<path#1>");
  expect(messages[3]?.content).toContain("<redacted:github-token>");
  expect(JSON.stringify(messages)).not.toContain(secret);
  expect(JSON.stringify(messages)).not.toContain("bastion.zq-int.net");
  expect(JSON.stringify(messages)).not.toContain("/fixture/project");
  expect(transcript[1]?.content).toContain(secret);
  expect(() => assertOutboundSafe(messages, ctx)).not.toThrow();
  expect(buildChatMessages("guide", recommendation(), null, [], ctx)[0]).toEqual({ role: "system", content: GUIDE_SYSTEM_PROMPT });
});

test("stored assistant credentials stay scrubbed when pseudonyms overlap their recognizers", () => {
  const transcript: ChatTranscriptMessage[] = [{
    mode: "discuss", role: "assistant", content: "mysql --password MyPrivate9!; export GH_TOKEN=NextPrivate8!",
  }];
  const ctx = { literals: [], pseudonyms: {
    "<arg#1>": { type: "arg" as const, value: "password" },
    "<arg#2>": { type: "arg" as const, value: "TOKEN" },
  } };
  const messages = buildChatMessages("discuss", recommendation(), null, transcript, ctx);
  expect(JSON.stringify(messages)).not.toContain("MyPrivate9!");
  expect(JSON.stringify(messages)).not.toContain("NextPrivate8!");
  expect(messages[0]?.content).toBe(CHAT_SYSTEM_PROMPT);
  expect(() => assertOutboundSafe(messages, ctx)).not.toThrow();
});

test("chat message boundary is twenty transcript messages plus system and context, in original order", () => {
  const transcript: ChatTranscriptMessage[] = Array.from({ length: 25 }, (_, index) => ({
    mode: index % 3 ? "discuss" : "guide", role: index % 2 ? "assistant" : "user", content: `Turn ${index}`,
  }));
  const messages = buildChatMessages("discuss", recommendation(), null, transcript, { literals: [] });
  expect(messages).toHaveLength(22);
  expect(messages.slice(2)).toEqual(transcript.slice(-20).map(({ role, content }) => ({ role, content })));
  expect(buildChatMessages("discuss", recommendation(), null, [], { literals: [] })).toHaveLength(2);
  expect(buildChatMessages("discuss", recommendation(), null, transcript.slice(0, 20), { literals: [] })).toHaveLength(22);
});

function saveAnalysis(storedProfile: unknown = profile()): void {
  openDb().query(`INSERT INTO analyses (id, created_at, shell, stats, profile, messages, pseudonyms)
    VALUES (?, ?, 'bash', '{}', ?, '[]', ?)`).run("fixture-analysis", "2026-11-12T00:00:00.000Z", JSON.stringify(storedProfile),
      JSON.stringify({ "<path#1>": { type: "path", value: "/fixture/private-zq-project" } }));
}

test("loadAnalysis returns typed stored profile and local pseudonyms, or null when unavailable", () => withTempHome(() => {
  expect(loadAnalysis("missing")).toBeNull();
  saveAnalysis();
  expect(loadAnalysis("fixture-analysis")).toEqual({ profile: profile(),
    pseudonyms: { "<path#1>": { type: "path", value: "/fixture/private-zq-project" } } });
  openDb().query("UPDATE analyses SET profile = 'null' WHERE id = ?").run("fixture-analysis");
  expect(loadAnalysis("fixture-analysis")).toBeNull();
}));

test("loadAnalysis rejects malformed stored shapes and unsafe grammar, including extra properties", () => withTempHome(() => {
  saveAnalysis({ schema: "ghop-profile/1" });
  expect(() => loadAnalysis("fixture-analysis")).toThrow(GhopError);
  const bad = profile();
  bad.templates = [{ t: "acmecorp", n: 5, len: 8 }];
  openDb().query("UPDATE analyses SET profile = ? WHERE id = ?").run(JSON.stringify(bad), "fixture-analysis");
  expect(() => loadAnalysis("fixture-analysis")).toThrow(EgressBlockedError);
  openDb().query("UPDATE analyses SET profile = ? WHERE id = ?").run(JSON.stringify({ ...profile(), unsafe: "private-zq-value" }), "fixture-analysis");
  expect(() => loadAnalysis("fixture-analysis")).toThrow(EgressBlockedError);
  openDb().query("UPDATE analyses SET profile = '{broken' WHERE id = ?").run("fixture-analysis");
  expect(() => loadAnalysis("fixture-analysis")).toThrow("Stored analysis profile is invalid.");
}));

test("transcripts persist pseudonymized content and load the latest twenty for only the requested recommendation", () => withTempHome(() => {
  const first = insertRecs([recommendation()])[0]!;
  const second = insertRecs([recommendation({ topic: "tip:history", key: "history-search" })])[0]!;
  expect(loadChat(first.id)).toEqual([]);
  for (let index = 0; index < 25; index++) {
    appendChat(first.id, index % 3 ? "discuss" : "guide", index % 2 ? "assistant" : "user", `Turn ${index}: <path#1>`);
  }
  appendChat(second.id, "discuss", "user", "Other recommendation");
  const messages = loadChat(first.id);
  expect(messages).toHaveLength(20);
  expect(messages.map(message => message.content)).toEqual(Array.from({ length: 20 }, (_, index) => `Turn ${index + 5}: <path#1>`));
  expect(messages.every(message => message.recId === first.id)).toBe(true);
  expect(messages[0]).toMatchObject({ mode: "discuss", role: "assistant", content: "Turn 5: <path#1>" });
  expect(messages[1]?.mode).toBe("guide");
  expect(messages.every(message => Number.isFinite(Date.parse(message.at)))).toBe(true);
  expect(loadChat(second.id).map(message => message.content)).toEqual(["Other recommendation"]);
}));

test("appendChat validates identifiers, modes, roles, and content before writing; loadChat validates stored roles", () => withTempHome(() => {
  const rec = insertRecs([recommendation()])[0]!;
  expect(() => appendChat(0, "discuss", "user", "Invalid id")).toThrow();
  // @ts-expect-error Invalid external input must also be rejected at runtime.
  expect(() => appendChat(rec.id, "unknown", "user", "Invalid mode")).toThrow();
  // @ts-expect-error A stored system role would violate the static-system-prompt invariant.
  expect(() => appendChat(rec.id, "discuss", "system", "Invalid role")).toThrow();
  // @ts-expect-error SQLite coercion must not turn invalid content into a message.
  expect(() => appendChat(rec.id, "discuss", "user", 123)).toThrow();
  expect(loadChat(rec.id)).toEqual([]);
  expect(() => appendChat(rec.id + 999, "discuss", "user", "Missing recommendation")).toThrow();
  openDb().query("INSERT INTO chat_messages (rec_id, mode, role, content, at) VALUES (?, 'discuss', 'system', 'Invalid stored role', ?)")
    .run(rec.id, "2026-11-12T00:00:00.000Z");
  expect(() => loadChat(rec.id)).toThrow();
}));
