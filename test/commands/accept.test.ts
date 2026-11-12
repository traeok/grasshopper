import { expect, spyOn, test } from "bun:test";
import { withTempHome } from "../helpers/env.ts";
import { writeTextAtomic } from "../../src/core/fsx.ts";
import { shellDump } from "../../src/core/paths.ts";
import { insertRecs, getRec } from "../../src/recs/store.ts";
import { runAccept } from "../../src/commands/accept.ts";

test("automatic acceptance warns before replacing an alias captured by the real shell hook", async () => {
  await withTempHome(async () => {
    process.env.GHOP_SHELL = "bash";
    writeTextAtomic(shellDump("bash", "aliases"), "alias gstfixture='git log'\n");
    const now = new Date().toISOString();
    const [rec] = insertRecs([{ topic: "alias:git status", key: "git-status", actionKey: "alias:gstfixture", analysisId: "fixture", createdAt: now, updatedAt: now, status: "new", seenAt: null, acceptMode: null, discardReason: null, category: "alias", title: "Shorten Git status", summary: "Use an alias", rationale: "Repeated status", steps: [], impact: "medium", effort: "low", evidence: [], tool: null, action: { type: "alias", name: "gstfixture", command: "git status" }, shell: "bash", applied: null }]);
    const output: string[] = [];
    const print = spyOn(console, "log").mockImplementation((value: unknown) => { output.push(String(value)); });
    try {
      await runAccept(rec!.id, { mode: "auto", yes: true });
      expect(output.some(line => line.includes("overrides existing alias gstfixture"))).toBe(true);
      expect(getRec(rec!.id).status).toBe("implemented");
    } finally { print.mockRestore(); }
  });
});
