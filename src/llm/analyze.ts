import { spinner } from "@clack/prompts";
import { z } from "zod";
import { loadConfig } from "../core/config.ts";
import { ensureConsent } from "../core/consent.ts";
import { localDate } from "../core/dates.ts";
import { openDb, tx, withStateSnapshot } from "../core/db.ts";
import { EgressBlockedError, GhopError, OmpError } from "../core/errors.ts";
import { writeTextAtomic } from "../core/fsx.ts";
import { tryLock } from "../core/lock.ts";
import { log } from "../core/log.ts";
import { freshFlag } from "../core/paths.ts";
import { getMeta, getWatermark, setMeta, setWatermark, type Watermark } from "../core/state.ts";
import { readHistory } from "../history/parse.ts";
import { readShellDumps } from "../history/shell-dumps.ts";
import type { HistorySource } from "../history/source.ts";
import { computeFresh } from "../history/watermark.ts";
import { loadLedger, saveLedger, type Ledger } from "../history/ledger.ts";
import { detectEnvironment } from "../profile/environment.ts";
import { buildProfile } from "../profile/build.ts";
import { evidenceVocabulary, stableRef } from "../profile/evidence.ts";
import type { AnalysisStats, Profile } from "../profile/types.ts";
import { assertOutboundSafe, redactOutboundText, validateProfile } from "../privacy/egress.ts";
import { harvestSensitiveLiterals } from "../privacy/literals.ts";
import type { PseudonymMap } from "../privacy/pseudonyms.ts";
import { insertRecs, listRecs, topicExists, type RecommendationInput, type StoredRecommendation } from "../recs/store.ts";
import { canonicalTool, topicKey } from "../recs/topic.ts";
import { verifyTool } from "../recs/verify-tool.ts";
import { PHRASES } from "../ui/art.ts";
import { OmpGateway, type ChatMessage, type CompletionResult } from "./gateway.ts";
import { ANALYZE_SYSTEM_PROMPT, REPAIR_PROMPT } from "./prompts.ts";
import { actionKey, LlmRecommendation, type Action } from "./schema.ts";

export function buildAnalysisMessages(profile: Profile, slots: number): { role: "system" | "user" | "assistant"; content: string }[] {
  return [{ role: "system", content: ANALYZE_SYSTEM_PROMPT }, { role: "user", content: `Return at most ${slots} recommendations.\nProfile (JSON):\n${JSON.stringify(profile)}` }];
}
export interface PreparedAnalysis {
  messages: ChatMessage[];
  profile: Profile;
  pseudonyms: PseudonymMap;
  stats: AnalysisStats;
  freshCount: number;
  ledgerNext: Ledger;
  watermarkNext: Watermark;
}

export async function prepareAnalysis({ source, slots }: { source: HistorySource; slots: number }, deps: { which?: (n: string) => string | null } = {}): Promise<PreparedAnalysis> {
  const config = loadConfig();
  const salt = getMeta("installSalt");
  const entries = await readHistory(source, config.analysis.maxEntries);
  const dumps = readShellDumps(source.shell);
  const env = detectEnvironment(source.shell, dumps, deps.which);
  const { fresh, next } = computeFresh(entries, getWatermark(`${source.shell}:${source.file}`), salt);
  const built = buildProfile({ entries, source, dumps, ledger: loadLedger(), existing: listRecs({}), config, env, fresh, salt });
  const messages = buildAnalysisMessages(built.profile, slots);
  return { messages, profile: built.profile, pseudonyms: built.pseudonyms, stats: built.stats, freshCount: fresh.length, ledgerNext: built.ledgerNext, watermarkNext: next };
}

const PLACEHOLDER_TYPES = "path|url|host|cmd|alias|fn|arg|ref|pkg|script|var|str|num|val|glob|flag|subshell|heredoc";
const NUMBERED_PLACEHOLDER = new RegExp(`<(${PLACEHOLDER_TYPES})#\\d+>`, "g");
const genericPlaceholder = new RegExp(`<(${PLACEHOLDER_TYPES})>`);

/** Shared by analysis and chat proposals; only fully resolved, verified actions survive. */
export function sanitizeAction(
  action: Action | null | undefined,
  pseudonyms: PseudonymMap,
  packageManagers: readonly string[],
  tool?: StoredRecommendation["tool"],
): Action | null {
  if (!action) return null;
  const text = JSON.stringify(action);
  if ([...text.matchAll(NUMBERED_PLACEHOLDER)].some(([placeholder]) => !Object.hasOwn(pseudonyms, placeholder))) return null;
  if (genericPlaceholder.test(text)) return null;
  if (action.type === "install") {
    if (!packageManagers.includes(action.manager) || !tool) return null;
    const identifier = action.manager === "winget" ? tool.wingetId : action.manager === "npm" ? tool.npmPackage : tool.brewFormula;
    if (action.id !== identifier || tool.verification.checks[action.manager] !== "verified") return null;
    if (action.manager === "brew" && tool.verification.checks.github !== "verified") return null;
  }
  return action;
}

