import type { Config } from "../core/config.ts";
import { localDate } from "../core/dates.ts";
import type { HistoryEntry } from "../history/parse.ts";
import type { HistorySource } from "../history/source.ts";
import type { ShellDumps } from "../history/shell-dumps.ts";
import { addToLedger, computeTrends, type Ledger } from "../history/ledger.ts";
import { splitCommands, tokenize } from "../history/tokenize.ts";
import { classifyEntry } from "../privacy/classify.ts";
import { COMMANDS, SUBCOMMANDS, isKnownWord } from "../privacy/dictionary.ts";
import { isSafeString } from "../privacy/grammar.ts";
import { normalizeEntry, type NormEntry } from "../privacy/normalize.ts";
import { assignPseudonyms, renderTemplate, type PseudonymMap } from "../privacy/pseudonyms.ts";
import type { StoredRecommendation } from "../recs/store.ts";
import { buildMemory } from "./evidence.ts";
import { detectSignals } from "./signals.ts";
import { detectRedFlags } from "./red-flags.ts";
import type { AnalysisStats, Profile } from "./types.ts";
import { prepareEntries } from "./entries.ts";
import { contiguous, rankSequences, telemetryPatterns } from "./telemetry.ts";

// Optimal-string-alignment distance includes adjacent transpositions (gti → git).
function distance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) rows[i]![0] = i;
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    rows[i]![j] = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + Number(a[i - 1] !== b[j - 1]));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i]![j] = Math.min(rows[i]![j]!, rows[i - 2]![j - 2]! + 1);
  }
  return rows[a.length]![b.length]!;
}
const ranked = (counts: Map<string, number>, cap: number) => [...counts].sort(([a, an], [b, bn]) => bn - an || a.localeCompare(b)).slice(0, cap).map(([c, n]) => ({ c, n }));

