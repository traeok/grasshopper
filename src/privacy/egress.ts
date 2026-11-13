import { isIP } from "node:net";
import { EgressBlockedError } from "../core/errors.ts";
import { STATIC_SYSTEM_PROMPTS } from "../llm/prompts.ts";
import { evidenceVocabulary } from "../profile/evidence.ts";
import type { Profile } from "../profile/types.ts";
import { DiscardReason } from "../recs/store.ts";
import { FILE_EXTENSIONS, PUBLIC_HOSTS, isKnownWord } from "./dictionary.ts";
import { findHighEntropyTokens } from "./entropy.ts";
import { isSafeString } from "./grammar.ts";
import { literalRegex, type SensitiveLiteral } from "./literals.ts";
import type { PseudonymMap } from "./pseudonyms.ts";
import { SECRET_RULES } from "./secret-rules.ts";

export { SCHEMA_WORDS, isSafeToken, isSafeString } from "./grammar.ts";

// Structural until the gateway owns its public message type.
type OutboundMessage = { role: "system" | "user" | "assistant"; content: string };
type OutboundContext = { literals: readonly SensitiveLiteral[] };
export interface RedactionFinding { category: string; count: number }

// Optimal-string-alignment distance, including adjacent transpositions (gti → git).
function closeTypo(typed: string, meant: string): boolean {
  if (Math.abs(typed.length - meant.length) > 2) return false;
  const rows = Array.from({ length: typed.length + 1 }, () => new Array<number>(meant.length + 1).fill(0));
  for (let i = 0; i <= typed.length; i++) rows[i]![0] = i;
  for (let j = 0; j <= meant.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= typed.length; i++) for (let j = 1; j <= meant.length; j++) {
    rows[i]![j] = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1,
      rows[i - 1]![j - 1]! + Number(typed[i - 1] !== meant[j - 1]));
    if (i > 1 && j > 1 && typed[i - 1] === meant[j - 2] && typed[i - 2] === meant[j - 1]) {
      rows[i]![j] = Math.min(rows[i]![j]!, rows[i - 2]![j - 2]! + 1);
    }
  }
  return rows[typed.length]![meant.length]! <= 2;
}

function validTypo(typed: string, meant: string): boolean {
  if (!isSafeString(meant)) return false;
  const tokens = typed.split(" ");
  const targets = meant.split(" ");
  return tokens.length === targets.length && tokens.every((token, i) =>
    isKnownWord(token) || (/^[a-z][a-z-]{1,11}$/.test(token) && closeTypo(token, targets[i]!)));
}

/** Validate the closed wire grammar, without including rejected data in errors. */
export function validateProfile(profile: Profile): void {
  const vocabulary = evidenceVocabulary(profile);
  const visit = (value: unknown, path: string, parts: (string | number)[], parent?: Record<string, unknown>): void => {
    if (parts.length === 3 && parts[0] === "memory" && typeof parts[1] === "number" && parts[2] === "discardReason") {
      if (value !== null && !DiscardReason.safeParse(value).success) throw new EgressBlockedError([`grammar:${path}`]);
      return;
    }
    if (typeof value === "string") {
      let safe: boolean;
      if (parts.length === 3 && parts[0] === "typos" && typeof parts[1] === "number" && parts[2] === "typed") {
        safe = typeof parent?.meant === "string" && validTypo(value, parent.meant);
      } else if (parts.length === 4 && parts[0] === "memory" && typeof parts[1] === "number" && parts[2] === "evidence" && typeof parts[3] === "number") {
        safe = vocabulary.has(value);
      } else if (parts.length === 3 && parts[0] === "memory" && typeof parts[1] === "number" && parts[2] === "tool") {
        safe = /^(gh|npm|winget|brew):[A-Za-z0-9@._/+-]{1,214}$/.test(value);
      } else if (parts.length === 5 && parts[0] === "memory" && typeof parts[1] === "number" && parts[2] === "adoption"
        && typeof parts[3] === "number" && parts[4] === "a") {
        safe = /^<alias#[1-9]\d{0,2}>$/.test(value) && vocabulary.has(`alias:${value}`);
      } else safe = isSafeString(value);
      if (!safe) throw new EgressBlockedError([`grammar:${path}`]);
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`, [...parts, index]));
    } else if (value !== null && typeof value === "object") {
      const object = value as Record<string, unknown>;
      Object.entries(object).forEach(([key, item], index) => {
        // An untrusted key cannot itself be printed as part of an error path.
        if (!isSafeString(key)) throw new EgressBlockedError([`grammar:${path}[key#${index}]`]);
        visit(item, `${path}.${key}`, [...parts, key], object);
      });
    }
  };
  visit(profile, "$", []);
}

