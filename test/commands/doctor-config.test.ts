import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { withTempHome } from "../helpers/env.ts";
import { loadConfig, saveConfig } from "../../src/core/config.ts";

async function cli(args: string[]) {
  const proc = Bun.spawn([process.execPath, resolve("src/cli.ts"), ...args], { env: { ...process.env, FAKE_OMP_MODE: "ok", FAKE_OMP_RESPONSE_FILE: "", FAKE_OMP_LOG: "", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}
test("config CLI validates writes and preserves prior valid settings after failure", async () => {
  await withTempHome(async () => {
    expect((await cli(["config", "set", "analysis.maxRecommendations", "12"])).code).toBe(0);
    expect((await cli(["config", "get", "analysis.maxRecommendations"])).stdout.trim()).toBe("12");
    const bad = await cli(["config", "set", "analysis.maxRecommendations", "16"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("analysis.maxRecommendations");
    expect(loadConfig().analysis.maxRecommendations).toBe(12);
    await cli(["config", "unset", "analysis.maxRecommendations"]);
    expect(loadConfig().analysis.maxRecommendations).toBe(8);
    expect(JSON.parse((await cli(["config", "list"])).stdout).llm.model).toBe("@smol");
  });
});
test("config allow preserves existing words, deduplicates additions, and rejects invalid batches atomically", async () => {
  await withTempHome(async () => {
    const config = loadConfig();
    config.privacy.allowWords = ["companycli"];
    saveConfig(config);
    expect((await cli(["config", "allow", "jj", "jj"])).code).toBe(0);
    expect(loadConfig().privacy.allowWords).toEqual(["companycli", "jj"]);
    expect((await cli(["config", "allow", "local-tool", "invalid/word"])).code).toBe(1);
    expect(loadConfig().privacy.allowWords).toEqual(["companycli", "jj"]);
  });
});

test("unknown commands stay local until the dry-run and doctor allowlist suggestion is applied", async () => {
  await withTempHome(async home => {
    const config = loadConfig();
    config.llm.command = ["ghop-missing-test-gateway"];
    config.privacy.allowWords = ["companycli"];
    config.history = { source: "shell", shell: "bash", file: join(home, "history") };
    saveConfig(config);
    writeFileSync(config.history.file!, "local-tool status\nlocal-tool log\ngit status\ncompanycli status\n".repeat(4)
      + "hidden-tool login\n private-tool status\n");
    const preview = await cli(["analyze", "--dry-run"]);
    expect(preview.code).toBe(0);
    expect(preview.stderr).toContain('Top unknown commands (local only): [{"c":"local-tool","n":8}]');
    expect(preview.stdout).not.toContain("local-tool");
    const profile = JSON.parse(JSON.parse(preview.stdout)[1].content.split("Profile (JSON):\n")[1]);
    expect(profile.topCommands).toContainEqual({ c: "<cmd>", n: 8 });
    const doctor = await cli(["doctor"]);
    expect(doctor.stdout).toContain('Top unknown commands (local only): [{"c":"local-tool","n":8}]');
    for (const hidden of ["hidden-tool", "private-tool"]) {
      expect(preview.stderr).not.toContain(hidden);
      expect(doctor.stdout).not.toContain(hidden);
    }
    const suggestion = preview.stderr.match(/^  ghop (config allow .+)$/m)![1]!;
    expect(doctor.stdout).toContain(`ghop ${suggestion}`);
    expect((await cli(suggestion.split(" "))).code).toBe(0);
    expect(loadConfig().privacy.allowWords).toEqual(["companycli", "local-tool"]);
    const allowed = await cli(["analyze", "--dry-run"]);
    expect(allowed.code).toBe(0);
    expect(allowed.stderr).toContain("Top unknown commands (local only): []");
    const allowedProfile = JSON.parse(JSON.parse(allowed.stdout)[1].content.split("Profile (JSON):\n")[1]);
    expect(allowedProfile.topCommands).toContainEqual({ c: "local-tool", n: 8 });
  });
});

test("doctor exercises gateway handshake, optional model ping, and filtered history diagnostics", async () => {
  await withTempHome(async home => {
    const config = loadConfig();
    config.llm.command = [process.execPath, resolve("test/helpers/fake-omp.ts")];
    config.history = { source: "shell", shell: "bash", file: join(home, "history") };
    saveConfig(config);
    writeFileSync(config.history.file!, "git status\nnpm test\n");
    const result = await cli(["doctor", "--ping"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("omp fake");
    expect(result.stdout).toContain("Model fixture-model");
    expect(result.stdout).toContain("2 entries");
    expect(result.stdout).toContain("consent not granted");
    expect(result.stdout).not.toContain("git status");
    expect(result.stdout).toContain("Last analysis: never");
  });
}, 30000);
