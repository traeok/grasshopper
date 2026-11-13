import { expect, spyOn, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig, saveConfig } from "../../src/core/config.ts";
import { openDb } from "../../src/core/db.ts";
import { GhopError } from "../../src/core/errors.ts";
import { tryLock } from "../../src/core/lock.ts";
import { dbFile, freshFlag, logFile, shellDump } from "../../src/core/paths.ts";
import { getMeta, getWatermark, setMeta } from "../../src/core/state.ts";
import { loadLedger } from "../../src/history/ledger.ts";
import type { HistorySource } from "../../src/history/source.ts";
import { runAnalysis, sanitizeAction } from "../../src/llm/analyze.ts";
import { OmpGateway, type ChatMessage } from "../../src/llm/gateway.ts";
import { REPAIR_PROMPT } from "../../src/llm/prompts.ts";
import type { Action, LlmRecommendation, ToolRef } from "../../src/llm/schema.ts";
import type { Profile } from "../../src/profile/types.ts";
import { listRecs, updateRec, type StoredRecommendation } from "../../src/recs/store.ts";
import { withTempHome } from "../helpers/env.ts";

const which = (name: string) => ["npm", "winget"].includes(name) ? `/fixture/${name}` : null;
const verify = async (tool: ToolRef): Promise<StoredRecommendation["tool"]> => ({
  ...tool, verification: { status: "verified", license: "MIT", checkedAt: "2026-11-12T00:00:00.000Z",
    checks: Object.fromEntries(([ ["github", tool.githubRepo], ["npm", tool.npmPackage], ["winget", tool.wingetId], ["brew", tool.brewFormula] ] as const)
      .filter(([, identifier]) => identifier !== undefined).map(([manager]) => [manager, "verified" as const])) },
});
const deps = { which, verifyTool: verify };

