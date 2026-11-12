import { splitCommands, tokenize } from "../history/tokenize.ts";
import type { Shell } from "../history/source.ts";
import type { NormEntry } from "../privacy/normalize.ts";
import type { Profile } from "./types.ts";

export type SignalName = "historyGrep" | "retypedWithSudo" | "lastArgReuse" | "cdUp" | "cdUpChains" | "cdThenLs" | "mkdirThenCd" | "clearScreen" | "exitCommand" | "uselessCat" | "grepRecursive" | "findByName" | "psGrep" | "manLookups" | "helpLookups" | "consecutiveRepeats" | "longPipelines" | "cdHome" | "gitStatus" | "gitAddAll" | "dirStack";

export function detectSignals(kept: NormEntry[], shell: Shell = "bash"): Profile["signals"] {
  const counts: Profile["signals"] = {
    historyGrep: 0, retypedWithSudo: 0, lastArgReuse: 0, cdUp: 0, cdUpChains: 0,
    cdThenLs: 0, mkdirThenCd: 0, clearScreen: 0, exitCommand: 0, uselessCat: 0,
    grepRecursive: 0, findByName: 0, psGrep: 0, manLookups: 0, helpLookups: 0,
    consecutiveRepeats: 0, longPipelines: 0, cdHome: 0, gitStatus: 0, gitAddAll: 0, dirStack: 0,
  };
  let previousText: string | null = null;
  let previousWords: string[] = [];
  let upRun = 0;
  for (const normalized of kept) {
    const text = normalized.entry.text.trim();
    const tokens = tokenize(normalized.entry.text, shell);
    const commands = splitCommands(tokens);
    const first = commands.find(command => command.words.length > 0);
    const words = first?.words.map(word => word.value) ?? [];
    const cmd = words[0]?.replace(/\.(?:exe|cmd|bat|ps1)$/i, "").toLowerCase();
    const args = words.slice(1);
    if (previousText !== null) {
      if (text === `sudo ${previousText}`) counts.retypedWithSudo++;
      if (text === previousText) counts.consecutiveRepeats++;
      const lastArg = previousWords.slice(1).filter(value => !value.startsWith("-")).at(-1);
      if (lastArg && lastArg.length >= 3 && args.includes(lastArg)) counts.lastArgReuse++;
      if (previousWords[0] === "cd" && previousWords.length > 1 && /^(?:ls|ll|la|dir|eza|lsd)$/.test(cmd ?? "")) counts.cdThenLs++;
      if (previousWords[0] === "mkdir" && cmd === "cd" && args[0] !== undefined && previousWords.slice(1).filter(value => !value.startsWith("-")).includes(args[0])) counts.mkdirThenCd++;
    }
    const up = cmd === "cd" && args.length === 1 && /^(?:\.\.\/)*\.\.(?:\/)?$/.test(args[0]!);
    if (up) {
      counts.cdUp++;
      if (++upRun === 2) counts.cdUpChains++;
    } else upRun = 0;
    if (tokens.filter(token => token.kind === "op" && (token.value === "|" || token.value === "|&")).length >= 3) counts.longPipelines++;
    const hits = new Set<SignalName>();
    for (let i = 0; i < commands.length; i++) {
      const command = commands[i]!;
      const values = command.words.map(word => word.value);
      const name = values[0]?.replace(/\.(?:exe|cmd|bat|ps1)$/i, "").toLowerCase();
      const rest = values.slice(1);
      const next = commands[i + 1]?.words[0]?.value;
      const piped = command.sep === "|" || command.sep === "|&";
      if (name === "history" && piped && /^(?:grep|rg|findstr|fzf)$/.test(next ?? "")) hits.add("historyGrep");
      if (name === "cat" && rest.length === 1 && !rest[0]!.startsWith("-") && piped && /^(?:grep|head|tail|less|wc|awk|sed)$/.test(next ?? "")) hits.add("uselessCat");
      if (name === "ps" && piped && next === "grep") hits.add("psGrep");
      if (name === "grep" && rest.some(arg => arg === "--recursive" || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(arg))) hits.add("grepRecursive");
      if (name === "find" && rest.some(arg => arg === "-name" || arg === "-iname")) hits.add("findByName");
      if (name === "man" && rest.length > 0) hits.add("manLookups");
      if (name === "help" || rest.includes("--help") || rest.includes("-h")) hits.add("helpLookups");
      if (name === "clear" || name === "cls" || name === "reset") hits.add("clearScreen");
      if (name === "exit" || name === "logout") hits.add("exitCommand");
      if (name === "cd" && (rest.length === 0 || rest.length === 1 && rest[0] === "~")) hits.add("cdHome");
      if (name === "git" && rest[0] === "status") hits.add("gitStatus");
      if (name === "git" && rest[0] === "add" && rest.some(arg => arg === "." || arg === "-A" || arg === "--all")) hits.add("gitAddAll");
      if (name === "pushd" || name === "popd" || name === "cd" && rest[0] === "-") hits.add("dirStack");
    }
    for (const hit of hits) counts[hit]++;
    previousText = text;
    previousWords = words;
  }
  return counts;
}
