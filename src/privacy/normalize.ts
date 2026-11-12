import { loadConfig } from "../core/config.ts";
import type { HistoryEntry } from "../history/parse.ts";
import type { Shell } from "../history/source.ts";
import { splitCommands, tokenize } from "../history/tokenize.ts";
import type { SimpleCommand, Token, Word } from "../history/tokenize.ts";
import {
  COMMANDS, WRAPPERS, SUBCOMMANDS, SUBCOMMANDS2, COMMON_LONG_FLAGS,
  SAFE_ENV_NAMES, SAFE_LITERALS, SAFE_LITERAL_RES, COMMON_SCRIPTS,
  COMMON_TARGETS, PY_MODULES, NPX_LIKE, NPX_KNOWN, GIT_REF_SUBCOMMANDS,
  PKG_ARG_SUBCOMMANDS, HOST_ARG_COMMANDS, PATH_ARG_COMMANDS, FILE_EXTENSIONS,
} from "./dictionary.ts";

export type PlaceholderType = "path"|"url"|"host"|"cmd"|"alias"|"fn"|"arg"|"ref"|"pkg"|"script"|"var"|"str"|"num"|"val"|"glob"|"flag"|"subshell"|"heredoc";
export interface NormToken { text: string; literal?: { type: PlaceholderType; value: string } }
export interface NormCommand { cmdKey: string; subKey: string|null; tokens: NormToken[]; rawCmd: string }
export interface NormEntry { entry: HistoryEntry; commands: NormCommand[]; ops: string[] }
interface Context { aliases: Set<string>; functions: Set<string>; shell?: Shell }

const separators: Record<string, true> = { "|": true, "||": true, "&&": true, ";": true, "&": true, "|&": true, ";;": true, "(": true, ")": true };
const scriptCommands: Record<string, true> = { npm: true, pnpm: true, yarn: true, bun: true };
const messageSubs: Record<string, true> = { commit: true, tag: true, merge: true, stash: true, notes: true };
const pythonCommands: Record<string, true> = { python: true, python3: true, py: true };
const targetCommands: Record<string, true> = { make: true, just: true, task: true };
const placeholder = (type: PlaceholderType, value: string): NormToken => ({ text: `<${type}>`, literal: { type, value } });
const plain = (text: string): NormToken => ({ text });
const commandName = (value: string): string => value.replace(/\.(?:exe|cmd|bat|ps1)$/i, "").toLowerCase();
const pathValue = (value: string): string => /^(?:[A-Za-z]:[\\/]|[\\/]|~\/)\s*$/.test(value) ? value : value.replace(/[\\/]+$/, "");
function contextName(names: Set<string>, value: string, shell?: Shell): string | undefined {
  if (names.has(value)) return value;
  if (shell === "powershell") {
    const lower = value.toLowerCase();
    for (const name of names) if (name.toLowerCase() === lower) return name;
  }
  return undefined;
}


function commandToken(word: Word, ctx: Context, allowed: Set<string>): { token: NormToken; key: string } {
  const name = commandName(word.value);
  if (word.expansion) return { token: placeholder("subshell", word.value), key: "<cmd>" };
  const alias = contextName(ctx.aliases, word.value, ctx.shell);
  if (alias !== undefined) return { token: placeholder("alias", alias), key: "<alias>" };
  const fn = contextName(ctx.functions, word.value, ctx.shell);
  if (fn !== undefined) return { token: placeholder("fn", fn), key: "<fn>" };
  if (COMMANDS.has(name) || allowed.has(name)) return { token: plain(name), key: name };
  if (/[\\/]/.test(word.value) || word.value.startsWith(".")) return { token: placeholder("path", pathValue(word.value)), key: "<script>" };
  return { token: placeholder("cmd", word.value), key: "<cmd>" };
}

