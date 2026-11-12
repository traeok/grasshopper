import { test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { withTempHome } from "../helpers/env.ts";
import { withStateSnapshot } from "../../src/core/db.ts";
import { configFile, dbFile, ghopHome } from "../../src/core/paths.ts";
import { getMeta, setMeta } from "../../src/core/state.ts";
import { loadConfig } from "../../src/core/config.ts";
import { writeTextAtomic } from "../../src/core/fsx.ts";

test("dry-run snapshot neither creates state nor advances existing state", async () => {
  await withTempHome(async () => {
    await withStateSnapshot(async () => {
      expect(getMeta("installSalt")).toMatch(/^[a-f0-9]{32}$/);
      setMeta("lastAnalysisId", "temporary");
    });
    expect(existsSync(dbFile())).toBe(false);
    setMeta("lastAnalysisId", "persistent");
    await withStateSnapshot(async () => {
      expect(getMeta("lastAnalysisId")).toBe("persistent");
      setMeta("lastAnalysisId", "temporary");
    });
    expect(getMeta("lastAnalysisId")).toBe("persistent");
  });
});

test("dry-run leaves malformed configuration untouched", async () => {
  await withTempHome(async () => {
    writeTextAtomic(configFile(), "broken-config");
    await withStateSnapshot(async () => { expect(loadConfig().llm.model).toBe("@smol"); });
    expect(readFileSync(configFile(), "utf8")).toBe("broken-config");
    expect(readdirSync(ghopHome())).toEqual(["config.json"]);
  });
});
