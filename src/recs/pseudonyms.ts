import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { openDb } from "../core/db.ts";
import { GhopError } from "../core/errors.ts";
import { dbFile } from "../core/paths.ts";
import type { PseudonymMap } from "../privacy/pseudonyms.ts";
import { tokenize } from "../history/tokenize.ts";
import type { Shell } from "../history/source.ts";
import { dim, sprout } from "../ui/style.ts";

const PlaceholderType = z.enum(["path", "url", "host", "cmd", "alias", "fn", "arg", "ref", "pkg", "script", "var", "str", "num", "val", "glob", "flag", "subshell", "heredoc"]);
const placeholderPattern = /<(path|url|host|cmd|alias|fn|arg|ref|pkg|script|var|str|num|val|glob|flag|subshell|heredoc)(?:#\d+)?>/g;
const PseudonymMapSchema = z.record(
  z.string().regex(/^<(?:path|url|host|cmd|alias|fn|arg|ref|pkg|script|var|str|num|val|glob|flag|subshell|heredoc)#[1-9]\d{0,2}>$/),
  z.object({ type: PlaceholderType, value: z.string() }).strict(),
).superRefine((map, ctx) => {
  for (const [id, entry] of Object.entries(map)) {
    if (!id.startsWith(`<${entry.type}#`)) ctx.addIssue({ code: "custom", path: [id, "type"], message: "Placeholder type does not match its identifier" });
  }
});
const cached = new Map<string, PseudonymMap>();

/** Remove terminal instructions from untrusted text, retaining ordinary line breaks and tabs. */
export function stripTerminalControls(text: string): string {
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

export function renderText(text: string, map: PseudonymMap): string {
  return stripTerminalControls(text).replace(placeholderPattern, (id: string) => {
    const entry = id.includes("#") ? map[id] : undefined;
    return entry ? sprout(stripTerminalControls(entry.value)) : dim(id);
  });
}

/**
 * Replace only complete shell words. Re-encode quoted words rather than inserting
 * another quoting layer inside them; concatenations and nested shell programs
 * need a real shell parser and are deliberately not automatable.
 */
export function depseudonymizeForShell(text: string, map: PseudonymMap, shell: Shell = "bash"): string {
  const matches = [...text.matchAll(placeholderPattern)];
  if (matches.length === 0) return text;
  let prefix = "GHOPPLACEHOLDER";
  while (text.includes(prefix)) prefix += "X";
  const entries = matches.map((match, index) => {
    const id = match[0];
    const entry = id.includes("#") ? map[id] : undefined;
    if (!entry) throw new GhopError(`not automatable: unresolved ${id}`);
    if (entry.value.includes("\0")) throw new GhopError("not automatable: shell value contains NUL");
    const unresolved = entry.value.match(placeholderPattern)?.[0];
    if (unresolved) throw new GhopError(`not automatable: unresolved ${unresolved}`);
    return { marker: `${prefix}${index}X`, value: entry.value, replacement: "" };
  });
  let index = 0;
  const marked = text.replace(placeholderPattern, () => entries[index++]!.marker);
  const tokens = tokenize(marked, shell);
  if (tokens.some(token => token.kind === "op" && (token.value === "<<" || token.value === "<<-"))) {
    throw new GhopError("not automatable: placeholders in heredocs are unsupported");
  }
  for (const entry of entries) {
    const token = tokens.find(token => token.kind === "word" && token.raw.includes(entry.marker));
    if (!token || token.kind !== "word"
      || ![entry.marker, `"${entry.marker}"`, `'${entry.marker}'`].includes(token.raw)) {
      throw new GhopError("not automatable: placeholder must be a complete, optionally quoted shell word");
    }
    // PowerShell literals never interpolate; POSIX words retain existing behavior.
    entry.replacement = shell === "powershell"
      ? `'${entry.value.replaceAll("'", "''")}'`
      : token.raw === entry.marker && /^[A-Za-z0-9_./~:@%+=,-]+$/.test(entry.value)
        ? entry.value
        : `"${entry.value.replace(/[\\"$`]/g, "\\$&")}"`;
  }
  index = 0;
  return marked.replace(new RegExp(`(["']?)${prefix}\\d+X\\1`, "g"), () => entries[index++]!.replacement);
}

export function loadPseudonyms(analysisId: string): PseudonymMap {
  const key = JSON.stringify([dbFile(), analysisId]);
  const existing = cached.get(key);
  if (existing) return existing;
  const row = z.object({ pseudonyms: z.string() }).nullable().parse(
    openDb().query("SELECT pseudonyms FROM analyses WHERE id = ?").get(analysisId),
  );
  const map: PseudonymMap = row ? PseudonymMapSchema.parse(JSON.parse(row.pseudonyms)) : {};
  cached.set(key, map);
  return map;
}