function normalizeCommand(simple: SimpleCommand, source: Token[], ctx: Context, allowed: Set<string>): NormCommand[] {
  const normalized = new Map<Word, NormToken>();
  for (const assign of simple.assigns) {
    const name = assign.value.slice(0, assign.value.indexOf("="));
    normalized.set(assign, SAFE_ENV_NAMES.has(name)
      ? plain(`${name}=<val>`)
      : { text: "<var>=<val>", literal: { type: "var", value: name } });
  }
  for (const redirect of simple.redirects) {
    if (redirect.target) normalized.set(redirect.target, placeholder("path", pathValue(redirect.target.value)));
  }
  const wrappers: NormCommand[] = [];
  let effective = 0;
  while (effective < simple.words.length) {
    const word = simple.words[effective]!;
    const command = commandToken(word, ctx, allowed);
    normalized.set(word, command.token);
    if (!WRAPPERS.has(command.key) || effective + 1 === simple.words.length) break;
    wrappers.push({ cmdKey: command.key, subKey: null, tokens: [], rawCmd: word.value });
    effective++;
    while (simple.words[effective]?.value.startsWith("-")) {
      const flag = simple.words[effective]!;
      normalized.set(flag, normalizeFlag(flag.value, true, ctx.shell));
      effective++;
    }
    // env commonly supplies assignments before the wrapped command.
    while (command.key === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(simple.words[effective]?.value ?? "")) {
      const assign = simple.words[effective++]!;
      const name = assign.value.slice(0, assign.value.indexOf("="));
      normalized.set(assign, SAFE_ENV_NAMES.has(name) ? plain(`${name}=<val>`) : { text: "<var>=<val>", literal: { type: "var", value: name } });
    }
  }
  const word = simple.words[effective];
  const cmdKey = word ? commandToken(word, ctx, allowed).key : "<cmd>";
  const known = COMMANDS.has(cmdKey) || allowed.has(cmdKey);
  let positional = 0;
  let sub: string|null = null;
  let second: string|null = null;
  let afterDash = false;
  let message = false;
  let module = false;
  let hostSeen = false;
  for (let i = effective + 1; i < simple.words.length; i++) {
    const arg = simple.words[i]!;
    const value = arg.value;
    let token: NormToken;
    if (message) {
      token = placeholder("str", value);
      message = false;
    } else if (arg.expansion) token = ctx.shell === "powershell" && /^-[A-Za-z][A-Za-z-]*[:=]/.test(value)
      ? normalizeFlag(value, known, ctx.shell) : placeholder("subshell", value);
    else if (ctx.shell === "powershell" && /^(?:[A-Za-z]:[\\/]|\\\\|\.{1,2}\\|~\\)/.test(value)) {
      token = placeholder("path", pathValue(value));
      positional++;
    } else if (ctx.shell === "powershell" && arg.quoted && value.startsWith("-")) token = placeholder("str", value);
    else if (SAFE_LITERALS.has(value) || SAFE_LITERAL_RES.some(re => re.test(value))) {
      token = plain(value);
      if (value === "--") afterDash = true;
      else if (value !== "-") positional++;
    } else if (value.startsWith("-") && !afterDash && !/^-\d/.test(value)) {
      token = normalizeFlag(value, known, ctx.shell);
      if (cmdKey === "git" && messageSubs[sub ?? ""] && (value === "-m" || value === "--message")) message = true;
      module = !!pythonCommands[cmdKey] && value === "-m";
    } else {
      positional++;
      const first = positional === 1;
      const isSecond = positional === 2;
      if (!afterDash && first && SUBCOMMANDS[cmdKey]?.has(value)) {
        sub = value;
        token = plain(value);
      } else if (!afterDash && isSecond && SUBCOMMANDS2[`${cmdKey} ${sub}`]?.has(value)) {
        second = value;
        token = plain(value);
      } else if (!afterDash && scriptCommands[cmdKey] && ((isSecond && (sub === "run" || sub === "run-script")) || (first && cmdKey !== "npm"))) {
        token = COMMON_SCRIPTS.has(value) ? plain(value) : placeholder("script", value);
      } else if (!afterDash && first && targetCommands[cmdKey]) token = COMMON_TARGETS.has(value) ? plain(value) : placeholder("arg", value);
      else if (module) token = PY_MODULES.has(value) ? plain(value) : placeholder("arg", value);
      else if (!afterDash && ((first && NPX_LIKE.has(cmdKey)) || (isSecond && NPX_LIKE.has(`${cmdKey} ${sub}`)))) token = NPX_KNOWN.has(value) || COMMANDS.has(value) ? plain(value) : placeholder("pkg", value);
      else if (allowed.has(value)) token = plain(value);
      else if (arg.quoted && /\s/.test(value)) token = placeholder("str", value);
      else if (/^-?\d+([.,]\d+)?[kKmMgG%]?$/.test(value)) token = placeholder("num", value);
      else if (!afterDash && cmdKey === "git" && GIT_REF_SUBCOMMANDS.has(sub ?? "")) token = placeholder("ref", value);
      else if (!afterDash && (PKG_ARG_SUBCOMMANDS[cmdKey]?.has(sub ?? "") || PKG_ARG_SUBCOMMANDS[cmdKey]?.has("*") || PKG_ARG_SUBCOMMANDS[`${cmdKey} ${sub}`]?.has(second ?? ""))) token = placeholder("pkg", value);
      else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^www\./i.test(value)) token = placeholder("url", value);
      else {
        const fqdn = /^(?:[a-z0-9-]{1,63}\.)+([a-z]{2,24})(?::\d+)?$/i.exec(value);
        const host = /^[^\s@/\\]+@[^\s@/\\]+(?::.*)?$/.test(value) || /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(value) || (fqdn && !FILE_EXTENSIONS.has(fqdn[1]!.toLowerCase())) || (HOST_ARG_COMMANDS.has(cmdKey) && !hostSeen && !/[\\/~]/.test(value) && !value.startsWith("."));
        if (host) {
          hostSeen = true;
          token = placeholder("host", value.replace(/^.*@/, "").replace(/:.*$/, "").toLowerCase());
        } else if (/[\\/]/.test(value) || /^(?:~|\.?\.\/|[A-Za-z]:)/.test(value) || (value.includes(".") && FILE_EXTENSIONS.has(value.split(".").at(-1)?.toLowerCase() ?? "")) || PATH_ARG_COMMANDS.has(cmdKey)) token = placeholder("path", pathValue(value));
        else if (/[*?\[]/.test(value)) token = placeholder("glob", value);
        else token = placeholder("arg", value);
      }
      module = false;
    }
    normalized.set(arg, token);
  }
  const tokens = source.map(token => token.kind === "op" ? plain(token.value) : normalized.get(token) ?? placeholder("arg", token.value));
  return [...wrappers, { cmdKey, subKey: sub ? `${cmdKey} ${sub}` : null, tokens, rawCmd: word?.value ?? "" }];
}

