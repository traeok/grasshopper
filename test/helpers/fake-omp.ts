import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { z } from "zod";
const Request = z.object({ id: z.string(), path: z.string(), body: z.object({ max_tokens: z.number().optional() }).passthrough().optional() });
console.log(JSON.stringify({ ready: true, version: "fake" }));
for await (const line of createInterface({ input: process.stdin })) {
  const req = Request.parse(JSON.parse(line));
  if (process.env.FAKE_OMP_LOG) appendFileSync(process.env.FAKE_OMP_LOG, JSON.stringify(req.body ?? {}) + "\n");
  const mode = process.env.FAKE_OMP_MODE ?? "ok";
  if (mode === "timeout") { await Bun.sleep(60000); continue; }
  if (req.path === "/v1/models") { console.log(JSON.stringify({ id: req.id, status: 200, body: { data: [] } })); continue; }
  if (mode === "error500") { console.log(JSON.stringify({ id: req.id, status: 500, body: { error: { message: "fixture failure" } } })); continue; }
  if (mode === "max_tokens_reject" && req.body?.max_tokens !== undefined) {
    console.log(JSON.stringify({ id: req.id, status: 400, body: { error: { message: "max_tokens unsupported" } } })); continue;
  }
  const content = mode === "badjson" ? "not a JSON recommendation" : process.env.FAKE_OMP_RESPONSE_FILE ? await Bun.file(process.env.FAKE_OMP_RESPONSE_FILE).text() : '{"recommendations":[]}';
  console.log(JSON.stringify({ id: req.id, status: 200, body: { model: "fixture-model", choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 8 } } }));
}
