import type { Shell } from "./source.ts";

export interface Word {
  kind: "word";
  raw: string;
  value: string;
  quoted: boolean;
  expansion: boolean;
}

export interface Op {
  kind: "op";
  value: string;
}

export type Token = Word | Op;

export interface SimpleCommand {
  assigns: Word[];
  words: Word[];
  redirects: { op: string; target?: Word }[];
  sep: string | null;
}

const OPERATORS = [
  "&>>", "<<<", "<<-", "2>&1", ">&2", "2>>", "&>", "2>", ">>", "<<",
  "||", "&&", ";;", "|&", "|", "&", ";", "(", ")", ">", "<",
].sort((a, b) => b.length - a.length);
const SEPARATORS: Record<string, true> = {
  "|": true, "||": true, "&&": true, ";": true, "&": true, "|&": true, ";;": true, "(": true, ")": true,
};

function operatorAt(text: string, at: number): string | undefined {
  const fd = /^(?:\d+>&\d+|>&\d+|\d+>>?)/.exec(text.slice(at))?.[0];
  const op = OPERATORS.find(candidate => text.startsWith(candidate, at));
  return fd && (!op || fd.length > op.length) ? fd : op;
}

/** Find the end without evaluating, substituting, or splitting expansion contents. */
function expansionEnd(text: string, start: number): number {
  const backtick = text[start] === "`";
  const opener = text[start + 1];
  const close = opener === "{" ? "}" : ")";
  let depth = 1;
  let i = start + (backtick ? 1 : 2);
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
    } else if (backtick && c === "`") {
      return i + 1;
    } else if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (quote === '"' && text[i] === "\\") i += 2;
        else if (quote === '"' && (text[i] === "$" || text[i] === "`") && isExpansionStart(text, i)) i = expansionEnd(text, i);
        else i++;
      }
      if (i < text.length) i++;
    } else if (isExpansionStart(text, i)) {
      i = expansionEnd(text, i);
    } else if (!backtick && c === opener) {
      depth++;
      i++;
    } else if (!backtick && c === close) {
      if (--depth === 0) return i + 1;
      i++;
    } else {
      i++;
    }
  }
  return text.length;
}

function isExpansionStart(text: string, at: number): boolean {
  return text[at] === "`" ||
    ((text[at] === "$" || text[at] === "<" || text[at] === ">") && text[at + 1] === "(") ||
    (text[at] === "$" && text[at + 1] === "{");
}

function ansiEscape(text: string, at: number): { value: string; end: number } {
  const c = text[at + 1];
  if (c === undefined) return { value: "\\", end: at + 1 };
  const simple: Record<string, string> = {
    a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v",
    "\\": "\\", "'": "'", '"': '"', "\n": "",
  };
  if (Object.hasOwn(simple, c)) return { value: simple[c]!, end: at + 2 };
  const pattern = c === "x" ? /^[0-9a-fA-F]{1,2}/ : c === "u" ? /^[0-9a-fA-F]{1,4}/ : c === "U" ? /^[0-9a-fA-F]{1,8}/ : null;
  if (pattern) {
    const digits = pattern.exec(text.slice(at + 2))?.[0];
    if (digits) {
      const code = Number.parseInt(digits, 16);
      if (code <= 0x10ffff) return { value: String.fromCodePoint(code), end: at + 2 + digits.length };
    }
  }
  const octal = /^[0-7]{1,3}/.exec(text.slice(at + 1))?.[0];
  if (octal) return { value: String.fromCharCode(Number.parseInt(octal, 8)), end: at + 1 + octal.length };
  return { value: `\\${c}`, end: at + 2 };
}

const POWERSHELL_OPERATORS = ["*>>", "*>&1", "*>", "&&", "||", ">>", "|", "&", ";", "(", ")", ">", "<"];
const POWERSHELL_ESCAPES: Record<string, string> = { "0": "\0", a: "\x07", b: "\b", e: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };

function powershellOperatorAt(text: string, at: number): string | undefined {
  return /^(?:\d+>&\d+|\d+>>?)/.exec(text.slice(at))?.[0] ??
    POWERSHELL_OPERATORS.find(op => text.startsWith(op, at));
}

