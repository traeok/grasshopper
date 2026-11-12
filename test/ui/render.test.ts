import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { saveConfig, loadConfig } from "../../src/core/config.ts";
import { openDb } from "../../src/core/db.ts";
import type { PseudonymMap } from "../../src/privacy/pseudonyms.ts";
import { renderText } from "../../src/recs/pseudonyms.ts";
import type { StoredRecommendation } from "../../src/recs/store.ts";
import { renderBanner, renderCard, renderMarkdownLite, renderRow } from "../../src/ui/render.ts";
import { bold, categoryColors, dim, sprout, stem, wheat } from "../../src/ui/style.ts";
import { withTempHome } from "../helpers/env.ts";

function recommendation(patch: Partial<StoredRecommendation> = {}): StoredRecommendation {
  return {
    id: 12, topic: "alias:cd fixture", key: "jump-to-project", actionKey: "alias:proj", analysisId: "analysis-first",
    createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:00:00Z", evidence: [], status: "new", seenAt: null,
    acceptMode: null, discardReason: null, category: "alias", title: "Jump to <path#1>", summary: "Visit <path#1> faster",
    rationale: "You visited <path#1> 12 times", steps: ["Define proj", "Use proj"], impact: "high", effort: "low",
    tool: null, action: { type: "alias", name: "proj", command: "cd <path#1>" }, shell: "bash", applied: null, ...patch,
  };
}

function saveMap(id: string, value: string): void {
  openDb().query("INSERT INTO analyses (id, created_at, shell, stats, profile, messages, pseudonyms) VALUES (?, '2026-11-12', 'bash', '{}', '{}', '[]', ?)")
    .run(id, JSON.stringify({ "<path#1>": { type: "path", value } }));
}

const map: PseudonymMap = { "<path#1>": { type: "path", value: "/work/project" } };

