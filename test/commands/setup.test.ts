import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, saveConfig } from "../../src/core/config.ts";
import { GhopError, OmpError } from "../../src/core/errors.ts";
import { initFile, toShellPath } from "../../src/core/paths.ts";
import { getMeta, setMeta } from "../../src/core/state.ts";
import { runSetup } from "../../src/commands/setup.ts";
import { runAnalysis } from "../../src/llm/analyze.ts";
import { withTempHome } from "../helpers/env.ts";

async function withSetupFixture(home: string, work: (context: { log: string; output: string[]; activation: string[] }) => Promise<void>): Promise<void> {
  const saved = { log: process.env.FAKE_OMP_LOG, mode: process.env.FAKE_OMP_MODE, response: process.env.FAKE_OMP_RESPONSE_FILE };
  const log = join(home, "gateway.jsonl");
  const output: string[] = [];
  const activation: string[] = [];
  process.env.FAKE_OMP_LOG = log;
  process.env.FAKE_OMP_MODE = "ok";
  delete process.env.FAKE_OMP_RESPONSE_FILE;
  const config = loadConfig();
  config.llm.command = [process.execPath, resolve("test/helpers/fake-omp.ts")];
  saveConfig(config);
  writeFileSync(join(home, ".bash_history"), "git status\n".repeat(12));
  writeFileSync(join(home, ".zsh_history"), "git status\n".repeat(12));
  const stdout = spyOn(console, "log").mockImplementation((...args: unknown[]) => { output.push(args.join(" ")); });
  const stderr = spyOn(console, "error").mockImplementation((...args: unknown[]) => { output.push(args.join(" ")); });
  try {
    await work({ log, output, activation });
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    for (const [key, value] of [["FAKE_OMP_LOG", saved.log], ["FAKE_OMP_MODE", saved.mode], ["FAKE_OMP_RESPONSE_FILE", saved.response]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("setup", () => {
  test("--yes performs only handshake and integration, never reads history or grants consent", () => withTempHome((home) => withSetupFixture(home, async ({ log, output, activation }) => {
    writeFileSync(join(home, ".bash_profile"), "# profile");
    let analysisCalls = 0;
    await runSetup({ shell: "bash", yes: true }, {
      analyze: async () => { analysisCalls++; throw new Error("History must not be analyzed"); },
      confirm: async () => { throw new Error("--yes must not prompt"); },
      selectShell: async () => { throw new Error("--yes must not prompt"); },
      selectConsent: async () => { throw new Error("--yes must not request consent"); },
      outro: (message) => { activation.push(String(message)); },
    });
    expect(analysisCalls).toBe(0);
    expect(getMeta("consent")).toBeNull();
    expect(getMeta("lastAnalysisAt")).toBeNull();
    expect(getMeta("lastSource")).toBeNull();
    expect(readFileSync(log, "utf8")).toBe("{}\n");
    expect(existsSync(initFile("bash"))).toBe(true);
    expect(readFileSync(join(home, ".bashrc"), "utf8")).toContain("# >>> grasshopper >>>");
    expect(readFileSync(join(home, ".bash_profile"), "utf8")).toContain("test -f ~/.bashrc && . ~/.bashrc");
    expect(output.join("\n")).toContain("Shell integration for");
    expect(activation[0]).toContain(`source '${toShellPath(join(home, ".bashrc"), "bash")}'`);
  })));

  test("--yes preserves prior consent and uses detected shell", () => withTempHome((home) => withSetupFixture(home, async ({ activation }) => {
    process.env.GHOP_SHELL = "zsh";
    const consent = { granted: true as const, at: "2026-01-01T00:00:00.000Z" };
    setMeta("consent", consent);
    await runSetup({ yes: true }, { outro: (message) => { activation.push(String(message)); } });
    expect(getMeta("consent")).toEqual(consent);
    expect(existsSync(initFile("zsh"))).toBe(true);
    expect(existsSync(join(home, ".zshrc"))).toBe(true);
  })));

  test("handshake OmpError prints and continues with the platform default", () => withTempHome((home) => withSetupFixture(home, async ({ output }) => {
    await runSetup({ yes: true }, {
      handshake: async () => { throw new OmpError("fixture gateway unavailable"); },
      outro: () => {},
    });
    expect(output).toContain("fixture gateway unavailable");
    const shell = process.platform === "win32" ? "powershell" : "bash";
    expect(existsSync(initFile(shell))).toBe(true);
    expect(existsSync(shell === "powershell" ? process.env.GHOP_POWERSHELL_PROFILE! : join(home, ".bashrc"))).toBe(true);
    expect(getMeta("consent")).toBeNull();
  })));

  test("interactive preview can show payload then decline without sending or editing rc", () => withTempHome((home) => withSetupFixture(home, async ({ log, output }) => {
    const choices = ["payload", "none"] as const;
    let choice = 0;
    let initialShell: string | undefined;
    let confirmations = 0;
    const analyses: boolean[] = [];
    await runSetup({ shell: "bash" }, {
      requireTTY: () => {},
      selectShell: async (initial) => { initialShell = initial; return "bash"; },
      confirm: async () => { confirmations++; expect(output.join("\n")).toContain("# >>> grasshopper >>>"); return false; },
      selectConsent: async () => choices[choice++]!,
      analyze: async (options) => { analyses.push(!!options.dryRun); return runAnalysis(options, { which: () => null }); },
      outro: () => {},
    });
    expect(initialShell).toBe("bash");
    expect(confirmations).toBe(1);
    expect(analyses).toEqual([true]);
    expect(existsSync(join(home, ".bashrc"))).toBe(false);
    expect(output.join("\n")).toContain("Entries: 12");
    expect(output.join("\n")).toContain('"role": "system"');
    expect(getMeta("consent")).toBeNull();
    expect(getMeta("lastSource")).toBeNull();
    expect(readFileSync(log, "utf8")).toBe("{}\n");
  })));

  test("daily consent grants permission without sending, with separate profile confirmation", () => withTempHome((home) => withSetupFixture(home, async ({ log }) => {
    writeFileSync(join(home, ".bash_profile"), "# keep profile\n");
    const questions: string[] = [];
    await runSetup({ shell: "bash" }, {
      requireTTY: () => {},
      selectShell: async (initial) => initial,
      confirm: async (options) => { questions.push(options.message); return questions.length === 1; },
      selectConsent: async () => "daily",
      analyze: (options) => runAnalysis(options, { which: () => null }),
      outro: () => {},
    });
    expect(questions).toHaveLength(2);
    expect(questions[1]).toContain(".bash_profile");
    expect(readFileSync(join(home, ".bash_profile"), "utf8")).toBe("# keep profile\n");
    expect(getMeta("consent")?.granted).toBe(true);
    expect(getMeta("lastAnalysisAt")).toBeNull();
    expect(readFileSync(log, "utf8")).toBe("{}\n");
  })));

  test("Send now grants consent and runs foreground analysis against the fake gateway", () => withTempHome((home) => withSetupFixture(home, async ({ log }) => {
    const modes: boolean[] = [];
    await runSetup({ shell: "bash" }, {
      requireTTY: () => {},
      selectShell: async (initial) => initial,
      confirm: async () => true,
      selectConsent: async () => "send",
      analyze: (options) => { modes.push(!!options.dryRun); return runAnalysis({ ...options, interactive: false }, { which: () => null }); },
      outro: () => {},
    });
    expect(modes).toEqual([true, false]);
    expect(getMeta("consent")?.granted).toBe(true);
    expect(getMeta("lastAnalysisAt")).not.toBeNull();
    const requests = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({});
    expect(requests[1]).toHaveProperty("messages");
  })));

  test("invalid shell fails before integration or handshake", () => withTempHome((home) => withSetupFixture(home, async ({ log }) => {
    await expect(runSetup({ shell: "fish", yes: true })).rejects.toBeInstanceOf(GhopError);
    expect(existsSync(log)).toBe(false);
    expect(existsSync(initFile("bash"))).toBe(false);
  })));

  test("--yes remembers an explicit Atuin database without reading it or granting consent", () => withTempHome(home => withSetupFixture(home, async () => {
    const file = join(home, "selected-atuin.db");
    await runSetup({ shell: "bash", source: "atuin", histfile: file, yes: true }, {
      handshake: async () => ({ version: "fixture" }),
      analyze: async () => { throw new Error("History must not be read"); },
      outro: () => {},
    });
    expect(loadConfig().history).toEqual({ shell: null, source: "atuin", file });
    expect(getMeta("lastSource")).toEqual({ shell: "bash", file, kind: "atuin" });
    expect(getMeta("consent")).toBeNull();
    expect(existsSync(file)).toBe(false);
  })));

  test("declined explicit-source preview never persists source configuration", () => withTempHome(home => withSetupFixture(home, async () => {
    const file = join(home, "chosen-shell-history");
    writeFileSync(file, "git diff\n".repeat(12));
    await runSetup({ shell: "bash", source: "shell", histfile: file }, {
      handshake: async () => ({ version: "fixture" }),
      requireTTY: () => {},
      selectShell: async initial => initial,
      confirm: async () => false,
      selectConsent: async () => "none",
      analyze: async options => {
        expect(options.source).toEqual({ shell: "bash", file });
        expect(options.dryRun).toBe(true);
        return runAnalysis(options, { which: () => null });
      },
      outro: () => {},
    });
    expect(loadConfig().history).toEqual({ shell: null, source: "auto", file: null });
    expect(getMeta("lastSource")).toBeNull();
    expect(getMeta("lastAnalysisAt")).toBeNull();
  })));
});
