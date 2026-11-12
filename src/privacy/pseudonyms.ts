import type { NormEntry, NormToken, PlaceholderType } from "./normalize.ts";

export type PseudonymMap = Record<string, { type: PlaceholderType; value: string }>;
const ELIGIBLE = new Set<PlaceholderType>(["path", "url", "host", "cmd", "alias", "fn", "arg", "ref", "pkg", "script", "var"]);
export function assignPseudonyms(entries: NormEntry[], aliasNames: Iterable<string>, minCount: number): PseudonymMap {
  const counts = new Map<PlaceholderType, Map<string, number>>();
  for (const entry of entries) for (const command of entry.commands) for (const token of command.tokens) {
    if (!token.literal || !ELIGIBLE.has(token.literal.type)) continue;
    const { type, value } = token.literal;
    let values = counts.get(type);
    if (!values) { values = new Map(); counts.set(type, values); }
    values.set(value, (values.get(value) ?? 0) + 1);
  }
  let aliases = counts.get("alias");
  if (!aliases) { aliases = new Map(); counts.set("alias", aliases); }
  for (const alias of aliasNames) if (!aliases.has(alias)) aliases.set(alias, 0);
  const result: PseudonymMap = {};
  for (const [type, values] of counts) {
    const sorted = [...values].filter(([, count]) => type === "alias" || (type === "fn" ? count >= 1 : count >= minCount))
      .sort(([a, an], [b, bn]) => bn - an || (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 0; i < Math.min(sorted.length, 999); i++) result[`<${type}#${i + 1}>`] = { type, value: sorted[i]![0] };
  }
  return result;
}
export function renderTemplate(entry: NormEntry, map: PseudonymMap): string {
  const lookup = new Map<string, string>();
  for (const [id, literal] of Object.entries(map)) lookup.set(`${literal.type}\0${literal.value}`, id);
  const output: string[] = [];
  const append = (token: NormToken) => {
    const literal = token.literal;
    const text = literal ? token.text.replace(`<${literal.type}>`, lookup.get(`${literal.type}\0${literal.value}`) ?? `<${literal.type}>`) : token.text;
    if (/^<[a-z]+>$/.test(text) && output.at(-1) === text) return;
    output.push(text);
  };
  for (let i = 0; i < entry.commands.length; i++) {
    for (const token of entry.commands[i]!.tokens) append(token);
    const op = entry.ops[i];
    if (op) output.push(op);
  }
  return output.join(" ");
}