describe("recommendation rendering", () => {
  test("rows load the map belonging to each recommendation's own analysis", () => withTempHome(() => {
    saveMap("analysis-first", "/work/first");
    saveMap("analysis-second", "/work/second");
    expect(stripVTControlCharacters(renderRow(recommendation()))).toBe("  #12  alias      Jump to /work/first  high");
    expect(stripVTControlCharacters(renderRow(recommendation({ analysisId: "analysis-second" })))).toContain("Jump to /work/second");
    expect(stripVTControlCharacters(renderRow(recommendation({ analysisId: "deleted" })))).toContain("Jump to <path#1>");
  }));

  test("all six categories use the palette and category padding", () => withTempHome(() => {
    for (const category of ["workflow", "alias", "tip", "red-flag", "tool", "shortcut"] as const) {
      const rec = recommendation({ category, title: "Fixture title", analysisId: "deleted" });
      expect(renderRow(rec)).toBe(`  #${wheat("12")}  ${categoryColors[category](category.padEnd(9))}  Fixture title  ${dim("high")}`);
    }
  }));

  test("cards include metadata, rendered explanations, numbered steps and a copyable alias", () => {
    const card = stripVTControlCharacters(renderCard(recommendation(), map));
    for (const part of ["#12 Jump to /work/project", "alias · high impact/low effort · new", "Visit /work/project faster", "Why: You visited /work/project 12 times", "1. Define proj", "2. Use proj", "Change:\n│ alias proj='cd /work/project'"]) expect(card).toContain(part);
    expect(card).not.toContain("original values no longer available");
    const quoted = stripVTControlCharacters(renderCard(recommendation(), { "<path#1>": { type: "path", value: "/work/Bob's project" } }));
    expect(quoted).toContain('│ alias proj=\'cd "/work/Bob\'\\\'\'s project"\'');
  });

  test("cards preserve unresolved placeholders and explain unavailable originals", () => {
    const card = renderCard(recommendation(), {});
    expect(card).toContain(dim("<path#1>"));
    expect(card).toContain(dim("(original values no longer available)"));
    expect(stripVTControlCharacters(card)).toContain("│ alias proj='cd <path#1>'");
  });

  test("snippet previews resolve their lines and install previews use fixed argv", () => {
    const snippet = stripVTControlCharacters(renderCard(recommendation({ action: { type: "snippet", description: "Jump helper", lines: ["proj() {", "  cd <path#1>", "}"] } }), map));
    expect(snippet).toContain("Change:\n│ proj() {\n│   cd /work/project\n│ }");
    for (const [manager, command] of [
      ["npm", "npm install --global fixture-tool"],
      ["winget", "winget install --id fixture-tool --exact --source winget"],
      ["brew", "brew install fixture-tool"],
    ] as const) {
      const card = stripVTControlCharacters(renderCard(recommendation({ action: { type: "install", manager, id: "fixture-tool", initLines: ["cd <path#1>"] } }), map));
      expect(card).toContain(`Change:\n│ ${command}\n│ cd /work/project`);
    }
    const untrusted = stripVTControlCharacters(renderCard(recommendation({ action: { type: "install", manager: "npm", id: "fixture; echo not-executed", initLines: [] } }), map));
    expect(untrusted).toContain("npm install --global 'fixture; echo not-executed'");
  });

  test("tool details include verified licenses or an unverified badge", () => {
    const tool = {
      name: "Fixture Tool", githubRepo: "fixture/tool", npmPackage: "fixture-tool", wingetId: "Fixture.Tool", brewFormula: "fixture-tool",
      verification: { status: "verified" as const, license: "MIT", checkedAt: "2026-11-12", checks: { github: "verified" as const } },
    };
    const card = stripVTControlCharacters(renderCard(recommendation({ category: "tool", tool }), map));
    expect(card).toContain("Fixture Tool · github.com/fixture/tool · npm fixture-tool · winget Fixture.Tool · brew fixture-tool");
    expect(card).toContain("✓ verified open source (MIT)");
    const unverified = stripVTControlCharacters(renderCard(recommendation({ tool: { ...tool, verification: { ...tool.verification, status: "unverified", license: null } } }), map));
    expect(unverified).toContain("? unverified");
  });

  test("banners respect daily.maxItems, pending totals, per-analysis maps and error guidance", () => withTempHome(() => {
    const config = loadConfig();
    config.daily.maxItems = 1;
    config.ui.emoji = false;
    saveConfig(config);
    saveMap("analysis-first", "/work/first");
    saveMap("analysis-second", "/work/second");
    const rows = [recommendation(), recommendation({ id: 13, analysisId: "analysis-second" })];
    const banner = stripVTControlCharacters(renderBanner(rows, 2, "OmpError: unavailable"));
    expect(banner).toContain("~o grasshopper · 2 new recommendations");
    expect(banner).toContain("Jump to /work/first");
    expect(banner).not.toContain("Jump to /work/second");
    expect(banner).toContain("   +1 more");
    expect(banner).toContain("ghop to review · ghop chat 12 · ghop accept 12");
    expect(banner).toContain("Last background analysis failed: OmpError: unavailable. Run ghop doctor");
    expect(stripVTControlCharacters(renderBanner([rows[0]!], 1, null))).toContain("1 new recommendation\n");
    expect(stripVTControlCharacters(renderBanner([], 0, "unavailable"))).toContain("0 new recommendations");
  }));

  test("markdown formats emphasis, inline code, bullets and literal fenced blocks", () => {
    expect(renderMarkdownLite("**Practice** `git status`\n- Repeat\n```bash\necho **literal**\n- literal\n```"))
      .toBe(`${bold("Practice")} ${sprout("git status")}\n• Repeat\n${stem("│ ")}echo **literal**\n${stem("│ ")}- literal`);
    expect(stripVTControlCharacters(renderMarkdownLite("**Practice**"))).toBe("Practice");
    expect(renderMarkdownLite(renderText("Visit <path#1>", map))).toBe(`Visit ${sprout("/work/project")}`);
  });

  test("theme colors survive markdown while raw literal escape sequences do not", () => {
    const saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR, COLORTERM: process.env.COLORTERM };
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    process.env.COLORTERM = "truecolor";
    try {
      const safe = renderText("Visit <path#1>", { "<path#1>": { type: "path", value: "/work/\x1b[31mproject\x1b[0m" } });
      expect(safe).toContain("\x1b[");
      expect(safe).toBe(`Visit ${sprout("/work/project")}`);
      expect(renderMarkdownLite(safe)).toBe(safe);
      expect(renderMarkdownLite(`${safe}\x1b[2J`)).toBe(safe);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("untrusted terminal instructions never survive rows, cards, banners or markdown", () => withTempHome(() => {
    const attack = "\x1b[2J\x1b]52;c;bad\x07\r\b";
    saveMap("analysis-first", `/work/${attack}safe`);
    const rec = recommendation({ summary: `Visit ${attack}<path#1>` });
    for (const output of [renderRow(rec), renderCard(rec, { "<path#1>": { type: "path", value: `/work/${attack}safe` } }), renderBanner([rec], 1, attack), renderMarkdownLite(`hello${attack}world`)]) {
      expect(output).not.toContain("\x1b[2J");
      expect(output).not.toContain("\x1b]52;");
      expect(output).not.toContain("\x07");
      expect(output).not.toContain("\r");
      expect(output).not.toContain("\b");
    }
    expect(renderMarkdownLite(`hello${attack}world`)).toBe("helloworld");
  }));
});
