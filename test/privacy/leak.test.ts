import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { shellDump } from "../../src/core/paths.ts";
import { prepareAnalysis } from "../../src/llm/analyze.ts";
import { assertOutboundSafe, validateProfile } from "../../src/privacy/egress.ts";
import { withTempHome } from "../helpers/env.ts";

test("the full mixed-fixture profile and request contain no leak canaries", () => withTempHome(async home => {
  for (const kind of ["aliases", "info"] as const) {
    const target = shellDump("bash", kind);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(new URL(`../fixtures/shell/bash.${kind}`, import.meta.url), target);
  }
  const leaks = await Bun.file(new URL("../fixtures/history/leak-corpus.txt", import.meta.url)).text();
  const realistic = await Bun.file(new URL("../fixtures/history/realistic-bash.txt", import.meta.url)).text();
  const canaries = (await Bun.file(new URL("../fixtures/history/canaries.txt", import.meta.url)).text())
    .split(/\r?\n/).filter(Boolean);
  const file = join(home, "mixed-history.txt");
  await Bun.write(file, `${leaks}\n${realistic}`);

  const { profile, messages, stats } = await prepareAnalysis({ source: { shell: "bash", file }, slots: 8 }, {
    which: name => ["npm", "winget"].includes(name) ? `/fixture/${name}` : null,
  });
  expect(stats.entries).toBeGreaterThanOrEqual(147);
  expect(stats.kept).toBeGreaterThan(0);
  expect(profile.templates.length).toBeGreaterThan(0);
  expect(messages.some(message => message.role === "user" && message.content.includes(JSON.stringify(profile)))).toBe(true);
  expect(() => validateProfile(profile)).not.toThrow();
  expect(() => assertOutboundSafe(messages, {
    literals: canaries.map(value => ({ value, kind: "user-defined" })),
  })).not.toThrow();

  for (const payload of [JSON.stringify(profile), JSON.stringify(messages)]) {
    const lower = payload.toLowerCase();
    for (const canary of canaries) expect(lower).not.toContain(canary.toLowerCase());
  }
}));
