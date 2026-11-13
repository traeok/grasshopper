import type { PseudonymMap } from "../privacy/pseudonyms.ts";
import type { StoredRecommendation } from "../recs/store.ts";
import { canonicalTool } from "../recs/topic.ts";
import type { Profile } from "./types.ts";

const PLACEHOLDER_TYPES = "path|url|host|cmd|alias|fn|arg|ref|pkg|script|var|str|num|val|glob|flag|subshell|heredoc";

export function evidenceVocabulary(profile: Profile): Set<string> {
  const vocabulary = new Set<string>();
  for (const [name, n] of Object.entries(profile.signals)) if (n > 0) vocabulary.add(`signal:${name}`);
  for (const { kind, n } of profile.redFlags) if (n > 0) vocabulary.add(`redFlag:${kind}`);
  for (const { t } of profile.templates) vocabulary.add(`template:${t}`);
  for (const { t } of profile.aliasCandidates) vocabulary.add(`template:${t}`);
  for (const { seq } of profile.sequences) vocabulary.add(`sequence:${seq.join(" → ")}`);
  for (const { a } of profile.aliases) vocabulary.add(`alias:${a}`);
  for (const { p } of profile.paths) vocabulary.add(`path:${p}`);
  for (const { h } of profile.hosts) vocabulary.add(`host:${h}`);
  for (const { typed } of profile.typos) vocabulary.add(`typo:${typed}`);
  for (const { t } of profile.slow) vocabulary.add(`slow:${t}`);
  for (const { from, to } of profile.retries ?? []) vocabulary.add(`retry:${from} → ${to}`);
  for (const project of profile.projects ?? []) {
    for (const { seq } of project.sequences) vocabulary.add(`sequence:${seq.join(" → ")}`);
  }
  if (profile.trends.available) {
    for (const items of [profile.trends.rising, profile.trends.falling, profile.trends.new]) {
      for (const { c } of items) vocabulary.add(`trend:${c}`);
    }
  }
  for (const field of ["timestamps", "fileLimit", "ignoreSpace", "ignoreDups", "appendIncremental"]) {
    vocabulary.add(`history:${field}`);
  }
  return vocabulary;
}

function digest(value: string, salt: string): string {
  return new Bun.CryptoHasher("sha256").update(salt + value).digest("hex").slice(0, 10);
}

export function stableRef(ref: string, pseudonyms: PseudonymMap, salt: string): string {
  return ref.replace(new RegExp(`<(${PLACEHOLDER_TYPES})#\\d+>`, "g"), (placeholder: string, type: string) => {
    const literal = pseudonyms[placeholder];
    return literal?.type === type ? `<${type}:${digest(literal.value, salt)}>` : `<${type}>`;
  });
}

export function renderStableRef(stable: string, pseudonyms: PseudonymMap, salt: string): string {
  const current = new Map<string, string>();
  for (const [placeholder, literal] of Object.entries(pseudonyms)) {
    current.set(`<${literal.type}:${digest(literal.value, salt)}>`, placeholder);
  }
  return stable.replace(new RegExp(`<(${PLACEHOLDER_TYPES}):[a-f0-9]{10}>`, "g"), (placeholder: string, type: string) =>
    current.get(placeholder) ?? `<${type}>`);
}

export function buildMemory(
  profile: Profile,
  existing: readonly StoredRecommendation[],
  pseudonyms: PseudonymMap,
  salt: string,
): Profile["memory"] {
  const vocabulary = evidenceVocabulary(profile);
  const aliasesById = new Map(profile.aliases.map(alias => [alias.a, alias]));
  const aliasesByName = new Map<string, Profile["aliases"][number]>();
  for (const [id, literal] of Object.entries(pseudonyms)) {
    const alias = aliasesById.get(id);
    if (literal.type === "alias" && alias) aliasesByName.set(literal.value, alias);
  }
  return existing.map((row) => {
    const evidence = new Set<string>();
    for (const stable of row.evidence) {
      const ref = renderStableRef(stable, pseudonyms, salt);
      if (vocabulary.has(ref)) evidence.add(ref);
    }
    if (row.topic.startsWith("alias:")) {
      const ref = `template:${renderStableRef(row.topic.slice("alias:".length), pseudonyms, salt)}`;
      if (vocabulary.has(ref)) evidence.add(ref);
    }
    const adoption: Profile["memory"][number]["adoption"] = [];
    if (row.status === "implemented") {
      const shell = row.applied?.shell ?? row.shell;
      const names = row.applied ? row.applied.aliasNames : row.action?.type === "alias" ? [row.action.name] : [];
      if (shell === profile.environment.shell) {
        for (const name of new Set(names)) {
          const alias = aliasesByName.get(name);
          if (!alias) continue;
          adoption.push({ a: alias.a, used: alias.used, fullFormUsed: alias.fullFormUsed });
          const ref = `alias:${alias.a}`;
          if (vocabulary.has(ref)) evidence.add(ref);
        }
      }
    }
    const canonical = canonicalTool(row.tool);
    return {
      updatedAt: row.updatedAt,
      item: {
        category: row.category, status: row.status, evidence: [...evidence], tool: canonical, adoption,
        discardReason: row.status === "discarded" ? row.discardReason : null,
      },
    };
  }).sort((a, b) => {
    const aRelevant = a.item.adoption.length > 0 || a.item.evidence.length > 0 || a.item.tool !== null;
    const bRelevant = b.item.adoption.length > 0 || b.item.evidence.length > 0 || b.item.tool !== null;
    return Number(bRelevant) - Number(aRelevant) || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);
  }).slice(0, 80).map(({ item }) => item);
}
