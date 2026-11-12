import { z } from "zod";
import { GhopError } from "./errors.ts";
import { configFile } from "./paths.ts";
import { readJson, writeTextAtomic } from "./fsx.ts";

const positive = z.number().int().positive();
const dropPattern = z.string().refine(p => { try { new RegExp(p, "i"); return true; } catch { return false; } }, "Must be a valid regular expression");
export const ConfigSchema = z.object({
  llm: z.object({ command: z.array(z.string().min(1)).min(1).default(["omp"]), model: z.string().min(1).default("@smol"), timeoutSec: positive.default(180), maxTokensAnalysis: positive.default(8000), maxTokensChat: positive.default(2000) }).strict().prefault({}),
  analysis: z.object({ auto: z.boolean().default(true), maxRecommendations: positive.max(15).default(8), minIntervalHours: z.number().nonnegative().default(20), minNewEntries: positive.default(50), maxEntries: positive.default(20000) }).strict().prefault({}),
  daily: z.object({ enabled: z.boolean().default(true), maxItems: positive.default(5) }).strict().prefault({}),
  automation: z.object({ enabled: z.boolean().default(true), defaultMode: z.enum(["self", "guided", "auto"]).default("self") }).strict().prefault({}),
  privacy: z.object({ pseudonymMinCount: positive.default(3), allowWords: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,30}$/)).default([]), extraSensitiveLiterals: z.array(z.string()).default([]), extraDropPatterns: z.array(dropPattern).default([]) }).strict().prefault({}),
  history: z.object({ source: z.enum(["auto", "shell", "atuin"]).default("auto"), shell: z.enum(["bash", "zsh", "powershell"]).nullable().default(null), file: z.string().nullable().default(null) }).strict().prefault({}),
  ui: z.object({ emoji: z.boolean().default(true) }).strict().prefault({}),
}).strict();
export type Config = z.infer<typeof ConfigSchema>;
export function loadConfig(): Config { return readJson(configFile(), ConfigSchema, ConfigSchema.parse({})); }
function validated(value: unknown): Config {
  const result = ConfigSchema.safeParse(value);
  if (!result.success) throw new GhopError(result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  return result.data;
}
export function saveConfig(cfg: Config): void { writeTextAtomic(configFile(), JSON.stringify(validated(cfg), null, 2) + "\n"); }
function parts(dotPath: string): string[] {
  const p = dotPath.split(".");
  if (p.some(k => !k || ["__proto__", "prototype", "constructor"].includes(k))) throw new GhopError("Invalid configuration key.");
  return p;
}
export function getConfigValue(dotPath: string): unknown {
  let current: unknown = loadConfig();
  for (const p of parts(dotPath)) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, p)) throw new GhopError(`Unknown configuration key: ${dotPath}`);
    current = (current as Record<string, unknown>)[p];
  }
  return current;
}
function change(dotPath: string, raw: string | undefined): void {
  getConfigValue(dotPath);
  const cfg = loadConfig() as unknown as Record<string, unknown>;
  const keys = parts(dotPath); const leaf = keys.pop()!;
  let node = cfg;
  for (const k of keys) node = node[k] as Record<string, unknown>;
  if (raw === undefined) delete node[leaf];
  else { let value: unknown = raw; try { value = JSON.parse(raw); } catch {} node[leaf] = value; }
  saveConfig(validated(cfg));
}
export function setConfigValue(dotPath: string, raw: string): void { change(dotPath, raw); }
export function unsetConfigValue(dotPath: string): void { change(dotPath, undefined); }
