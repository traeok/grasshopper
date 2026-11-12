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
test("doctor exercises gateway handshake, optional model ping, and counts-only history diagnostic", async () => {
  await withTempHome(async home => {
    const config = loadConfig();
    config.llm.command = [process.execPath, resolve("test/helpers/fake-omp.ts")];
    config.history = { shell: "bash", file: join(home, "history") };
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
});
