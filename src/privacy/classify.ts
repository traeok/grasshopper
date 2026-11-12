import { loadConfig } from "../core/config.ts";
import type { Shell } from "../history/source.ts";
import { splitCommands, tokenize } from "../history/tokenize.ts";
import { findHighEntropyTokens } from "./entropy.ts";
import { SECRET_RULES } from "./secret-rules.ts";

export type DropCategory = "secret" | "credential-command" | "registry-config" | "possible-password" | "leading-space" | "oversized" | "user-rule";

export interface Classification {
  drop: DropCategory | null;
  secretRule?: string;
}

const WRAPPERS: Record<string, true> = {
  sudo: true, doas: true, gsudo: true, winpty: true, env: true, command: true, time: true, nohup: true,
};
const CREDENTIAL_COMMANDS: Record<string, true> = {
  passwd: true, chpasswd: true, "ssh-keygen": true, "ssh-add": true, "ssh-copy-id": true, sshpass: true,
  htpasswd: true, cmdkey: true, op: true, bw: true, pass: true, vault: true, security: true,
  gpg: true, gpg2: true, keyring: true, "secret-tool": true, "aws-vault": true, kinit: true,
};
const CREDENTIAL_WORDS: Record<string, true> = {
  login: true, logon: true, signin: true, "sign-in": true, adduser: true, auth: true, configure: true,
  credential: true, credentials: true, "credential-helper": true, "get-login-password": true,
  "get-token": true, token: true, tokens: true, "set-credentials": true, unlock: true, secret: true,
  secrets: true, keyvault: true, secretsmanager: true,
};
const REGISTRY_COMMANDS: Record<string, true> = {
  npm: true, pnpm: true, yarn: true, bun: true, pip: true, pip3: true, poetry: true, uv: true, nuget: true, dotnet: true,
};
const REGISTRY_FLAGS: Record<string, true> = {
  "--registry": true, "--index-url": true, "--extra-index-url": true, "-i": true,
};
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function commandName(word: string): string {
  return word.toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, "");
}

