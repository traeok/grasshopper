import { z } from "zod";
import { isoNow } from "../core/dates.ts";
import { openDb } from "../core/db.ts";
import { GhopError } from "../core/errors.ts";
import { COMMANDS } from "../privacy/dictionary.ts";
import { redactOutboundText, validateProfile } from "../privacy/egress.ts";
import type { SensitiveLiteral } from "../privacy/literals.ts";
import type { PseudonymMap } from "../privacy/pseudonyms.ts";
import type { Profile } from "../profile/types.ts";
import { loadPseudonyms } from "../recs/pseudonyms.ts";
import { Status, type StoredRecommendation } from "../recs/store.ts";
import type { ChatMessage } from "./gateway.ts";
import { CHAT_SYSTEM_PROMPT, GUIDE_SYSTEM_PROMPT } from "./prompts.ts";
import { Action, Category } from "./schema.ts";

export const ChatMode = z.enum(["discuss", "guide"]);
export type ChatMode = z.infer<typeof ChatMode>;
const ChatRole = z.enum(["user", "assistant"]);
const RecId = z.number().int().positive();
const ChatTurn = z.object({ mode: ChatMode, role: ChatRole, content: z.string() });
export type ChatTranscriptMessage = z.infer<typeof ChatTurn>;
const StoredChatMessage = ChatTurn.extend({ id: RecId, recId: RecId, at: z.iso.datetime() });
export type StoredChatMessage = z.infer<typeof StoredChatMessage>;

export interface ChatAnalysis { profile: Profile; pseudonyms: PseudonymMap }
export interface ChatRedactionContext { literals: readonly SensitiveLiteral[]; pseudonyms?: PseudonymMap }

const count = z.number().int().nonnegative();
const trendItem = z.object({ c: z.string(), recent: count, baseline: count });
const template = z.object({ t: z.string(), n: count, len: count });
// Storage is untrusted JSON: grammar validation alone cannot check the wire shape.
const ProfileSchema: z.ZodType<Profile> = z.object({
  schema: z.literal("ghop-profile/1"),
  environment: z.object({
    shell: z.enum(["bash", "zsh", "powershell"]), shellVersion: z.string().nullable(),
    platform: z.enum(["windows-gitbash", "windows", "macos", "linux", "wsl"]), keymap: z.enum(["windows", "emacs", "vi", "unknown"]),
    frameworks: z.array(z.enum(["oh-my-zsh", "starship", "powerlevel10k"])),
    packageManagers: z.array(z.string()), installedTools: z.array(z.string()),
    history: z.object({ entries: count, timestamps: z.boolean(), sizeLimit: count.nullable(), fileLimit: count.nullable(),
      ignoreSpace: z.boolean().nullable(), ignoreDups: z.boolean().nullable(), appendIncremental: z.boolean().nullable(), shared: z.boolean().nullable() }),
    options: z.record(z.string(), z.boolean()),
  }),
  window: z.object({ entries: count, kept: count, dropped: count, spanDays: z.number().nonnegative().nullable() }),
  topCommands: z.array(z.object({ c: z.string(), n: count })),
  topSubcommands: z.array(z.object({ c: z.string(), n: count })),
  templates: z.array(template),
  aliasCandidates: z.array(template.extend({ savedChars: count, coveredBy: z.string().nullable() })),
  sequences: z.array(z.object({ seq: z.array(z.string()), n: count })),
  repeats: z.array(z.object({ t: z.string(), runs: count, maxRun: count })),
  paths: z.array(z.object({ p: z.string(), n: count, depth: count, viaCd: count })),
  hosts: z.array(z.object({ h: z.string(), n: count, via: z.array(z.string()) })),
  aliases: z.array(z.object({ a: z.string(), expands: z.string().nullable(), used: count, fullFormUsed: count })),
  functions: z.array(z.object({ f: z.string(), used: count })),
  typos: z.array(z.object({ typed: z.string(), meant: z.string(), n: count })),
  slow: z.array(z.object({ t: z.string(), n: count, avgSec: z.number().nonnegative() })),
  signals: z.record(z.enum(["historyGrep", "retypedWithSudo", "lastArgReuse", "cdUp", "cdUpChains", "cdThenLs", "mkdirThenCd",
    "clearScreen", "exitCommand", "uselessCat", "grepRecursive", "findByName", "psGrep", "manLookups", "helpLookups",
    "consecutiveRepeats", "longPipelines", "cdHome", "gitStatus", "gitAddAll", "dirStack"]), count),
  redFlags: z.array(z.object({ kind: z.enum(["inline-secret", "possible-password-typed", "secret-file-view", "curl-pipe-shell", "chmod-777",
    "rm-rf-risky", "force-push", "no-verify", "reset-hard", "git-clean-force", "tls-disabled", "sudo-npm-global", "docker-privileged",
    "eval-remote", "history-truncated", "leading-space-recorded"]), n: count })),
  trends: z.discriminatedUnion("available", [
    z.object({ available: z.literal(false), reason: z.literal("collecting") }),
    z.object({ available: z.literal(true), basis: z.enum(["timestamps", "ingestion-days"]), recentDays: z.literal(7), baselineDays: z.literal(28),
      rising: z.array(trendItem), falling: z.array(trendItem), new: z.array(trendItem) }),
  ]),
  memory: z.array(z.object({ category: Category, status: Status, evidence: z.array(z.string()), tool: z.string().nullable() })),
});

