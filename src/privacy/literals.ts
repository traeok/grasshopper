import { readFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import type { Config } from "../core/config.ts";
import { homeDir, toNativePath, toShellPath } from "../core/paths.ts";
import { isKnownWord, PUBLIC_HOSTS } from "./dictionary.ts";
import { SCHEMA_WORDS } from "./grammar.ts";

export interface SensitiveLiteral { value: string; kind: string }

const schemaWords = new Set([...SCHEMA_WORDS].map(word => word.toLowerCase()));
const secretKey = /token|password|passwd|secret|_auth|auth|apikey|api_key|access_key|secret_key|aws_access_key_id|aws_secret_access_key|aws_session_token|oauth_token/i;
const configFiles = [
  ".npmrc", ".yarnrc", ".yarnrc.yml", ".config/pip/pip.conf", ".pip/pip.conf",
  ".pypirc", ".docker/config.json", ".kube/config", ".git-credentials", ".netrc", "_netrc",
  ".aws/config", ".aws/credentials", ".nuget/NuGet/NuGet.Config", ".m2/settings.xml",
  ".gradle/gradle.properties", ".cargo/config.toml", ".config/gh/hosts.yml",
] as const;

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^("[\s\S]*"|'[\s\S]*')$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function hostOnly(value: string): string {
  const host = value.trim().replace(/^.*@/, "");
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  if (bracketed) return bracketed[1]!;
  return host.replace(/:\d+$/, "").replace(/^\.+|\.+$/g, "");
}

/** One shared, non-global matcher; callers can add `g` when replacing every match. */
export function literalRegex(literals: SensitiveLiteral[]): RegExp | null {
  const values = [...new Set(literals.map(literal => literal.value).filter(Boolean))];
  if (!values.length) return null;
  values.sort((a, b) => b.length - a.length || a.localeCompare(b));
  const alternatives = values.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![A-Za-z0-9])(?:${alternatives.join("|")})(?![A-Za-z0-9])`, "i");
}

/** Best effort only: literals stay in memory and are never included in diagnostics. */
export async function harvestSensitiveLiterals(config: Config): Promise<SensitiveLiteral[]> {
  const literals = new Map<string, SensitiveLiteral>();
  const allowWords = new Set(config.privacy.allowWords.map(word => word.toLowerCase()));
  const add = (raw: string | undefined, kind: string) => {
    if (!raw) return;
    const value = unquote(raw);
    const lower = value.toLowerCase();
    if (value.length < 4 || /^\d{1,5}$/.test(value) || allowWords.has(lower)
      || schemaWords.has(lower) || PUBLIC_HOSTS.has(lower) || isKnownWord(lower)) return;
    if (!literals.has(lower)) literals.set(lower, { value, kind });
  };
  const addHost = (raw: string, kind: string) => add(hostOnly(raw), kind);
  const scanHosts = (text: string, kind: string) => {
    for (const match of text.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`,;]+/gi)) {
      try { addHost(new URL(match[0]).hostname, kind); } catch { /* Not a URL. */ }
    }
    for (const match of text.matchAll(/(?:^|[\s"'=])[^@\s/:]+@([^:\s/]+):/g)) addHost(match[1]!, kind);
    for (const match of text.matchAll(/(?<![A-Za-z0-9_.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?![A-Za-z0-9_.-])/gi)) {
      addHost(match[0], kind);
    }
  };
  const read = async (file: string): Promise<string> => {
    try { return await readFile(file, "utf8"); } catch { return ""; }
  };

  try { add(userInfo().username, "username"); } catch { /* Identity may be unavailable. */ }
  try { add(hostname(), "hostname"); } catch { /* Identity may be unavailable. */ }
  for (const name of ["USERNAME", "USER", "LOGNAME"]) add(process.env[name], "username");
  for (const name of ["COMPUTERNAME", "HOSTNAME", "LOGONSERVER"]) {
    add(process.env[name]?.replace(/^\\+/, ""), "hostname");
  }
  for (const name of ["USERDOMAIN", "USERDNSDOMAIN"]) add(process.env[name], "domain");
  const home = homeDir();
  add(home, "home");
  add(toShellPath(home, "bash"), "home");

  const git = Bun.which("git");
  if (git) {
    try {
      const result = Bun.spawnSync([git, "config", "--global", "--get-regexp", "^(user\\.(name|email)|url\\..*)$"], {
        cwd: home,
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdout: "pipe", stderr: "ignore",
      });
      if (result.exitCode === 0) {
        for (const line of new TextDecoder().decode(result.stdout).split(/\r?\n/)) {
          const match = /^(\S+)\s+(.+)$/.exec(line);
          if (!match) continue;
          const key = match[1]!;
          const value = match[2]!;
          if (key.toLowerCase() === "user.name") add(value, "git-identity");
          else if (key.toLowerCase() === "user.email") {
            add(value, "email");
            const domain = value.slice(value.lastIndexOf("@") + 1);
            if (value.includes("@")) add(domain, "domain");
          } else {
            scanHosts(key.slice(4, key.lastIndexOf(".")), "registry-host");
            scanHosts(value, "registry-host");
          }
        }
      }
    } catch { /* Git is optional and its config may be unreadable. */ }
  }

  const ssh = await read(join(home, ".ssh", "config"));
  for (const line of ssh.split(/\r?\n/)) {
    const match = /^\s*(HostName|Host|User|ProxyJump)(?:\s*=\s*|\s+)([^#]+)/i.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    for (const token of match[2]!.trim().split(key === "proxyjump" ? /[\s,]+/ : /\s+/)) {
      const value = unquote(token);
      if (!value || /[*?!%]/.test(value)) continue;
      if (key === "user") add(value, "username");
      else {
        if (key === "proxyjump" && value.includes("@")) add(value.slice(0, value.lastIndexOf("@")), "username");
        addHost(value, "ssh-host");
      }
    }
  }
  const knownHosts = await read(join(home, ".ssh", "known_hosts"));
  for (const line of knownHosts.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (!fields[0] || fields[0].startsWith("#")) continue;
    const hosts = fields[0].startsWith("@") ? fields[1] : fields[0];
    if (!hosts || hosts.startsWith("|1|")) continue;
    for (const host of hosts.split(",")) addHost(host, "ssh-host");
  }

  const files: string[] = configFiles.map(file => join(home, file));
  if (process.env.APPDATA) {
    const appData = toNativePath(process.env.APPDATA);
    files.push(join(appData, "pip", "pip.ini"), join(appData, "NuGet", "NuGet.Config"));
  }
  for (const file of files) {
    const text = await read(file);
    if (file === join(home, ".kube/config")) {
      for (const match of text.matchAll(/^\s*(?:-\s*)?name:\s*(.+)$/gm)) add(match[1], "cluster");
      for (const match of text.matchAll(/^\s*server:\s*(.+)$/gm)) scanHosts(match[1]!, "cluster");
    }
    scanHosts(text, "registry-host");
    // Key/value scanning also covers quoted JSON/YAML keys, without parsing config syntax.
    for (const match of text.matchAll(/^\s*([^=\r\n]+?)\s*=\s*("[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/gm)) {
      if (secretKey.test(match[1]!)) add(match[2], "credential");
    }
    for (const match of text.matchAll(/(?:^|[\n\r,{])\s*["']?([^\s=:\n\r"']+)["']?\s*[=:]\s*("[^"\r\n]*"|'[^'\r\n]*'|[^\s[{},\r\n][^,\r\n}]*)/g)) {
      if (secretKey.test(match[1]!)) add(match[2], "credential");
    }
    if (/(?:^|[/\\])_?netrc$/.test(file) || /(?:^|[/\\])\.netrc$/.test(file)) {
      for (const match of text.matchAll(/\b(machine|login|password)\s+("[^"]*"|'[^']*'|\S+)/gi)) {
        add(match[2], match[1]!.toLowerCase() === "machine" ? "registry-host" : match[1]!.toLowerCase() === "login" ? "username" : "credential");
      }
    }
    if (file.endsWith(".git-credentials")) {
      for (const line of text.split(/\r?\n/)) {
        try {
          const url = new URL(line.trim());
          for (const value of [url.username, url.password]) {
            add(value, "credential");
            try { add(decodeURIComponent(value), "credential"); } catch { /* Invalid percent encoding. */ }
          }
          addHost(url.hostname, "registry-host");
        } catch { /* Not a credential URL. */ }
      }
    }
  }

  for (const [name, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (/(TOKEN|SECRET|PASSWORD|PASSWD|PASS|API_?KEY|PRIVATE|CREDENTIAL|AUTH|SESSION|COOKIE)/i.test(name) && value.length >= 6) add(value, "env-secret");
    if (/^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(name)) {
      scanHosts(value, "proxy-host");
      for (const part of value.split(/[\s,]+/)) {
        if (part && !part.includes("://")) addHost(part.replace(/^\./, ""), "proxy-host");
      }
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      try { addHost(new URL(value).hostname, "registry-host"); } catch { /* Not a URL. */ }
    }
  }
  for (const value of config.privacy.extraSensitiveLiterals) add(value, "user-defined");
  return [...literals.values()];
}