export function extractJson(content: string): unknown {
  const fenced = /```json\s*([\s\S]*?)```/i.exec(content);
  const candidate = fenced?.[1] ?? content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
  return JSON.parse(candidate);
}

const ResponseSchema = z.object({ recommendations: z.array(z.unknown()) });
interface AnalysisOptions {
  source: HistorySource;
  dryRun?: boolean;
  interactive?: boolean;
  yes?: boolean;
  background?: boolean;
}
interface AnalysisDeps {
  which?: (name: string) => string | null;
  verifyTool?: typeof verifyTool;
}
export type AnalysisResult = { added: StoredRecommendation[] } | { messages: ChatMessage[]; stats: PreparedAnalysis["stats"] };

// Exception messages may contain model output, subprocess stderr, or filesystem literals.
// Persist only this closed vocabulary and numeric status, never arbitrary error text.
function safeFailure(error: unknown): string {
  if (error instanceof OmpError) return `OmpError: request failed${Number.isInteger(error.status) ? ` (status ${error.status})` : ""}`;
  if (error instanceof EgressBlockedError) return "EgressBlockedError: outbound request blocked";
  if (error instanceof GhopError) return `GhopError: analysis failed (exit ${error.exitCode})`;
  return "Error: analysis failed";
}

function analysisId(now: Date): string {
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2, "0")).join("");
  return `${localDate(now).replaceAll("-", "")}-${time}-${Buffer.from(crypto.getRandomValues(new Uint8Array(2))).toString("hex")}`;
}

