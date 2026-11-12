import { expect, test } from "bun:test";
import { withTempHome } from "../helpers/env.ts";
import { ensureConsent } from "../../src/core/consent.ts";
import { getMeta } from "../../src/core/state.ts";
import type { AnalysisStats } from "../../src/profile/types.ts";

const stats: AnalysisStats = { entries: 33, kept: 11, fresh: 33, dropped: { secret: 16, "credential-command": 2, "registry-config": 2, "possible-password": 1, "leading-space": 1, oversized: 0, "user-rule": 0 }, secretRules: {}, pseudonyms: {}, grammarSkips: 0, payloadBytes: 100, unknownCommands: [] };
test("noninteractive analysis requires explicit consent and never silently grants it", async () => {
  await withTempHome(async () => {
    await expect(ensureConsent({ interactive: false, yes: false, stats })).rejects.toThrow("Consent required");
    expect(getMeta("consent")).toBeNull();
    await ensureConsent({ interactive: false, yes: true, stats });
    expect(getMeta("consent")?.granted).toBe(true);
    await ensureConsent({ interactive: false, yes: false, stats });
    expect(getMeta("consent")?.granted).toBe(true);
  });
});
