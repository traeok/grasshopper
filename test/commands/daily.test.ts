import { expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { withTempHome } from "../helpers/env.ts";
import { localDate } from "../../src/core/dates.ts";
import { dailyStamp, freshFlag, initFile } from "../../src/core/paths.ts";
import { writeTextAtomic } from "../../src/core/fsx.ts";
import { getMeta, setMeta } from "../../src/core/state.ts";
import { insertRecs } from "../../src/recs/store.ts";
import type { RecommendationInput } from "../../src/recs/store.ts";
import { runDaily } from "../../src/commands/daily.ts";
import { runNotify } from "../../src/commands/notify.ts";
import { INIT_VERSION } from "../../src/shell/init.ts";

function rec(key: string): RecommendationInput {
  const now = new Date().toISOString();
  return { topic: `tip:key:${key}`, key, actionKey: null, analysisId: "fixture", createdAt: now, updatedAt: now, evidence: [], status: "new", seenAt: null, acceptMode: null, discardReason: null, category: "tip", title: `Practice ${key}`, summary: "Fixture advice", rationale: "Observed usage", steps: [], impact: "medium", effort: "low", tool: null, action: null, shell: "bash", applied: null };
}
test("daily claims one banner and background launch per local day, refreshing init version", async () => {
  await withTempHome(async () => {
    insertRecs([rec("history-search"), rec("navigation")]);
    setMeta("consent", { granted: true, at: new Date().toISOString() });
    process.env.GHOP_SHELL = "bash";
    writeTextAtomic(initFile("bash"), "# ghop-init v0 old\n");
    const now = new Date(); let launches = 0;
    const output: string[] = [];
    const print = spyOn(console, "log").mockImplementation((value: unknown) => { output.push(String(value)); });
    try {
      await runDaily({ now: () => now, spawnBackground: () => { launches++; } });
      expect(output.join("\n")).toContain("Practice history-search");
      expect(output.join("\n")).toContain("Practice navigation");
      expect(readFileSync(dailyStamp(), "utf8")).toBe(localDate(now) + "\n");
      expect(readFileSync(initFile("bash"), "utf8").startsWith(`# ghop-init v${INIT_VERSION} `)).toBe(true);
      expect(launches).toBe(1);
      output.length = 0;
      await runDaily({ now: () => now, spawnBackground: () => { launches++; } });
      expect(output).toEqual([]);
      expect(launches).toBe(1);
    } finally { print.mockRestore(); }
  });
});
test("daily never launches without consent or before the twenty-hour interval", async () => {
  for (const consent of [false, true]) await withTempHome(async () => {
    if (consent) setMeta("consent", { granted: true, at: new Date().toISOString() });
    if (consent) setMeta("lastAnalysisAt", new Date(Date.now() - 3600000).toISOString());
    let launches = 0;
    await runDaily({ spawnBackground: () => { launches++; } });
    expect(launches).toBe(0);
    expect(getMeta("lastAnalysisAt") === null).toBe(!consent);
  });
});
test("fresh notifications consume their flag and print only once", async () => {
  await withTempHome(() => {
    writeTextAtomic(freshFlag(), "2");
    const output: string[] = [];
    const print = spyOn(console, "log").mockImplementation((value: unknown) => { output.push(String(value)); });
    try { runNotify(); runNotify(); expect(output).toHaveLength(1); expect(output[0]).toContain("2 fresh recommendations"); expect(existsSync(freshFlag())).toBe(false); }
    finally { print.mockRestore(); }
  });
});