function insertAnalysis(
  id: string, createdAt: string, source: HistorySource, prepared: PreparedAnalysis | undefined,
  messages: ChatMessage[], completion: CompletionResult | undefined, error: string | null,
): void {
  openDb().query(`INSERT INTO analyses
    (id, created_at, shell, model, usage, stats, profile, messages, pseudonyms, response_text, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, createdAt, source.shell, completion?.model ?? null, completion?.usage ? JSON.stringify(completion.usage) : null,
      JSON.stringify(prepared?.stats ?? {}), JSON.stringify(prepared?.profile ?? null), JSON.stringify(messages),
      JSON.stringify(prepared?.pseudonyms ?? {}), completion?.content ?? null, error);
}

function pruneAnalyses(): void {
  openDb().exec(`DELETE FROM analyses
    WHERE id NOT IN (SELECT id FROM analyses ORDER BY created_at DESC, id DESC LIMIT 30)
    AND id NOT IN (SELECT analysis_id FROM recommendations WHERE status IN ('new','accepted'))`);
}

async function postprocess(
  values: unknown[], prepared: PreparedAnalysis, source: HistorySource, id: string, at: string,
  slots: number, verify: typeof verifyTool,
): Promise<RecommendationInput[]> {
  const vocabulary = evidenceVocabulary(prepared.profile);
  const salt = getMeta("installSalt");
  const topics = new Set<string>();
  const items: RecommendationInput[] = [];
  let invalid = 0;
  for (const value of values) {
    const parsed = LlmRecommendation.safeParse(value);
    if (!parsed.success) { invalid++; continue; }
    if (items.length >= slots) continue;
    const item = parsed.data;
    if (item.category === "tool" && !canonicalTool(item.tool)) continue;
    const replaceUnknown = (text: string) => text.replace(NUMBERED_PLACEHOLDER, (placeholder: string, type: string) =>
      Object.hasOwn(prepared.pseudonyms, placeholder) ? placeholder : `<${type}>`);
    const evidence = item.evidence.map(replaceUnknown).filter(ref => vocabulary.has(ref));
    const normalized = {
      ...item, title: replaceUnknown(item.title), summary: replaceUnknown(item.summary),
      rationale: replaceUnknown(item.rationale), steps: item.steps.map(replaceUnknown), evidence,
      action: sanitizeAction(item.action, prepared.pseudonyms, prepared.profile.environment.packageManagers) ?? undefined,
    };
    const topic = topicKey(normalized, prepared.pseudonyms, salt, vocabulary);
    if (topics.has(topic) || topicExists(topic)) continue;
    let tool: StoredRecommendation["tool"] = null;
    if (item.tool) {
      tool = await verify({ ...item.tool, name: replaceUnknown(item.tool.name) });
      if (!tool) continue;
    }
    const action = sanitizeAction(item.action, prepared.pseudonyms, prepared.profile.environment.packageManagers, tool);
    topics.add(topic);
    items.push({
      ...normalized, topic, analysisId: id, createdAt: at, updatedAt: at,
      actionKey: action ? actionKey(action) : null, action, tool,
      evidence: evidence.map(ref => stableRef(ref, prepared.pseudonyms, salt)),
      status: "new", seenAt: null, acceptMode: null, discardReason: null, shell: source.shell, applied: null,
    });
  }
  if (invalid > 0) log.warn(`invalid-items:${invalid}`);
  return items;
}

export async function runAnalysis(options: AnalysisOptions, deps: AnalysisDeps = {}): Promise<AnalysisResult> {
  // Include configuration/state reads and install-salt generation, not just preparation.
  return options.dryRun ? withStateSnapshot(() => executeAnalysis(options, deps)) : executeAnalysis(options, deps);
}

async function executeAnalysis(options: AnalysisOptions, deps: AnalysisDeps): Promise<AnalysisResult> {
  const { source, dryRun = false, interactive = false, yes = false, background = false } = options;
  let release: (() => void) | undefined;
  let prepared: PreparedAnalysis | undefined;
  let completion: CompletionResult | undefined;
  let sentMessages: ChatMessage[] = [];
  let committed = false;
  const now = new Date();
  const id = analysisId(now);
  const at = now.toISOString();
  try {
    const config = loadConfig();
    let slots = Math.min(config.analysis.maxRecommendations, 15 - listRecs({ status: "new" }).length);
    if (slots <= 0) {
      if (background && !dryRun) { log.info("backlog-full"); return { added: [] }; }
      throw new GhopError("You have 15 open recommendations; review some first (ghop).");
    }
    if (!dryRun) {
      const lock = tryLock("analyze", 900_000);
      if (!lock) {
        if (background) return { added: [] };
        throw new GhopError("An analysis is already running.");
      }
      release = lock;
    }
    const previousAt = getMeta("lastAnalysisAt");
    if (background && !dryRun && previousAt !== null
      && now.getTime() - Date.parse(previousAt) < config.analysis.minIntervalHours * 3_600_000) {
      log.info("analysis-too-soon");
      return { added: [] };
    }
    prepared = await prepareAnalysis({ source, slots }, deps);
    if (background && !dryRun && prepared.freshCount < config.analysis.minNewEntries) {
      log.info("not-enough-history");
      return { added: [] };
    }
    const literals = await harvestSensitiveLiterals(config);
    validateProfile(prepared.profile);
    assertOutboundSafe(prepared.messages, { literals });
    if (dryRun) return { messages: prepared.messages, stats: prepared.stats };
    await ensureConsent({ interactive: interactive && !background, yes, stats: prepared.stats });
    const gateway = new OmpGateway({
      command: config.llm.command, model: config.llm.model, timeoutMs: config.llm.timeoutSec * 1000, literals,
    });
    const indicator = !background && interactive ? spinner() : undefined;
    let values: unknown[];
    indicator?.start(PHRASES.analyzing);
    try {
      let messages = prepared.messages;
      let repaired = false;
      let reduced = false;
      for (;;) {
        assertOutboundSafe(messages, { literals });
        sentMessages = messages;
        completion = await gateway.complete(messages, { maxTokens: config.llm.maxTokensAnalysis });
        if (completion.finishReason === "length" && !reduced) {
          reduced = true;
          slots = Math.ceil(slots / 2);
          messages = buildAnalysisMessages(prepared.profile, slots);
          continue;
        }
        const parsed = (() => {
          try { return ResponseSchema.safeParse(extractJson(completion!.content)); }
          catch { return null; }
        })();
        if (parsed?.success) { values = parsed.data.recommendations; break; }
        if (repaired) throw new GhopError("The model did not return valid recommendations JSON.", 4);
        repaired = true;
        // Replies are untrusted too: a repair must never echo a model-produced secret.
        messages = [...messages,
          { role: "assistant", content: redactOutboundText(completion.content, { literals, pseudonyms: prepared.pseudonyms }).text },
          { role: "user", content: REPAIR_PROMPT }];
      }
      indicator?.stop(PHRASES.done);
    } catch (error) {
      indicator?.stop("Analysis failed.");
      throw error;
    }
    const items = await postprocess(values, prepared, source, id, at, slots, deps.verifyTool ?? verifyTool);
    const added = tx(() => {
      insertAnalysis(id, at, source, prepared, sentMessages, completion, null);
      const rows = insertRecs(items);
      setMeta("lastAnalysisAt", at);
      setMeta("lastAnalysisId", id);
      setMeta("lastAnalysisError", null);
      setWatermark(`${source.shell}:${source.file}`, prepared!.watermarkNext);
      saveLedger(prepared!.ledgerNext);
      pruneAnalyses();
      return rows;
    });
    committed = true;
    if (background && added.length > 0) {
      try { writeTextAtomic(freshFlag(), String(added.length)); }
      catch { log.warn("analysis-notification-failed"); }
    }
    return { added };
  } catch (error) {
    if (dryRun) throw error;
    const summary = safeFailure(error);
    if (!committed && release) {
      tx(() => {
        insertAnalysis(id, at, source, prepared, sentMessages, completion, summary);
        setMeta("lastAnalysisError", summary.slice(0, 120));
        pruneAnalyses();
      });
    }
    if (background) { log.warn("analysis-failed", { category: summary }); return { added: [] }; }
    throw error;
  } finally {
    release?.();
  }
}