function normalizeFlag(value: string, known: boolean, shell?: Shell): NormToken {
  const lower = value.toLowerCase();
  const flag = shell === "powershell" && COMMON_LONG_FLAGS.has(lower.split(/[:=]/, 1)[0]!) ? lower : value;
  if (known && (/^-[A-Za-z]{1,4}$/.test(value) || COMMON_LONG_FLAGS.has(flag))) return plain(flag);
  const equals = shell === "powershell" ? value.search(/[:=]/) : value.indexOf("=");
  const name = flag.slice(0, equals);
  if (known && equals > 0 && COMMON_LONG_FLAGS.has(name)) return { text: `${name}=<val>`, literal: { type: "val", value: value.slice(equals + 1) } };
  return placeholder("flag", value);
}

export function normalizeEntry(entry: HistoryEntry, ctx: Context): NormEntry {
  const allowed = new Set(loadConfig().privacy.allowWords);
  const result: NormEntry = { entry, commands: [], ops: [] };
  let chunk: Token[] = [];
  let prefix: NormToken[] = [];
  const flush = (sep: string) => {
    const simple = splitCommands(chunk)[0];
    if (simple) {
      const commands = normalizeCommand(simple, chunk, ctx, allowed);
      const last = commands.at(-1)!;
      last.tokens.unshift(...prefix);
      prefix = [];
      result.commands.push(...commands);
      result.ops.push(...commands.map((_, i) => i === commands.length - 1 ? sep : ""));
    } else if (sep) {
      // Parentheses can stand alone; retain their position without inventing a command.
      if (result.commands.length && sep !== "(") {
        const index = result.commands.length - 1;
        if (result.ops[index]) result.commands[index]!.tokens.push(plain(result.ops[index]!));
        result.ops[index] = sep;
      } else prefix.push(plain(sep));
    }
    chunk = [];
  };
  for (const token of tokenize(entry.text, ctx.shell)) {
    if (token.kind === "op" && separators[token.value]) flush(token.value);
    else chunk.push(token);
  }
  flush("");
  return result;
}
