import type { Shell } from "../history/source.ts";
import type { Category } from "../llm/schema.ts";
import type { DropCategory } from "../privacy/classify.ts";
import type { Status } from "../recs/store.ts";
import type { RedFlagKind } from "./red-flags.ts";
import type { SignalName } from "./signals.ts";

export interface TrendItem {
  c: string;
  recent: number;
  baseline: number;
}

export type Trends =
  | { available: false; reason: "collecting" }
  | {
      available: true;
      basis: "timestamps" | "ingestion-days";
      recentDays: 7;
      baselineDays: 28;
      rising: TrendItem[];
      falling: TrendItem[];
      new: TrendItem[];
    };

export interface Profile {
  schema: "ghop-profile/1";
  environment: {
    shell: Shell;
    shellVersion: string | null;
    platform: "windows-gitbash" | "windows" | "macos" | "linux" | "wsl";
    keymap: "windows" | "emacs" | "vi" | "unknown";
    frameworks: ("oh-my-zsh" | "starship" | "powerlevel10k")[];
    packageManagers: string[];
    installedTools: string[];
    history: {
      entries: number;
      timestamps: boolean;
      sizeLimit: number | null;
      fileLimit: number | null;
      ignoreSpace: boolean | null;
      ignoreDups: boolean | null;
      appendIncremental: boolean | null;
      shared: boolean | null;
    };
    options: Record<string, boolean>;
  };
  window: { entries: number; kept: number; dropped: number; spanDays: number | null };
  topCommands: { c: string; n: number }[]; // At most 25, by cmdKey.
  topSubcommands: { c: string; n: number }[]; // At most 25, by subKey.
  templates: { t: string; n: number; len: number }[]; // At most 30; n >= 2.
  aliasCandidates: { t: string; n: number; len: number; savedChars: number; coveredBy: string | null }[]; // At most 15; n >= 5, len >= 8.
  sequences: { seq: string[]; n: number }[]; // At most 15; n >= 4.
  repeats: { t: string; runs: number; maxRun: number }[]; // At most 10; run length >= 3.
  paths: { p: string; n: number; depth: number; viaCd: number }[]; // At most 10, numbered path placeholders only.
  hosts: { h: string; n: number; via: string[] }[]; // At most 10; via has at most 4 cmdKeys.
  aliases: { a: string; expands: string | null; used: number; fullFormUsed: number }[]; // At most 40.
  functions: { f: string; used: number }[]; // At most 20; used >= 1.
  typos: { typed: string; meant: string; n: number }[]; // At most 10.
  slow: { t: string; n: number; avgSec: number }[]; // At most 10; n >= 3, avgSec >= 10.
  signals: Record<SignalName, number>;
  redFlags: { kind: RedFlagKind; n: number }[]; // Only positive counts.
  trends: Trends;
  memory: { category: Category; status: Status; evidence: string[]; tool: string | null }[]; // At most 80, all statuses.
}

export interface AnalysisStats {
  entries: number;
  kept: number;
  fresh: number;
  dropped: Record<DropCategory, number>;
  secretRules: Record<string, number>;
  pseudonyms: Record<string, number>;
  grammarSkips: number;
  payloadBytes: number;
  unknownCommands: { c: string; n: number }[]; // At most 10; local diagnostics only, never part of Profile.
}