function recommendation(patch: Partial<LlmRecommendation> = {}): LlmRecommendation {
  return { key: "use-history-search", category: "tip", title: "Search your history", summary: "Use reverse history search.",
    rationale: "You repeatedly searched history with grep.", steps: ["Press Ctrl+R."], impact: "medium", effort: "low",
    evidence: ["signal:historyGrep"], ...patch };
}
const canned = [
  recommendation({ key: "alias-git-status", category: "alias", title: "Use a status alias", evidence: ["template:git status"], action: { type: "alias", name: "gs", command: "git status" } }),
  recommendation({ key: "install-public-tool", category: "tool", title: "Try a public CLI tool", tool: { name: "npm-check-updates", npmPackage: "npm-check-updates" },
    action: { type: "install", manager: "npm", id: "npm-check-updates", initLines: [] } }),
  recommendation({ key: "visit-frequent-path", category: "workflow", title: "Return to <path#99>", summary: "Keep <path#99> nearby.",
    evidence: ["not:valid"], action: { type: "alias", name: "proj", command: "cd <path#99>" } }),
  { key: "invalid", category: "not-a-category", title: "Invalid item" },
];
interface Fixture {
  home: string;
  source: HistorySource;
  log: string;
  respond: (items: unknown[]) => void;
  requests: () => { messages: ChatMessage[]; max_tokens?: number }[];
  run: (background?: boolean) => Promise<StoredRecommendation[]>;
}
async function fixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  await withTempHome(async home => {
    for (const kind of ["aliases", "info"] as const) {
      const target = shellDump("bash", kind);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(new URL(`../fixtures/shell/bash.${kind}`, import.meta.url), target);
    }
    const text = ["leak-corpus.txt", "realistic-bash.txt"].map(name => readFileSync(new URL(`../fixtures/history/${name}`, import.meta.url), "utf8")).join("\n");
    const file = join(home, "fixture-history.txt");
    writeFileSync(file, text);
    const source: HistorySource = { shell: "bash", file };
    const config = loadConfig();
    config.llm.command = [process.execPath, resolve("test/helpers/fake-omp.ts")];
    saveConfig(config);
    setMeta("consent", { granted: true, at: new Date().toISOString() });
    const saved = { FAKE_OMP_MODE: process.env.FAKE_OMP_MODE, FAKE_OMP_LOG: process.env.FAKE_OMP_LOG, FAKE_OMP_RESPONSE_FILE: process.env.FAKE_OMP_RESPONSE_FILE };
    const response = join(home, "response.json");
    const log = join(home, "requests.jsonl");
    process.env.FAKE_OMP_MODE = "ok";
    process.env.FAKE_OMP_LOG = log;
    process.env.FAKE_OMP_RESPONSE_FILE = response;
    const respond = (items: unknown[]) => writeFileSync(response, JSON.stringify({ recommendations: items }));
    respond(canned);
    try {
      await fn({ home, source, log, respond,
        requests: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [],
        run: async (background = false) => {
          const result = await runAnalysis({ source, interactive: false, yes: false, background }, deps);
          if (!("added" in result)) throw new Error("Unexpected dry-run result");
          return result.added;
        },
      });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
}

function requestProfile(messages: ChatMessage[]): Profile {
  const user = messages.find(message => message.role === "user")!;
  return JSON.parse(user.content.slice(user.content.indexOf("Profile (JSON):\n") + "Profile (JSON):\n".length)) as Profile;
}

test("analysis stores three valid canned items, scrubs unknown placeholders, guards bodies, and deduplicates", async () => {
  await fixture(async f => {
    const added = await f.run();
    expect(added).toHaveLength(3);
    expect(added.find(item => item.category === "workflow")).toMatchObject({ title: "Return to <path>", summary: "Keep <path> nearby.", action: null, evidence: [] });
    expect(added.find(item => item.category === "alias")?.action).toEqual({ type: "alias", name: "gs", command: "git status" });
    expect(added.find(item => item.category === "tool")?.tool?.verification.status).toBe("verified");
    expect(added.find(item => item.category === "tool")?.action).toEqual({ type: "install", manager: "npm", id: "npm-check-updates", initLines: [] });
    const bodies = readFileSync(f.log, "utf8").toLowerCase();
    for (const canary of readFileSync(new URL("../fixtures/history/canaries.txt", import.meta.url), "utf8").trim().split(/\r?\n/)) expect(bodies).not.toContain(canary.toLowerCase());
    expect(readFileSync(logFile(), "utf8")).toContain("invalid-items:1");
    expect(getWatermark(`bash:${f.source.file}`)).toBeDefined();
    expect(Object.keys(loadLedger().days)).toHaveLength(1);
    expect(getMeta("lastAnalysisId")).toMatch(/^\d{8}-\d{6}-[a-f0-9]{4}$/);
    const row = openDb().query<{ messages: string; model: string; error: string | null }, [string]>("SELECT messages, model, error FROM analyses WHERE id = ?").get(getMeta("lastAnalysisId")!);
    expect(JSON.parse(row!.messages)).toEqual(f.requests()[0]!.messages);
    expect(row?.model).toBe("fixture-model");
    expect(row?.error).toBeNull();
    expect(await f.run()).toHaveLength(0);
    expect(listRecs()).toHaveLength(3);
  });
});

test("discarded alias memory survives rewording and a different alias name, with canonical tool memory", async () => {
  await fixture(async f => {
    const first = await f.run();
    updateRec(first.find(item => item.category === "alias")!.id, { status: "discarded", discardReason: "not-relevant" });
    f.respond([{ ...canned[0], key: "status-shortcut-renamed", title: "Check status faster", action: { type: "alias", name: "gst", command: "git status" } }, canned[1]]);
    expect(await f.run()).toHaveLength(0);
    const memory = requestProfile(f.requests()[1]!.messages).memory;
    expect(memory).toContainEqual(expect.objectContaining({ category: "alias", status: "discarded", discardReason: "not-relevant",
      adoption: [], evidence: expect.arrayContaining(["template:git status"]) }));
    expect(memory).toContainEqual(expect.objectContaining({ category: "tool", tool: "npm:npm-check-updates" }));
  });
});

test("evidence identity deduplicates a reworded evidence-only shortcut", async () => {
  await fixture(async f => {
    f.respond([recommendation({ category: "shortcut" })]);
    const [first] = await f.run();
    expect(first?.topic).toBe("shortcut:signal:historyGrep");
    f.respond([recommendation({ category: "shortcut", key: "different-wording", title: "Recall commands faster" })]);
    expect(await f.run()).toHaveLength(0);
  });
});

test("invalid JSON repairs once and failure records never advance watermark or ledger", async () => {
  await fixture(async f => {
    process.env.FAKE_OMP_MODE = "badjson";
    try { await f.run(); throw new Error("expected analysis error"); }
    catch (error) { expect(error).toBeInstanceOf(GhopError); expect((error as GhopError).message).toBe("The model did not return valid recommendations JSON."); expect((error as GhopError).exitCode).toBe(4); }
    const requests = f.requests();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.at(-1)).toEqual({ role: "user", content: REPAIR_PROMPT });
    expect(getWatermark(`bash:${f.source.file}`)).toBeUndefined();
    expect(loadLedger().days).toEqual({});
    expect(getMeta("lastAnalysisAt")).toBeNull();
    expect(getMeta("lastAnalysisError")).toBe("GhopError: analysis failed (exit 4)");
    expect(openDb().query("SELECT id FROM analyses WHERE error IS NOT NULL").all()).toHaveLength(1);
    expect(listRecs()).toHaveLength(0);
  });
});

test("dry-run sends nothing, grants no consent, and does not create persistent state", async () => {
  await withTempHome(async home => {
    const source: HistorySource = { shell: "bash", file: join(home, "history.txt") };
    writeFileSync(source.file, "git status\ngit status\n");
    const result = await runAnalysis({ source, dryRun: true, yes: true }, { which });
    expect("messages" in result).toBe(true);
    expect(existsSync(dbFile())).toBe(false);
    expect(existsSync(join(process.env.GRASSHOPPER_HOME!, "locks"))).toBe(false);
    expect(getMeta("consent")).toBeNull();
    expect(openDb().query("SELECT key FROM meta WHERE key = 'installSalt'").all()).toHaveLength(0);
  });
});

test("consent is required outside a TTY and --yes explicitly grants it", async () => {
  await fixture(async f => {
    setMeta("consent", null);
    await expect(f.run()).rejects.toMatchObject({ exitCode: 5 });
    expect(f.requests()).toHaveLength(0);
    expect(getWatermark(`bash:${f.source.file}`)).toBeUndefined();
    const result = await runAnalysis({ source: f.source, yes: true }, deps);
    expect("added" in result && result.added.length).toBe(3);
    expect(getMeta("consent")?.granted).toBe(true);
  });
});

test("held analysis locks reject foreground runs and silently skip background runs", async () => {
  await fixture(async f => {
    const release = tryLock("analyze", 900_000)!;
    try {
      await expect(f.run()).rejects.toThrow("An analysis is already running.");
      expect(await f.run(true)).toHaveLength(0);
      expect(f.requests()).toHaveLength(0);
      expect(openDb().query("SELECT id FROM analyses").all()).toHaveLength(0);
    } finally { release(); }
    f.respond([]);
    expect(await f.run()).toHaveLength(0);
  });
});

test("background cadence skips recent analyses and insufficient fresh history, then advances on success", async () => {
  await fixture(async f => {
    f.respond([]);
    await f.run();
    const watermark = getWatermark(`bash:${f.source.file}`);
    const ledger = loadLedger();
    f.respond([recommendation()]);
    expect(await f.run(true)).toHaveLength(0);
    expect(f.requests()).toHaveLength(1);
    setMeta("lastAnalysisAt", "2000-01-01T00:00:00.000Z");
    expect(await f.run(true)).toHaveLength(0);
    expect(f.requests()).toHaveLength(1);
    expect(getWatermark(`bash:${f.source.file}`)).toEqual(watermark);
    expect(loadLedger()).toEqual(ledger);
    writeFileSync(f.source.file, readFileSync(f.source.file, "utf8") + "\n" + "git diff\n".repeat(50));
    expect(await f.run(true)).toHaveLength(1);
    expect(f.requests()).toHaveLength(2);
    expect(readFileSync(freshFlag(), "utf8")).toBe("1");
    expect(getMeta("lastAnalysisAt")).not.toBe("2000-01-01T00:00:00.000Z");
  });
});

test("a full open backlog never sends another request", async () => {
  await fixture(async f => {
    const config = loadConfig();
    config.analysis.maxRecommendations = 15;
    saveConfig(config);
    f.respond(Array.from({ length: 15 }, (_, i) => recommendation({ key: `unique-${i}`, evidence: [] })));
    expect(await f.run()).toHaveLength(15);
    await expect(f.run()).rejects.toThrow("You have 15 open recommendations; review some first (ghop).");
    expect(await f.run(true)).toHaveLength(0);
    expect(f.requests()).toHaveLength(1);
  });
});

test("failed atomic insertion rolls back recommendations, watermark, and ledger while retaining a safe error record", async () => {
  await fixture(async f => {
    openDb().exec("CREATE TRIGGER fail_recommendation BEFORE INSERT ON recommendations BEGIN SELECT RAISE(ABORT, 'zq-model-sensitive-error'); END");
    await expect(f.run()).rejects.toThrow();
    expect(listRecs()).toHaveLength(0);
    expect(getWatermark(`bash:${f.source.file}`)).toBeUndefined();
    expect(loadLedger().days).toEqual({});
    expect(getMeta("lastAnalysisAt")).toBeNull();
    expect(getMeta("lastAnalysisError")).toBe("Error: analysis failed");
    const errors = openDb().query<{ error: string }, []>("SELECT error FROM analyses").all();
    expect(errors).toEqual([{ error: "Error: analysis failed" }]);
    openDb().exec("DROP TRIGGER fail_recommendation");
    expect(await f.run()).toHaveLength(3);
  });
});

test("background errors are swallowed and logged as safe class/status metadata only", async () => {
  await fixture(async f => {
    process.env.FAKE_OMP_MODE = "error500";
    expect(await f.run(true)).toHaveLength(0);
    expect(getMeta("lastAnalysisError")).toBe("OmpError: request failed (status 500)");
    expect(readFileSync(logFile(), "utf8")).not.toContain("fixture failure");
    expect(getWatermark(`bash:${f.source.file}`)).toBeUndefined();
  });
});

test("length retry halves slots once before parsing and repair never sends model-produced secrets", async () => {
  await fixture(async f => {
    const observed: ChatMessage[][] = [];
    const complete = spyOn(OmpGateway.prototype, "complete").mockImplementation(async messages => {
      observed.push(messages);
      if (observed.length === 1) return { content: "{truncated", model: "fixture", finishReason: "length", usage: null };
      if (observed.length === 2) return { content: "not json ghp_Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LzXcVb", model: "fixture", finishReason: "stop", usage: null };
      return { content: "```json\n" + JSON.stringify({ recommendations: [recommendation()] }) + "\n```", model: "fixture", finishReason: "stop", usage: null };
    });
    try {
      expect(await f.run()).toHaveLength(1);
      expect(observed).toHaveLength(3);
      expect(observed[0]![1]!.content).toStartWith("Return at most 8 recommendations.");
      expect(observed[1]![1]!.content).toStartWith("Return at most 4 recommendations.");
      expect(JSON.stringify(observed[2])).not.toContain("ghp_Zx9Qw8");
      expect(observed[2]!.at(-1)?.content).toBe(REPAIR_PROMPT);
    } finally { complete.mockRestore(); }
  });
});

test("postprocessing removes generic actions, unsupported installs, rejected tools, and identifier-free tools", async () => {
  await fixture(async f => {
    f.respond([
      recommendation({ key: "generic-action", evidence: [], action: { type: "alias", name: "proj", command: "cd <path>" } }),
      recommendation({ key: "brew-unavailable", category: "tool", tool: { name: "ripgrep", githubRepo: "BurntSushi/ripgrep", brewFormula: "ripgrep" }, action: { type: "install", manager: "brew", id: "ripgrep", initLines: [] } }),
      recommendation({ key: "mismatched-id", category: "tool", tool: { name: "npm tool", npmPackage: "some-public-package" }, action: { type: "install", manager: "npm", id: "different-package", initLines: [] } }),
      recommendation({ key: "missing-id", category: "tool", tool: { name: "no identifiers" } }),
      recommendation({ key: "rejected-tool", category: "tool", tool: { name: "rejected", npmPackage: "rejected" } }),
    ]);
    const result = await runAnalysis({ source: f.source }, { which, verifyTool: async tool => tool.npmPackage === "rejected" ? null : verify(tool) });
    expect("added" in result && result.added.length).toBe(3);
    expect(listRecs().every(item => item.action === null)).toBe(true);
  });
});

test("action sanitization requires known placeholders and exact registry-specific verification", async () => {
  const map = { "<path#1>": { type: "path" as const, value: "/fixture/project" } };
  const alias: Action = { type: "alias", name: "proj", command: "cd <path#1>" };
  expect(sanitizeAction(alias, map, [])).toEqual(alias);
  expect(sanitizeAction(alias, {}, [])).toBeNull();
  expect(sanitizeAction({ ...alias, command: "cd <path>" }, map, [])).toBeNull();
  const tool = (await verify({ name: "rg", githubRepo: "BurntSushi/ripgrep", brewFormula: "ripgrep" }))!;
  const install: Action = { type: "install", manager: "brew", id: "ripgrep", initLines: [] };
  expect(sanitizeAction(install, {}, ["brew"], tool)).toEqual(install);
  expect(sanitizeAction(install, {}, [], tool)).toBeNull();
  expect(sanitizeAction(install, {}, ["brew"], { ...tool, verification: { ...tool.verification, checks: { brew: "verified", github: "unknown" } } })).toBeNull();
});

test("analysis retention preserves old open recommendations while pruning unreferenced records", async () => {
  await fixture(async f => {
    const added = await f.run();
    const protectedId = added[0]!.analysisId;
    openDb().query("UPDATE analyses SET created_at = ? WHERE id = ?").run("1990-01-01T00:00:00.000Z", protectedId);
    const insert = openDb().query("INSERT INTO analyses (id, created_at, shell, stats, profile, messages, pseudonyms) VALUES (?, ?, 'bash', '{}', 'null', '[]', '{}')");
    for (let i = 0; i < 35; i++) insert.run(`old-${i}`, new Date(Date.UTC(2000, 0, i + 1)).toISOString());
    f.respond([]);
    await f.run();
    expect(openDb().query("SELECT id FROM analyses").all()).toHaveLength(31);
    expect(openDb().query("SELECT id FROM analyses WHERE id = ?").get(protectedId)).not.toBeNull();
    expect(openDb().query("SELECT id FROM analyses WHERE id = 'old-0'").get()).toBeNull();
  });
});

test("first daily background analysis still requires fifty new history entries", async () => {
  await fixture(async f => {
    writeFileSync(f.source.file, "git status\n".repeat(49));
    expect(getMeta("lastAnalysisAt")).toBeNull();
    expect(await f.run(true)).toEqual([]);
    expect(f.requests()).toEqual([]);
    expect(getMeta("lastAnalysisAt")).toBeNull();
    expect(getWatermark(`${f.source.shell}:${f.source.file}`)).toBeUndefined();
  });
});
