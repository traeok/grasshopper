import { OmpError } from "../core/errors.ts";
import { assertOutboundSafe } from "../privacy/egress.ts";
import type { SensitiveLiteral } from "../privacy/literals.ts";
import { z } from "zod";

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }
export interface CompletionResult { content: string; model: string | null; finishReason: string | null; usage: { prompt_tokens?: number; completion_tokens?: number } | null }
let nextId = 0;
const ReplySchema = z.object({ id: z.string().nullable().optional(), status: z.number(), body: z.unknown() });
type GatewayReply = z.infer<typeof ReplySchema>;
const CompletionSchema = z.object({
  model: z.string().nullable().optional(),
  choices: z.array(z.object({ message: z.object({ content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]) }), finish_reason: z.string().nullable().optional() })).min(1),
  usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() }).nullable().optional(),
});

export class OmpGateway {
  constructor(private readonly opts: { command: string[]; model: string; timeoutMs: number; literals: SensitiveLiteral[] }) {}

  private async exchange(path: string, body?: unknown): Promise<{ version: string; reply: GatewayReply }> {
    let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      proc = Bun.spawn([...this.opts.command, "auth-gateway", "stdio"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true, env: process.env });
    } catch {
      throw new OmpError("omp not found. Install it with `npm i -g @oh-my-pi/pi-coding-agent`, run `omp login`, and pick a smol model in omp.");
    }
    let stderr = "";
    const stderrTask = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stderr) if (stderr.length < 200) stderr += decoder.decode(chunk).slice(0, 200 - stderr.length);
    })().catch(() => {});
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let ended = false;
    const readLine = async (): Promise<string | null> => {
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline >= 0) { const line = buffer.slice(0, newline).replace(/\r$/, ""); buffer = buffer.slice(newline + 1); return line; }
        if (ended) { const line = buffer; buffer = ""; return line || null; }
        const chunk = await reader.read();
        ended = chunk.done;
        buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      }
    };
    const terminate = () => {
      if (proc.exitCode !== null) return;
      if (process.platform === "win32") Bun.spawnSync(["taskkill", "/pid", String(proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", windowsHide: true });
      else proc.kill();
    };
    const deadline = async <T>(work: Promise<T>, ms: number, startup = false): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([work, new Promise<never>((_, reject) => {
          timer = setTimeout(() => { terminate(); reject(new OmpError(startup ? `omp did not start: ${stderr || "ready handshake timed out; omp with auth-gateway stdio is required (omp ≥ 18.4); run omp update"}` : `omp timed out after ${ms / 1000}s`)); }, ms);
        })]);
      } finally { clearTimeout(timer); }
    };
    try {
      const first = await deadline(readLine(), 30_000, true);
      let ready: { ready?: boolean; version?: string };
      try { ready = JSON.parse(first ?? "null"); } catch { throw new OmpError(`omp did not start: ${stderr || "invalid ready response; omp with auth-gateway stdio is required (omp ≥ 18.4); run omp update"}`); }
      if (!ready?.ready) throw new OmpError(`omp did not start: ${stderr || "omp with auth-gateway stdio is required (omp ≥ 18.4); run omp update"}`);
      const id = `ghop-${++nextId}`;
      proc.stdin.write(JSON.stringify({ id, path, ...(path === "/v1/models" ? { method: "GET" } : {}), ...(body === undefined ? {} : { body }) }) + "\n");
      proc.stdin.end();
      const reply = await deadline((async (): Promise<GatewayReply> => {
        while (true) {
          const line = await readLine();
          if (line === null) throw new OmpError("omp closed before returning a response.");
          let value: GatewayReply;
          try { value = ReplySchema.parse(JSON.parse(line)); } catch { throw new OmpError("omp returned invalid gateway JSON."); }
          if (value.id === id) {
            return value;
          }
        }
      })(), this.opts.timeoutMs);
      await deadline(proc.exited, this.opts.timeoutMs);
      return { version: ready.version ?? "unknown", reply };
    } finally {
      terminate();
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      await stderrTask;
    }
  }

  async handshake(): Promise<{ version: string }> {
    const { version, reply } = await this.exchange("/v1/models");
    if (reply.status !== 200) throw new OmpError("omp model gateway handshake failed. Run `omp update` and `omp login`.", reply.status);
    return { version };
  }

  async complete(messages: ChatMessage[], opts: { maxTokens?: number } = {}): Promise<CompletionResult> {
    assertOutboundSafe(messages, { literals: this.opts.literals });
    for (let attempt = 0; attempt < 2; attempt++) {
      const { reply } = await this.exchange("/v1/chat/completions", { model: this.opts.model, messages, ...(attempt === 0 && opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}) });
      if (reply.status !== 200) {
        const parsed = z.object({ error: z.union([z.string(), z.object({ message: z.string() })]) }).safeParse(reply.body);
        const message = parsed.success ? (typeof parsed.data.error === "string" ? parsed.data.error : parsed.data.error.message) : "Unknown gateway error";
        if (attempt === 0 && reply.status === 400 && /max_tokens/i.test(message)) continue;
        throw new OmpError(message, reply.status);
      }
      const parsed = CompletionSchema.safeParse(reply.body);
      if (!parsed.success) throw new OmpError("omp returned no assistant text.");
      const choice = parsed.data.choices[0]!;
      const content = choice.message.content;
      const text = typeof content === "string" ? content : content.filter(p => p.type === "text").map(p => p.text ?? "").join("");
      return { content: text, model: parsed.data.model ?? null, finishReason: choice.finish_reason ?? null, usage: parsed.data.usage ?? null };
    }
    throw new OmpError("omp rejected the completion request.");
  }
}