export function loadAnalysis(analysisId: string): ChatAnalysis | null {
  const row = z.object({ profile: z.string() }).nullable().parse(
    openDb().query("SELECT profile FROM analyses WHERE id = ?").get(analysisId),
  );
  if (!row) return null;
  let stored: unknown;
  try { stored = JSON.parse(row.profile); } catch { throw new GhopError("Stored analysis profile is invalid."); }
  if (stored === null) return null;
  const parsed = ProfileSchema.safeParse(stored);
  if (!parsed.success) throw new GhopError("Stored analysis profile is invalid.");
  // Validate the original object too, so parsing cannot hide unsafe extra keys or values.
  validateProfile(stored as Profile);
  return { profile: parsed.data, pseudonyms: loadPseudonyms(analysisId) };
}

function references(text: string): Set<string> {
  const result = new Set<string>();
  for (const [token] of text.matchAll(/<(?:path|url|host|cmd|alias|fn|arg|ref|pkg|script|var|str|num|val|glob|flag|subshell|heredoc)#\d+>|[A-Za-z0-9_+-]+(?:\.[A-Za-z0-9_+-]+)*/g)) {
    if (token.startsWith("<") || COMMANDS.has(token.toLowerCase())) result.add(token.toLowerCase());
  }
  return result;
}

export function buildContextMessage(rec: StoredRecommendation, analysis: ChatAnalysis | null): ChatMessage {
  const recommendation = {
    key: rec.key, category: rec.category, title: rec.title, summary: rec.summary, rationale: rec.rationale,
    steps: rec.steps, action: rec.action, tool: rec.tool,
  };
  if (!analysis) return { role: "user", content: "Context (JSON):\n" + JSON.stringify({ recommendation }) };
  const relevant = references(JSON.stringify([rec.title, rec.summary, rec.rationale, rec.steps, rec.action]));
  const profile = analysis.profile;
  const candidates = [...profile.templates, ...profile.aliasCandidates, ...profile.sequences, ...profile.paths,
    ...profile.hosts, ...profile.aliases, ...profile.typos, ...profile.slow];
  const matches = candidates.filter(item => [...references(JSON.stringify(item))].some(ref => relevant.has(ref))).slice(0, 20);
  return { role: "user", content: "Context (JSON):\n" + JSON.stringify({ recommendation, environment: profile.environment,
    evidence: { signals: profile.signals, redFlags: profile.redFlags, matches } }) };
}

export function buildChatMessages(
  mode: ChatMode, rec: StoredRecommendation, analysis: ChatAnalysis | null,
  transcript: readonly ChatTranscriptMessage[], ctx: ChatRedactionContext,
): ChatMessage[] {
  ChatMode.parse(mode);
  return [
    { role: "system", content: mode === "guide" ? GUIDE_SYSTEM_PROMPT : CHAT_SYSTEM_PROMPT },
    buildContextMessage(rec, analysis),
    ...transcript.slice(-20).map(message => ({ role: message.role,
      content: message.role === "assistant" ? redactOutboundText(message.content, ctx).text : message.content })),
  ];
}

/** Invalid blocks never replace an earlier valid proposal. */
export function extractActionProposal(reply: string): Action | null {
  let proposal: Action | null = null;
  for (const match of reply.matchAll(/^[ \t]*```ghop-action[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*\r?$/gm)) {
    let value: unknown;
    try { value = JSON.parse(match[1]!); } catch { continue; }
    const parsed = Action.safeParse(value);
    if (parsed.success) proposal = parsed.data;
  }
  return proposal;
}

/** Last twenty messages across both modes, restored to chronological order. */
export function loadChat(recId: number): StoredChatMessage[] {
  const rows = openDb().query(`SELECT id, rec_id AS recId, mode, role, content, at FROM chat_messages
    WHERE rec_id = ? ORDER BY id DESC LIMIT 20`).all(RecId.parse(recId));
  return rows.reverse().map(row => StoredChatMessage.parse(row));
}

/** Content must already be pseudonymized/redacted by the interactive caller. */
export function appendChat(recId: number, mode: ChatMode, role: "user" | "assistant", content: string): void {
  const id = RecId.parse(recId);
  const turn = ChatTurn.parse({ mode, role, content });
  openDb().query("INSERT INTO chat_messages (rec_id, mode, role, content, at) VALUES (?, ?, ?, ?, ?)")
    .run(id, turn.mode, turn.role, turn.content, isoNow());
}
