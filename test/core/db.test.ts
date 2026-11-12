import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { closeDb, openDb, tx } from "../../src/core/db.ts";
import { dbFile } from "../../src/core/paths.ts";
import { getMeta, getWatermark, setMeta, setWatermark } from "../../src/core/state.ts";
import { withTempHome } from "../helpers/env.ts";

function insertRecommendation(topic: string): number {
  return openDb().query(`
    INSERT INTO recommendations (
      topic, key, analysis_id, created_at, updated_at, status, category, title,
      summary, rationale, steps, impact, effort, evidence, shell
    ) VALUES (?, 'fixture', 'fixture-analysis', '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z',
      'new', 'alias', 'Use git status', 'Fixture summary', 'Fixture rationale', '[]', 'low', 'low', '[]', 'bash')
    ON CONFLICT(topic) DO NOTHING
  `).run(topic).changes;
}

describe("SQLite storage", () => {
  test("reuses the open handle and enables required pragmas", () => withTempHome(() => {
    const db = openDb();
    expect(openDb()).toBe(db);
    expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.query("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "1" });
  }));

  test("enforces permanent topic uniqueness in SQLite", () => withTempHome(() => {
    expect(insertRecommendation("alias:git status")).toBe(1);
    openDb().query("UPDATE recommendations SET status = 'discarded'").run();
    expect(insertRecommendation("alias:git status")).toBe(0);
    expect(insertRecommendation("alias:git diff")).toBe(1);
    expect(openDb().query("SELECT COUNT(*) AS n FROM recommendations").get()).toEqual({ n: 2 });
  }));

  test("enforces recommendation status and chat foreign keys", () => withTempHome(() => {
    insertRecommendation("alias:git status");
    expect(() => openDb().query("UPDATE recommendations SET status = 'unknown'").run()).toThrow();
    expect(() => openDb().query(`
      INSERT INTO chat_messages (rec_id, mode, role, content, at)
      VALUES (999, 'discuss', 'user', 'fixture', '2026-11-12T00:00:00Z')
    `).run()).toThrow();
  }));

  test("rolls back all writes when a transaction throws", () => withTempHome(() => {
    expect(() => tx(() => {
      setMeta("lastAnalysisId", "fixture-id");
      setWatermark("bash:fixture", { tailHashes: ["a"], lastTs: 12 });
      throw new Error("fixture rollback");
    })).toThrow("fixture rollback");
    expect(getMeta("lastAnalysisId")).toBeNull();
    expect(getWatermark("bash:fixture")).toBeUndefined();
    expect(tx(() => {
      setMeta("lastAnalysisId", "committed-id");
      return 42;
    })).toBe(42);
    expect(getMeta("lastAnalysisId")).toBe("committed-id");
  }));

  test("recovers a corrupt database without losing its backup", () => withTempHome(() => {
    const file = dbFile();
    writeFileSync(file, "not a SQLite database");
    expect(getMeta("lastAnalysisAt")).toBeNull();
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(dirname(file)).filter((name) => /^ghop\.db\.corrupt-\d+$/.test(name))).toHaveLength(1);
    expect(openDb().query("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "1" });
  }));

  test("switches memoized handles when the data-directory path changes", () => withTempHome(() => {
    const originalHome = process.env.GRASSHOPPER_HOME!;
    setMeta("lastAnalysisId", "first-home");
    const salt = getMeta("installSalt");
    process.env.GRASSHOPPER_HOME = join(originalHome, "other");
    expect(getMeta("lastAnalysisId")).toBeNull();
    expect(getMeta("installSalt")).not.toBe(salt);
    setMeta("lastAnalysisId", "second-home");
    process.env.GRASSHOPPER_HOME = originalHome;
    expect(getMeta("lastAnalysisId")).toBe("first-home");
    expect(getMeta("installSalt")).toBe(salt);
  }));

  test("round-trips typed metadata and source-specific watermarks", () => withTempHome(() => {
    expect(getMeta("installSalt")).toMatch(/^[a-f0-9]{32}$/);
    expect(getMeta("consent")).toBeNull();
    expect(getMeta("lastSource")).toBeNull();
    expect(getMeta("lastAnalysisAt")).toBeNull();
    expect(getMeta("lastAnalysisId")).toBeNull();
    expect(getMeta("lastAnalysisError")).toBeNull();
    expect(getMeta("ledgerFirstUntimedDay")).toBeNull();
    const consent = { granted: true as const, at: "2026-11-12T00:00:00Z" };
    const source = { shell: "zsh" as const, file: "fixture-history" };
    setMeta("consent", consent);
    setMeta("lastSource", source);
    setMeta("ledgerFirstUntimedDay", "2026-11-12");
    setWatermark("zsh:fixture-history", { tailHashes: ["0123456789abcdef"], lastTs: 123.456789 });
    setWatermark("bash:fixture-history", { tailHashes: [], lastTs: null });
    closeDb();
    expect(getMeta("consent")).toEqual(consent);
    expect(getMeta("lastSource")).toEqual(source);
    expect(getMeta("ledgerFirstUntimedDay")).toBe("2026-11-12");
    expect(getWatermark("zsh:fixture-history")).toEqual({ tailHashes: ["0123456789abcdef"], lastTs: 123.456789 });
    expect(getWatermark("bash:fixture-history")).toEqual({ tailHashes: [], lastTs: null });
    setWatermark("zsh:fixture-history", { tailHashes: ["fedcba9876543210"], lastTs: null });
    expect(getWatermark("zsh:fixture-history")).toEqual({ tailHashes: ["fedcba9876543210"], lastTs: null });
  }));

  test("rejects malformed persisted state without including its content", () => withTempHome(() => {
    openDb().query("INSERT INTO meta (key, value) VALUES ('consent', ?)").run('"private-fixture-value"');
    expect(() => getMeta("consent")).toThrow("Invalid stored metadata (consent).");
    openDb().query("INSERT INTO watermarks (source, tail_hashes, last_ts) VALUES (?, ?, NULL)")
      .run("fixture", "not-json");
    expect(() => getWatermark("fixture")).toThrow("Invalid stored history watermark.");
  }));
});

describe("withTempHome", () => {
  test("restores environment and removes directories after an async callback", async () => {
    const saved = Object.fromEntries(["HOME", "USERPROFILE", "GRASSHOPPER_HOME", "GHOP_SHELL", "GHOP_HISTFILE", "SHELL"]
      .map((key) => [key, process.env[key]]));
    let fixtureHome = "";
    await withTempHome(async (home) => {
      fixtureHome = home;
      expect(process.env.HOME).toBe(home);
      expect(process.env.USERPROFILE).toBe(home);
      expect(process.env.GHOP_SHELL).toBeUndefined();
      expect(process.env.GHOP_HISTFILE).toBeUndefined();
      expect(process.env.SHELL).toBeUndefined();
      await Promise.resolve();
      setMeta("lastAnalysisId", "async-home");
    });
    expect(existsSync(fixtureHome)).toBe(false);
    for (const [key, value] of Object.entries(saved)) expect(process.env[key]).toBe(value);
    withTempHome(() => expect(getMeta("lastAnalysisId")).toBeNull());
  });

  test("restores environment on sync and async failures", async () => {
    const savedHome = process.env.HOME;
    expect(() => withTempHome(() => { throw new Error("sync fixture"); })).toThrow("sync fixture");
    expect(process.env.HOME).toBe(savedHome);
    await expect(withTempHome(async () => { throw new Error("async fixture"); })).rejects.toThrow("async fixture");
    expect(process.env.HOME).toBe(savedHome);
  });
});
