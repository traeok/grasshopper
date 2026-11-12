import type { HistoryEntry } from "../history/parse.ts";
import type { NormEntry } from "../privacy/normalize.ts";
import type { Profile } from "./types.ts";

/** Never infer adjacency across filtered commands, sessions, or long idle gaps. */
export function contiguous(previous: HistoryEntry, current: HistoryEntry): boolean {
  if (current.seq !== previous.seq + 1) return false;
  if (previous.sessionId !== current.sessionId && (previous.sessionId || current.sessionId)) return false;
  if (previous.ts !== null && current.ts !== null && (current.ts < previous.ts || current.ts - previous.ts > 600)) return false;
  return true;
}

export function rankSequences(grams: Iterable<{ seq: string[]; n: number }>, cap = 15): Profile["sequences"] {
  const frequent = [...grams].filter(g => g.n >= 4);
  return frequent.filter(g => g.seq.length === 3 || !frequent.some(t => t.seq.length === 3 && t.n >= g.n * .8 &&
    (JSON.stringify(t.seq.slice(0, 2)) === JSON.stringify(g.seq) || JSON.stringify(t.seq.slice(1)) === JSON.stringify(g.seq))))
    .sort((a, b) => b.n * b.seq.length - a.n * a.seq.length || JSON.stringify(a.seq).localeCompare(JSON.stringify(b.seq))).slice(0, cap);
}

export function telemetryPatterns(
  kept: NormEntry[], rendered: string[], valid: boolean[], isCorrection: (typed: string, meant: string) => boolean,
): Pick<Profile, "retries" | "projects"> {
  const retries = new Map<string, Profile["retries"][number]>();
  const projects = new Map<string, { n: number; commands: Map<string, number>; grams: Map<string, { seq: string[]; n: number }> }>();
  for (let i = 0; i < kept.length; i++) {
    const current = kept[i]!;
    if (!valid[i]) continue;
    const previous = kept[i - 1];
    if (previous && valid[i - 1] && contiguous(previous.entry, current.entry) && previous.entry.cwdHash === current.entry.cwdHash &&
      previous.entry.exitCode != null && previous.entry.exitCode !== 0 && current.entry.exitCode != null) {
      // Same executable (including a sudo retry), or a command-not-found correction.
      const beforeCommands = previous.commands.filter(c => c.cmdKey !== "sudo");
      const afterCommands = current.commands.filter(c => c.cmdKey !== "sudo");
      const before = beforeCommands[0], after = afterCommands[0];
      if (beforeCommands.length === 1 && afterCommands.length === 1 && before && after &&
        (before.rawCmd === after.rawCmd && (before.subKey === after.subKey || !before.subKey) ||
          previous.entry.exitCode === 127 && after.cmdKey !== "<cmd>" && isCorrection(before.rawCmd, after.rawCmd) &&
          previous.entry.text.slice(before.rawCmd.length) === current.entry.text.slice(after.rawCmd.length))) {
        const from = rendered[i - 1]!, to = rendered[i]!;
        const key = JSON.stringify([from, to]);
        const row = retries.get(key) ?? { from, to, n: 0, succeeded: 0 };
        row.n++;
        if (current.entry.exitCode === 0) row.succeeded++;
        retries.set(key, row);
      }
    }
    const hash = current.entry.cwdHash;
    if (!hash) continue;
    const project = projects.get(hash) ?? { n: 0, commands: new Map<string, number>(), grams: new Map<string, { seq: string[]; n: number }>() };
    project.n++;
    for (const command of current.commands) project.commands.set(command.cmdKey, (project.commands.get(command.cmdKey) ?? 0) + 1);
    for (const size of [2, 3]) {
      const start = i - size + 1;
      if (start < 0) continue;
      const window = kept.slice(start, i + 1);
      if (window.some((entry, j) => !valid[start + j] || entry.entry.cwdHash !== hash || j > 0 && !contiguous(window[j - 1]!.entry, entry.entry))) continue;
      const seq = rendered.slice(start, i + 1);
      if (seq.every(t => t === seq[0])) continue;
      const key = JSON.stringify(seq), row = project.grams.get(key) ?? { seq, n: 0 };
      row.n++;
      project.grams.set(key, row);
    }
    projects.set(hash, project);
  }
  return {
    retries: [...retries.values()].sort((a, b) => b.n - a.n || a.from.localeCompare(b.from) || a.to.localeCompare(b.to)).slice(0, 10),
    projects: [...projects.values()].sort((a, b) => b.n - a.n).slice(0, 10).map((row, i) => ({ project: i + 1, n: row.n,
      topCommands: [...row.commands].sort(([a, an], [b, bn]) => bn - an || a.localeCompare(b)).slice(0, 10).map(([c, n]) => ({ c, n })),
      sequences: rankSequences(row.grams.values(), 5) })),
  };
}
