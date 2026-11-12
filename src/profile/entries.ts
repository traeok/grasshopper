import type { HistoryEntry } from "../history/parse.ts";
import type { Shell } from "../history/source.ts";
import type { ShellDumps } from "../history/shell-dumps.ts";
import { classifyEntry } from "../privacy/classify.ts";
import { isKnownWord } from "../privacy/dictionary.ts";
import { normalizeEntry, type NormEntry } from "../privacy/normalize.ts";

/** Keep local diagnostics and outbound profiles on the same filtering path. */
export function prepareEntries(entries: HistoryEntry[], shell: Shell, dumps: ShellDumps) {
  const ctx = { aliases: new Set(dumps.aliases.map(a => a.name)), functions: new Set(dumps.functions), shell };
  const customWords = new Set([...ctx.aliases, ...ctx.functions].map(name => shell === "powershell" ? name.toLowerCase() : name));
  const knownWord = (word: string) => isKnownWord(word) || customWords.has(shell === "powershell" ? word.toLowerCase() : word);
  const classifications = entries.map(e => classifyEntry(e.text, { shell, knownWords: knownWord }));
  const kept: NormEntry[] = [];
  const unknownCounts = new Map<string, number>();
  entries.forEach((entry, i) => {
    if (classifications[i]!.drop) return;
    const normalized = normalizeEntry(entry, ctx);
    kept.push(normalized);
    for (const command of normalized.commands) {
      if (command.cmdKey !== "<cmd>" || !command.tokens.some(token => token.literal?.type === "cmd" && token.literal.value === command.rawCmd)) continue;
      const name = command.rawCmd.toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, "");
      unknownCounts.set(name, (unknownCounts.get(name) ?? 0) + 1);
    }
  });
  const unknownCommands = [...unknownCounts].sort(([a, an], [b, bn]) => bn - an || a.localeCompare(b)).slice(0, 10).map(([c, n]) => ({ c, n }));
  return { ctx, classifications, kept, unknownCommands };
}