/** Keep expression bodies opaque: none of their words are command arguments. */
function powershellExpressionEnd(text: string, start: number): number {
  const stack: string[] = [];
  let quote = "";
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (c === "`" && quote !== "'") { i++; continue; }
    if (quote) {
      if (c === quote) {
        if (quote === "'" && text[i + 1] === "'") i++;
        else quote = "";
      }
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "(" || c === "{" || c === "[") stack.push(c === "(" ? ")" : c === "{" ? "}" : "]");
    else if (c === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return i + 1;
    }
  }
  return text.length;
}

function tokenizePowerShell(line: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < line.length) {
    if (/\s/.test(line[i]!)) {
      if (line[i] === "\n" && !/^(?:\||&&|\|\|)$/.test(tokens.at(-1)?.value ?? "")) tokens.push({ kind: "op", value: ";" });
      i++;
      continue;
    }
    if (line.startsWith("<#", i)) {
      const end = line.indexOf("#>", i + 2);
      i = end < 0 ? line.length : end + 2;
      continue;
    }
    if (line[i] === "#") {
      while (i < line.length && line[i] !== "\n") i++;
      continue;
    }
    const op = powershellOperatorAt(line, i);
    if (op) { tokens.push({ kind: "op", value: op }); i += op.length; continue; }
    const start = i;
    let value = "";
    let quoted = false;
    let expansion = false;
    while (i < line.length && !/\s/.test(line[i]!)) {
      const c = line[i]!;
      if (c === "`") {
        const next = line[i + 1];
        if (next === "\r" && line[i + 2] === "\n") i += 3;
        else if (next !== undefined) { if (next !== "\n") value += POWERSHELL_ESCAPES[next] ?? next; i += 2; }
        else { value += c; i++; }
      } else if (c === "@" && /['"]/.test(line[i + 1] ?? "") && /^\r?\n/.test(line.slice(i + 2))) {
        const quote = line[i + 1]!;
        const body = i + 2 + (line[i + 2] === "\r" ? 2 : 1);
        const close = new RegExp(`^${quote}@`, "m");
        const match = close.exec(line.slice(body));
        const end = match ? body + match.index : line.length;
        value += line.slice(body, end).replace(/\r?\n$/, "");
        quoted = true;
        expansion ||= quote === '"' && /\$/.test(line.slice(body, end));
        i = match ? end + 2 : end;
      } else if (((c === "$" || c === "@") && /[({]/.test(line[i + 1] ?? "")) || c === "{") {
        const end = powershellExpressionEnd(line, c === "{" ? i : i + 1);
        value += line.slice(i, end);
        expansion = true;
        i = end;
      } else if (c === "'" || c === '"') {
        quoted = true;
        const quote = c;
        i++;
        while (i < line.length) {
          if (line[i] === quote) {
            if (quote === "'" && line[i + 1] === "'") { value += "'"; i += 2; continue; }
            i++;
            break;
          }
          if (quote === '"' && line[i] === "`" && i + 1 < line.length) {
            const next = line[i + 1]!;
            if (next !== "\n") value += POWERSHELL_ESCAPES[next] ?? next;
            i += 2;
          } else if (quote === '"' && line[i] === "$" && /[({]/.test(line[i + 1] ?? "")) {
            const end = powershellExpressionEnd(line, i + 1);
            value += line.slice(i, end);
            expansion = true;
            i = end;
          } else {
            if (quote === '"' && line[i] === "$" && /[\w?:^]/.test(line[i + 1] ?? "")) expansion = true;
            value += line[i++]!;
          }
        }
      } else if (line.startsWith("<#", i) || powershellOperatorAt(line, i)) break;
      else {
        if (c === "$" && /[\w?:^]/.test(line[i + 1] ?? "")) expansion = true;
        if (c === "@" && /[A-Za-z_]/.test(line[i + 1] ?? "")) expansion = true;
        value += c;
        i++;
      }
    }
    if (value || quoted || expansion) tokens.push({ kind: "word", raw: line.slice(start, i), value, quoted, expansion });
  }
  return tokens;
}

export function tokenize(line: string, shell: Shell = "bash"): Token[] {
  if (shell === "powershell") return tokenizePowerShell(line);
  const tokens: Token[] = [];
  let i = 0;
  let heredoc = false;
  while (i < line.length) {
    if (/\s/.test(line[i]!)) {
      // Heredoc bodies are data, not commands. Keep only the command's first logical line.
      if (heredoc && (line[i] === "\n" || line[i] === "\r")) break;
      i++;
      continue;
    }
    if (line[i] === "#") {
      while (i < line.length && line[i] !== "\n") i++;
      continue;
    }
    const op = isExpansionStart(line, i) ? undefined : operatorAt(line, i);
    if (op) {
      tokens.push({ kind: "op", value: op });
      if (op === "<<" || op === "<<-") heredoc = true;
      i += op.length;
      continue;
    }
    const start = i;
    let value = "";
    let quoted = false;
    let expansion = false;
    while (i < line.length && !/\s/.test(line[i]!)) {
      const c = line[i]!;
      if (isExpansionStart(line, i)) {
        const end = expansionEnd(line, i);
        value += line.slice(i, end);
        expansion = true;
        i = end;
      } else if (c === "'" || c === '"' || (c === "$" && line[i + 1] === "'")) {
        quoted = true;
        const ansi = c === "$";
        const quote = ansi ? "'" : c;
        i += ansi ? 2 : 1;
        while (i < line.length && line[i] !== quote) {
          if (ansi && line[i] === "\\") {
            const escape = ansiEscape(line, i);
            value += escape.value;
            i = escape.end;
          } else if (quote === '"' && line[i] === "\\" && /["\\$`\n]/.test(line[i + 1] ?? "")) {
            if (line[i + 1] !== "\n") value += line[i + 1];
            i += 2;
          } else if (quote === '"' && (line[i] === "$" || line[i] === "`") && isExpansionStart(line, i)) {
            const end = expansionEnd(line, i);
            value += line.slice(i, end);
            expansion = true;
            i = end;
          } else {
            if (quote === '"' && line[i] === "$" && /[A-Za-z0-9_@*#?$!-]/.test(line[i + 1] ?? "")) expansion = true;
            value += line[i++];
          }
        }
        if (i < line.length) i++;
      } else if (c === "\\") {
        if (i + 1 < line.length) {
          if (line[i + 1] !== "\n") value += line[i + 1];
          i += 2;
        } else {
          value += c;
          i++;
        }
      } else if (!/\d/.test(c) && operatorAt(line, i)) {
        break;
      } else {
        if (c === "$" && /[A-Za-z0-9_@*#?$!-]/.test(line[i + 1] ?? "")) expansion = true;
        value += c;
        i++;
      }
    }
    if (value || quoted || expansion) {
      tokens.push({ kind: "word", raw: line.slice(start, i), value, quoted, expansion });
    }
  }
  return tokens;
}

export function splitCommands(tokens: readonly Token[]): SimpleCommand[] {
  const result: SimpleCommand[] = [];
  let command: SimpleCommand = { assigns: [], words: [], redirects: [], sep: null };
  const finish = (sep: string | null) => {
    if (command.assigns.length || command.words.length || command.redirects.length) {
      command.sep = sep;
      result.push(command);
    }
    command = { assigns: [], words: [], redirects: [], sep: null };
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "op") {
      if (Object.hasOwn(SEPARATORS, token.value)) {
        finish(token.value);
      } else {
        const redirect: SimpleCommand["redirects"][number] = { op: token.value };
        if (!/^(?:\d+|\*)?>&\d+$/.test(token.value) && tokens[i + 1]?.kind === "word") {
          redirect.target = tokens[++i] as Word;
        }
        command.redirects.push(redirect);
      }
    } else if (!command.words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) {
      command.assigns.push(token);
    } else {
      command.words.push(token);
    }
  }
  finish(null);
  return result;
}