/** Last check before transport; findings contain categories, never matched text. */
export function assertOutboundSafe(messages: readonly OutboundMessage[], ctx: OutboundContext): void {
  const categories = new Set<string>();
  const literals = literalRegex([...ctx.literals]);
  const kinds = new Map(ctx.literals.map(literal => [literal.value.toLowerCase(), literal.kind]));
  for (const message of messages) {
    if (message.role === "system" && !STATIC_SYSTEM_PROMPTS.includes(message.content)) categories.add("system-prompt");
    for (const rule of SECRET_RULES) {
      if (new RegExp(rule.re.source, rule.re.flags).test(message.content)) categories.add(`secret:${rule.id}`);
    }
    if (findHighEntropyTokens(message.content).length > 0) categories.add("secret:high-entropy");
    if (message.role !== "system" && literals) {
      for (const match of message.content.matchAll(globalRegex(literals))) {
        categories.add(`literal:${kinds.get(match[0].toLowerCase())!}`);
      }
    }
  }
  if (categories.size > 0) throw new EgressBlockedError([...categories]);
}

function globalRegex(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
}

function escapeRegex(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Local-only chat scrubbing. Recognizers always inspect the original input. */
export function redactOutboundText(
  text: string,
  ctx: OutboundContext & { pseudonyms?: PseudonymMap },
): { text: string; findings: RedactionFinding[] } {
  const counts = new Map<string, number>();
  const record = (category: string, replacement: string): string => {
    counts.set(category, (counts.get(category) ?? 0) + 1);
    return replacement;
  };
  type Span = { start: number; end: number; replacement: string; category: string | null };
  const sensitive: Span[] = [];
  const collect = (re: RegExp, category: string, replacement: string): void => {
    for (const match of text.matchAll(globalRegex(re))) {
      sensitive.push({ start: match.index, end: match.index + match[0].length, category, replacement });
    }
  };
  // Collect every credential match before replacing anything: overlapping rules
  // must not erase the context another rule needs to find a secret.
  for (const rule of SECRET_RULES) collect(rule.re, `secret:${rule.id}`, `<redacted:${rule.id}>`);
  const entropy = new Set(findHighEntropyTokens(text));
  if (entropy.size > 0) {
    collect(new RegExp([...entropy].map(escapeRegex).join("|"), "g"), "secret:high-entropy", "<redacted:high-entropy>");
  }
  const literals = literalRegex([...ctx.literals]);
  if (literals) {
    const kinds = new Map(ctx.literals.map(literal => [literal.value.toLowerCase(), literal.kind]));
    for (const match of text.matchAll(globalRegex(literals))) {
      const kind = kinds.get(match[0].toLowerCase())!;
      sensitive.push({ start: match.index, end: match.index + match[0].length,
        category: `literal:${kind}`, replacement: `<redacted:${kind}>` });
    }
  }
  const generic: Span[] = [];
  const replace = (re: RegExp, replacement: (match: RegExpExecArray) => { category: string; text: string } | null): void => {
    for (const match of text.matchAll(globalRegex(re))) {
      const value = replacement(match);
      if (value) generic.push({ start: match.index, end: match.index + match[0].length,
        category: value.category, replacement: value.text });
    }
  };
  // Gather generic spans on the original input too, so a literal inside a
  // private URL cannot expose the rest of that URL by breaking its recognizer.
  // Keep public documentation/registry URLs, not private hosts or their paths.
  replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"'`]+/gi, ([value]) => {
    try {
      const url = new URL(/^www\./i.test(value) ? `https://${value}` : value);
      if (PUBLIC_HOSTS.has(url.hostname.toLowerCase().replace(/\.$/, ""))) return null;
    } catch { /* An unparseable URL is not safe to retain. */ }
    return { category: "url", text: "<url>" };
  });
  replace(/\b[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,24}\b/g,
    () => ({ category: "email", text: "<email>" }));
  replace(/\b[A-Za-z0-9._-]+@(?:\[[A-Fa-f0-9:]+\]|[A-Za-z0-9][A-Za-z0-9.-]*)(?::[^\s<>"']*)?/g,
    () => ({ category: "host", text: "<host>" }));
  // Both address families, including bracketed, compressed, and scoped IPv6.
  replace(/(?<![A-Za-z0-9])\[?(?:[A-Fa-f0-9]{0,4}:){2,}[A-Fa-f0-9:.]*(?:%[A-Za-z0-9_.-]+)?\]?(?![A-Za-z0-9])/g, ([value]) => {
    let address = value.replace(/^\[|\]$/g, "").split("%")[0]!;
    let suffix = "";
    while (isIP(address) !== 6 && /[.:]$/.test(address)) {
      suffix = address.at(-1)! + suffix;
      address = address.slice(0, -1);
    }
    return isIP(address) === 6 ? { category: "ip", text: `<ip>${suffix}` } : null;
  });
  replace(/(?<![A-Za-z0-9])(?:\d{1,3}\.){3}\d{1,3}(?![A-Za-z0-9])/g,
    ([value]) => isIP(value) === 4 ? { category: "ip", text: "<ip>" } : null);
  replace(/(?<![A-Za-z0-9_-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?![A-Za-z0-9_-])/gi, ([value]) =>
    PUBLIC_HOSTS.has(value.toLowerCase().replace(/\.$/, "")) || FILE_EXTENSIONS.has(value.split(".").at(-1)!.toLowerCase())
      ? null : { category: "host", text: "<host>" });
  replace(/(\b[A-Za-z]:[\\/]Users[\\/]|\/[a-z]\/Users\/|\/Users\/|\/home\/)([^\\/\s<>"']+)/gi,
    match => ({ category: "username", text: `${match[1]}<user>` }));
  // Already-scrubbed markers, like markers generated below, are opaque.
  const markers: Span[] = [...text.matchAll(/<[A-Za-z][A-Za-z0-9:#-]*>/g)].map(match => ({
    start: match.index, end: match.index + match[0].length, replacement: match[0], category: null,
  }));
  const overlaps = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;
  const pseudonyms = new Map<string, string>();
  for (const [id, literal] of Object.entries(ctx.pseudonyms ?? {})) {
    if (literal.value.length >= 3 && !pseudonyms.has(literal.value)) pseudonyms.set(literal.value, id);
  }
  const aliases: Span[] = [];
  if (pseudonyms.size > 0) {
    const re = new RegExp([...pseudonyms.keys()].sort((a, b) => b.length - a.length).map(escapeRegex).join("|"), "g");
    for (const match of text.matchAll(re)) {
      const span: Span = { start: match.index, end: match.index + match[0].length,
        replacement: pseudonyms.get(match[0])!, category: "pseudonym" };
      // An exact path/host pseudonym may safely hide a whole harvested literal.
      // A substring must never split a credential or a sensitive literal.
      if (!markers.some(marker => overlaps(span, marker)) && !sensitive.some(secret => overlaps(span, secret) &&
        (!secret.category?.startsWith("literal:") || span.start > secret.start || span.end < secret.end)) &&
        !generic.some(value => overlaps(span, value) && (span.start > value.start || span.end < value.end))) {
        aliases.push(span);
      }
    }
  }
  const spans = [
    ...sensitive.filter(span => !aliases.some(alias => alias.start <= span.start && alias.end >= span.end) &&
      !(span.category?.startsWith("literal:") && markers.some(marker => marker.start <= span.start && marker.end >= span.end))),
    ...generic.filter(span => !aliases.some(alias => alias.start <= span.start && alias.end >= span.end)),
    ...aliases,
    ...markers,
  ].sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && overlaps(previous, span)) {
      previous.end = Math.max(previous.end, span.end);
      // If a credential overlaps a preexisting marker, retain the redaction.
      if (previous.category === null && span.category !== null) {
        previous.category = span.category;
        previous.replacement = span.replacement;
      }
    } else merged.push({ ...span });
  }
  // Render once from original offsets. Replacement markers are never fed back
  // through any pseudonym, literal, or generic transform.
  const parts: string[] = [];
  let cursor = 0;
  for (const span of merged) {
    parts.push(text.slice(cursor, span.start));
    parts.push(span.category === null ? span.replacement : record(span.category, span.replacement));
    cursor = span.end;
  }
  parts.push(text.slice(cursor));
  text = parts.join("");
  return { text, findings: [...counts].map(([category, count]) => ({ category, count })) };
}
