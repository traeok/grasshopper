import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { OmpGateway } from "../../src/llm/gateway.ts";
import { ANALYZE_SYSTEM_PROMPT } from "../../src/llm/prompts.ts";
import { EgressBlockedError, OmpError } from "../../src/core/errors.ts";
import { withTempHome } from "../helpers/env.ts";

const command = [process.execPath, resolve("test/helpers/fake-omp.ts")];
const messages = [{ role: "system" as const, content: ANALYZE_SYSTEM_PROMPT }, { role: "user" as const, content: "Return recommendations." }];
async function fixture(mode: string, fn: (gateway: OmpGateway, log: string) => Promise<void>, timeoutMs = 3000): Promise<void> {
  await withTempHome(async home => {
    const previous = { mode: process.env.FAKE_OMP_MODE, log: process.env.FAKE_OMP_LOG };
    const log = join(home, "gateway.jsonl");
    process.env.FAKE_OMP_MODE = mode;
    process.env.FAKE_OMP_LOG = log;
    try { await fn(new OmpGateway({ command, model: "@smol", timeoutMs, literals: [] }), log); }
    finally {
      if (previous.mode === undefined) delete process.env.FAKE_OMP_MODE; else process.env.FAKE_OMP_MODE = previous.mode;
      if (previous.log === undefined) delete process.env.FAKE_OMP_LOG; else process.env.FAKE_OMP_LOG = previous.log;
    }
  });
}
test("gateway ready handshake and chat response decode", async () => {
  await fixture("ok", async gateway => {
    expect(await gateway.handshake()).toEqual({ version: "fake" });
    expect(await gateway.complete(messages, { maxTokens: 100 })).toEqual({ content: '{"recommendations":[]}', model: "fixture-model", finishReason: "stop", usage: { prompt_tokens: 12, completion_tokens: 8 } });
  });
});
test("gateway status errors preserve status without swallowing failure", async () => {
  await fixture("error500", async gateway => {
    try { await gateway.complete(messages); throw new Error("expected error"); }
    catch (error) { expect(error).toBeInstanceOf(OmpError); expect((error as OmpError).status).toBe(500); }
  });
});
test("gateway kills timed out process", async () => {
  await fixture("timeout", async gateway => { await expect(gateway.complete(messages)).rejects.toThrow("omp timed out after 0.3s"); }, 300);
});
test("max_tokens rejection retries exactly once without that field", async () => {
  await fixture("max_tokens_reject", async (gateway, log) => {
    await gateway.complete(messages, { maxTokens: 100 });
    const bodies = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { max_tokens?: number });
    expect(bodies.map(b => b.max_tokens)).toEqual([100, undefined]);
  });
});
test("egress rejection occurs before any omp process can receive a request", async () => {
  await fixture("ok", async (gateway, log) => {
    await expect(gateway.complete([{ role: "system", content: "not a static system prompt" }])).rejects.toBeInstanceOf(EgressBlockedError);
    expect(existsSync(log)).toBe(false);
  });
});