function onlyVariableReferences(value: string): boolean {
  const parts = value.replace(/["']/g, "").trim().split(/\s+/);
  while (/^(?:bearer|basic|token|digest)$/i.test(parts[0] ?? "")) parts.shift();
  return parts.length > 0 && parts.every(part => /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(part) || part.startsWith("$("));
}

/** Classify locally; neither the entry nor matched secret values are retained. */
export function classifyEntry(text: string, ctx: { knownWords: (word: string) => boolean; shell?: Shell }): Classification {
  if (text.length > 1000 || text.split("\n").length > 15) return { drop: "oversized" };
  if (/^[ \t]/.test(text)) return { drop: "leading-space" };
  if (loadConfig().privacy.extraDropPatterns.some(pattern => new RegExp(pattern, "i").test(text))) {
    return { drop: "user-rule" };
  }

  for (const rule of SECRET_RULES) {
    const match = rule.re.exec(text);
    if (!match) continue;
    const value = rule.valueGroup === undefined ? undefined : match[rule.valueGroup];
    if (value !== undefined && onlyVariableReferences(value)) return { drop: "credential-command" };
    return { drop: "secret", secretRule: rule.id };
  }
  if (findHighEntropyTokens(text).length > 0) return { drop: "secret", secretRule: "high-entropy" };

  const tokens = tokenize(text, ctx.shell);
  if (ctx.shell === "powershell") {
    const decoded = tokens.map(token => token.value).join(" ");
    // Scope prefixes and backtick escapes are native syntax, not POSIX words.
    if (/\$(?:(?:env|global|script|local|private):)?[\w{}:]*(?:password|passwd|pwd|token|secret|api_?key|credential|authorization|cookie)[\w{}:]*\s*=/i.test(decoded) ||
        /\b(?:set|new)-item\s+(?:-path\s+|-literalpath\s+)?env:[\w]*(?:password|passwd|pwd|token|secret|api_?key|credential|authorization|cookie)\w*/i.test(decoded)) {
      return { drop: "secret", secretRule: "powershell-secret-assignment" };
    }
    for (const simple of splitCommands(tokens)) {
      const name = commandName(simple.words[0]?.value ?? "").replace(/^.*[\\/]/, "");
      if (Object.hasOwn(CREDENTIAL_COMMANDS, name) ||
          /^(?:get-credential|(?:get|set|remove|unlock|register)-secret(?:info|vault)?|convert(?:to|from)-securestring|new-pssession|enter-pssession|connect-azaccount|connect-exchangeonline|connect-mggraph)$/.test(name) ||
          /\bpscredential\b/i.test(decoded) ||
          simple.words.some(word => /^-(?:credential|password|passwd|token|secret|apikey|authentication|headers|asplaintext)(?:[:=]|$)/i.test(word.value)) ||
          /^(?:set-variable|new-variable|sv|setx)$/.test(name) && simple.words.slice(1).some(word => /password|passwd|pwd|token|secret|api_?key|credential|authorization|cookie/i.test(word.value))) {
        return { drop: "credential-command" };
      }
    }
  }
  const words = splitCommands(tokens)[0]?.words.map(word => word.value) ?? [];
  let at = 0;
  while (Object.hasOwn(WRAPPERS, commandName(words[at] ?? ""))) {
    const wrapper = commandName(words[at++]!);
    while (at < words.length) {
      const word = words[at]!;
      if (word === "--") { at++; break; }
      if (ASSIGNMENT.test(word)) { at++; continue; }
      if (!word.startsWith("-")) break;
      at++;
      // These wrapper options consume a value, not the effective command word.
      if ((["sudo", "doas", "gsudo"].includes(wrapper) && /^(?:-u|-g|-h|-p|-C|-T|-r|-t|--user|--group|--host|--prompt|--close-from|--command-timeout|--role|--type)$/.test(word)) ||
          (wrapper === "env" && /^(?:-u|--unset|-C|--chdir)$/.test(word)) ||
          (wrapper === "time" && /^(?:-f|--format|-o|--output)$/.test(word))) at++;
    }
  }
  const command = commandName(words[at] ?? "");
  const args = words.slice(at + 1).map(word => word.toLowerCase());
  if (Object.hasOwn(CREDENTIAL_COMMANDS, command) || args.slice(0, 4).some(word => Object.hasOwn(CREDENTIAL_WORDS, word)) ||
      (command === "git" && (args[0]?.startsWith("credential") ||
        (args[0] === "config" && args.slice(1).some(word => word.includes("credential") || word.startsWith("url."))))) ||
      (command === "aws" && ((args[0] === "ssm" && args[1]?.startsWith("get-parameter")) ||
        (args[0] === "sts" && args[1]?.startsWith("assume-role"))))) {
    return { drop: "credential-command" };
  }

  if (Object.hasOwn(REGISTRY_COMMANDS, command) && /\b(?:config\s+set|set|sources\s+add|add\s+source|nuget\s+add)\b/i.test(text) &&
      /registry|index-url|extra-index-url|trusted-host|source|\/\//i.test(text)) {
    return { drop: "registry-config" };
  }
  const allWords = tokens.filter(token => token.kind === "word").map(word => word.value);
  for (let i = 0; i < allWords.length; i++) {
    const word = allWords[i]!;
    const equals = word.indexOf("=");
    const flag = (equals < 0 ? word : word.slice(0, equals)).toLowerCase();
    const value = equals < 0 ? allWords[i + 1] : word.slice(equals + 1);
    if (Object.hasOwn(REGISTRY_FLAGS, flag) && /^[a-z][a-z0-9+.-]*:\/\//i.test(value ?? "")) {
      return { drop: "registry-config" };
    }
  }

  if (!/\s/.test(text) && text.length >= 6 && !ctx.knownWords(text) && !(ctx.shell === "powershell" && ctx.knownWords(commandName(text)))) {
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/];
    if (classes.filter(re => re.test(text)).length >= 3) return { drop: "possible-password" };
  }
  return { drop: null };
}