export function buildProfile(input: {
  entries: HistoryEntry[]; source: HistorySource; dumps: ShellDumps; ledger: Ledger;
  existing: StoredRecommendation[]; config: Config; env: Profile["environment"];
  fresh: HistoryEntry[]; salt: string; which?: (name: string) => string | null;
}): { profile: Profile; pseudonyms: PseudonymMap; stats: AnalysisStats; kept: NormEntry[]; ledgerNext: Ledger } {
  const { entries, source, dumps, config, salt } = input;
  const { ctx, classifications, kept, unknownCommands } = prepareEntries(entries, source.shell, dumps);
  const stats: AnalysisStats = { entries: entries.length, kept: 0, fresh: input.fresh.length, dropped: { secret: 0, "credential-command": 0, "registry-config": 0, "possible-password": 0, "leading-space": 0, oversized: 0, "user-rule": 0 }, secretRules: {}, pseudonyms: {}, grammarSkips: 0, payloadBytes: 0, unknownCommands };
  const safe = (s: string) => { if (isSafeString(s)) return true; stats.grammarSkips++; return false; };
  for (const classification of classifications) {
    if (classification.drop) stats.dropped[classification.drop]++;
    if (classification.secretRule) stats.secretRules[classification.secretRule] = (stats.secretRules[classification.secretRule] ?? 0) + 1;
  }
  stats.kept = kept.length;
  const pseudonyms = assignPseudonyms(kept, ctx.aliases, config.privacy.pseudonymMinCount);
  for (const p of Object.values(pseudonyms)) stats.pseudonyms[p.type] = (stats.pseudonyms[p.type] ?? 0) + 1;
  const idByLiteral = new Map(Object.entries(pseudonyms).map(([id, p]) => [`${p.type}\0${p.value}`, id]));
  const commands = new Map<string, number>(), subs = new Map<string, number>();
  const templates = new Map<string, { n: number; chars: number; seconds: number; timed: number }>();
  const rendered = kept.map(e => renderTemplate(e, pseudonyms));
  const valid = rendered.map(s => safe(s));
  const paths = new Map<string, { p: string; n: number; depth: number; viaCd: number }>();
  const hosts = new Map<string, { h: string; n: number; via: string[] }>();
  kept.forEach((e, i) => {
    const t = rendered[i]!;
    if (valid[i]) {
      const aggregate = templates.get(t) ?? { n: 0, chars: 0, seconds: 0, timed: 0 };
      aggregate.n++; aggregate.chars += e.entry.text.length;
      if (e.entry.durationSec !== null) { aggregate.seconds += e.entry.durationSec; aggregate.timed++; }
      templates.set(t, aggregate);
    }
    for (const c of e.commands) {
      if (safe(c.cmdKey)) commands.set(c.cmdKey, (commands.get(c.cmdKey) ?? 0) + 1);
      if (c.subKey && safe(c.subKey)) subs.set(c.subKey, (subs.get(c.subKey) ?? 0) + 1);
      for (const token of c.tokens) {
        const p = token.literal;
        if (!p) continue;
        const id = idByLiteral.get(`${p.type}\0${p.value}`);
        if (!id || !safe(id)) continue;
        if (p.type === "path") {
          const row = paths.get(id) ?? { p: id, n: 0, depth: (p.value.match(/[\\/]/g) ?? []).length, viaCd: 0 };
          row.n++; if (c.cmdKey === "cd" || c.cmdKey === "set-location" || c.cmdKey === "sl") row.viaCd++; paths.set(id, row);
        } else if (p.type === "host") {
          const row = hosts.get(id) ?? { h: id, n: 0, via: [] };
          row.n++; if (!row.via.includes(c.cmdKey) && row.via.length < 4 && safe(c.cmdKey)) row.via.push(c.cmdKey); hosts.set(id, row);
        }
      }
    }
  });
  const templateRows = [...templates].map(([t, a]) => ({ t, n: a.n, len: Math.round(a.chars / a.n) })).sort((a, b) => b.n - a.n || a.t.localeCompare(b.t));
  const aliases: Profile["aliases"] = dumps.aliases.map(alias => {
    const a = idByLiteral.get(`alias\0${alias.name}`)!;
    let expands: string | null = null;
    if (!classifyEntry(alias.expansion, { knownWords: isKnownWord, shell: source.shell }).drop) {
      const t = renderTemplate(normalizeEntry({ text: alias.expansion, seq: 0, ts: null, durationSec: null }, ctx), pseudonyms);
      if (safe(t)) expands = t;
    }
    const used = kept.reduce((n, e) => n + e.commands.filter(c => c.tokens.some(t => t.literal?.type === "alias" && t.literal.value === alias.name)).length, 0);
    return { a, expands, used, fullFormUsed: expands ? (templates.get(expands)?.n ?? 0) : 0 };
  }).filter(a => !!a.a && safe(a.a)).sort((a, b) => b.used + b.fullFormUsed - a.used - a.fullFormUsed).slice(0, 40);
  const grams = new Map<string, { seq: string[]; n: number }>();
  for (let i = 0; i < kept.length; i++) for (const size of [2, 3]) {
    if (i + size > kept.length) continue;
    const seq = rendered.slice(i, i + size);
    if (!valid.slice(i, i + size).every(Boolean) || seq.every(t => t === seq[0])) continue;
    let contiguousWindow = true;
    for (let j = i + 1; j < i + size; j++) {
      if (!contiguous(kept[j - 1]!.entry, kept[j]!.entry)) { contiguousWindow = false; break; }
    }
    if (!contiguousWindow) continue;
    const key = JSON.stringify(seq), row = grams.get(key) ?? { seq, n: 0 }; row.n++; grams.set(key, row);
  }
  const sequences = rankSequences(grams.values());
  const telemetry = telemetryPatterns(kept, rendered, valid, (a, b) => distance(a, b) <= (a.length <= 4 ? 1 : 2));
  const repeatMap = new Map<string, { t: string; runs: number; maxRun: number }>();
  for (let i = 0; i < rendered.length;) {
    let end = i + 1; while (end < rendered.length && rendered[end] === rendered[i]) end++;
    if (end - i >= 3 && valid[i]) { const t = rendered[i]!, row = repeatMap.get(t) ?? { t, runs: 0, maxRun: 0 }; row.runs++; row.maxRun = Math.max(row.maxRun, end - i); repeatMap.set(t, row); }
    i = end;
  }
  const typoCounts = new Map<string, { typed: string; meant: string; n: number }>();
  const executables = new Map<string, boolean>();
  const which = input.which ?? Bun.which;
  const recordTypo = (typed: string, candidates: Iterable<string>, prefix = "", commandNotFound = false) => {
    if (!/^[a-z][a-z-]{1,11}$/.test(typed)) return;
    if (!prefix && !commandNotFound) {
      if (!executables.has(typed)) executables.set(typed, which(typed) !== null);
      if (executables.get(typed)) return;
    }
    const limit = prefix ? 2 : typed.length <= 4 ? 1 : 2;
    const usage = prefix ? subs : commands;
    const match = [...candidates].map(meant => ({ meant, d: distance(typed, meant) })).filter(m => m.d > 0 && m.d <= limit)
      .sort((a, b) => a.d - b.d || (usage.get(prefix + b.meant) ?? 0) - (usage.get(prefix + a.meant) ?? 0) || a.meant.localeCompare(b.meant))[0];
    if (!match || !safe(prefix + match.meant)) return;
    const key = prefix + typed, row = typoCounts.get(key) ?? { typed: key, meant: prefix + match.meant, n: 0 }; row.n++; typoCounts.set(key, row);
  };
  for (const [i, e] of kept.entries()) for (const c of e.commands) {
    if (c.cmdKey === "<cmd>" && (e.entry.exitCode == null || e.entry.exitCode === 127 && e.commands.length === 1)) {
      const next = kept[i + 1], corrected = next?.commands.length === 1 ? next.commands[0]?.rawCmd : undefined;
      const observed = e.entry.exitCode === 127 && next && next.entry.exitCode === 0 && corrected && COMMANDS.has(corrected) &&
        contiguous(e.entry, next.entry) && e.entry.cwdHash === next.entry.cwdHash &&
        e.entry.text.slice(c.rawCmd.length) === next.entry.text.slice(corrected.length);
      recordTypo(c.rawCmd, observed ? [corrected] : COMMANDS, "", e.entry.exitCode === 127);
    }
    if (e.entry.exitCode !== 0 && ["git", "npm", "docker", "kubectl"].includes(c.cmdKey)) {
      const words = splitCommands(tokenize(e.entry.text, source.shell)).find(simple => simple.words[0]?.value === c.rawCmd)?.words;
      const first = words?.slice(1).find(w => !w.value.startsWith("-"))?.value;
      const known = SUBCOMMANDS[c.cmdKey];
      if (first && known && !known.has(first)) recordTypo(first, known, c.cmdKey + " ");
    }
  }
  const today = localDate();
  const ledgerNext: Ledger = { firstUntimedDay: input.ledger.firstUntimedDay, days: Object.fromEntries(Object.entries(input.ledger.days).map(([day, row]) => [day, { timed: row.timed, counts: { ...row.counts } }])) };
  const freshSet = new Set(input.fresh.map(e => e.seq));
  addToLedger(ledgerNext, kept.filter(e => freshSet.has(e.entry.seq)), today);
  const timestamps = entries.flatMap(e => e.ts === null ? [] : [e.ts]);
  const environment = structuredClone(input.env);
  environment.shell = source.shell; environment.history.entries = entries.length; environment.history.timestamps = timestamps.length >= entries.length / 2 && timestamps.length > 0;
  const profile: Profile = {
    schema: "ghop-profile/1", environment,
    window: { entries: entries.length, kept: kept.length, dropped: entries.length - kept.length, spanDays: timestamps.length ? Math.floor((Math.max(...timestamps) - Math.min(...timestamps)) / 86400) + 1 : null },
    topCommands: ranked(commands, 25), topSubcommands: ranked(subs, 25), templates: templateRows.filter(t => t.n >= 2).slice(0, 30),
    aliasCandidates: templateRows.filter(t => t.n >= 5 && t.len >= 8).map(t => ({ ...t, savedChars: t.n * Math.max(0, t.len - 4), coveredBy: aliases.find(a => a.expands === t.t)?.a ?? null })).sort((a, b) => b.savedChars - a.savedChars).slice(0, 15),
    sequences, repeats: [...repeatMap.values()].sort((a, b) => b.runs - a.runs || b.maxRun - a.maxRun).slice(0, 10),
    paths: [...paths.values()].sort((a, b) => b.n - a.n).slice(0, 10), hosts: [...hosts.values()].sort((a, b) => b.n - a.n).slice(0, 10), aliases,
    functions: Object.entries(pseudonyms).filter(([, p]) => p.type === "fn").map(([f, p]) => ({ f, used: kept.reduce((n, e) => n + e.commands.filter(c => c.tokens.some(t => t.literal?.type === "fn" && t.literal.value === p.value)).length, 0) })).filter(f => f.used >= 1 && safe(f.f)).sort((a, b) => b.used - a.used).slice(0, 20),
    typos: [...typoCounts.values()].filter(t => t.n >= 2).sort((a, b) => b.n - a.n).slice(0, 10),
    slow: [...templates].filter(([, a]) => a.timed >= 3 && a.seconds / a.timed >= 10).map(([t, a]) => ({ t, n: a.timed, avgSec: Math.round(a.seconds / a.timed) })).sort((a, b) => b.avgSec - a.avgSec).slice(0, 10),
    ...telemetry,
    signals: detectSignals(kept, source.shell), redFlags: detectRedFlags(entries, classifications, environment), trends: computeTrends(ledgerNext, today), memory: [],
  };
  // Environment/trend strings are not derived from history, but are guarded too.
  const sanitize = (value: unknown): void => {
    if (Array.isArray(value)) { for (let i = value.length - 1; i >= 0; i--) { const child: unknown = value[i]; if (typeof child === "string" && !safe(child)) value.splice(i, 1); else sanitize(child); } }
    else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
      if (!safe(key)) { delete (value as Record<string, unknown>)[key]; continue; }
      if (typeof child === "string" && !safe(child)) { (value as Record<string, unknown>)[key] = null; }
      else sanitize(child);
    }
  };
  sanitize(profile.environment); sanitize(profile.trends);
  profile.memory = buildMemory(profile, input.existing, pseudonyms, salt);
  const encoder = new TextEncoder();
  for (const field of ["templates", "sequences", "aliases", "hosts", "paths", "projects"] as const) {
    while (encoder.encode(JSON.stringify(profile)).length > 16_384 && profile[field].length) profile[field].splice(Math.floor(profile[field].length * .8));
  }
  // Other capped sections can dominate in a worst-case profile; keep the hard wire cap.
  for (const field of ["memory", "aliasCandidates", "slow", "repeats", "typos", "functions", "topSubcommands", "topCommands", "retries"] as const) {
    while (encoder.encode(JSON.stringify(profile)).length > 16_384 && profile[field].length) profile[field].pop();
  }
  // Trimming may remove references that memory originally cited.
  profile.memory = buildMemory(profile, input.existing, pseudonyms, salt).slice(0, profile.memory.length);
  while (encoder.encode(JSON.stringify(profile)).length > 16_384 && profile.memory.length) profile.memory.pop();
  stats.payloadBytes = encoder.encode(JSON.stringify(profile)).length;
  return { profile, pseudonyms, stats, kept, ledgerNext };
}
