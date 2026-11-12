import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { withTempHome } from "../helpers/env.ts";
import { loadConfig, setConfigValue, getConfigValue, unsetConfigValue } from "../../src/core/config.ts";
import { configFile } from "../../src/core/paths.ts";

test("configuration validates edits and restores defaults", async () => {
  await withTempHome(() => {
    expect(loadConfig().llm.model).toBe("@smol");
    setConfigValue("analysis.maxRecommendations", "12");
    expect(getConfigValue("analysis.maxRecommendations")).toBe(12);
    expect(() => setConfigValue("analysis.maxRecommendations", "16")).toThrow();
    expect(getConfigValue("analysis.maxRecommendations")).toBe(12);
    unsetConfigValue("analysis.maxRecommendations");
    expect(getConfigValue("analysis.maxRecommendations")).toBe(8);
    expect(existsSync(configFile())).toBe(true);
    expect(() => setConfigValue("privacy.extraDropPatterns", '["["]')).toThrow();
  });
});
