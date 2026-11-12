import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDir } from "../core/fsx.ts";
import { managedFile, toNativePath, toShellPath } from "../core/paths.ts";
import type { Shell } from "../history/source.ts";
import { powerShellBinary } from "../shell/powershell.ts";
import { tokenize } from "../history/tokenize.ts";

export function findShellBinary(shell: Shell): string | null {
  if (shell === "powershell") return powerShellBinary();
  if (shell !== "bash" || process.platform !== "win32") return Bun.which(shell);
  const git = Bun.which("git");
  const candidates = [
    process.env.GHOP_BASH ? toNativePath(process.env.GHOP_BASH) : null,
    git ? join(dirname(dirname(git)), "bin", "bash.exe") : null,
    "C:\\Program Files\\Git\\bin\\bash.exe",
  ];
  for (const candidate of candidates) {
    if (candidate && !/[\\/](?:Windows[\\/]System32|WindowsApps)[\\/]/i.test(candidate) && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function renderAlias(shell: Shell, name: string, command: string): string[] {
  if (shell !== "powershell") return [`alias ${name}='${command.replaceAll("'", "'\\''")}'`];
  const first = tokenize(command, shell)[0];
  const invocation = first?.kind === "word" && first.quoted ? `& ${command}` : command;
  return [
    `Remove-Item -LiteralPath 'Alias:${name}' -ErrorAction SilentlyContinue`,
    `function global:${name} { ${invocation} @args }`,
  ];
}

export function syntaxCheck(shell: Shell, content: string): { ok: boolean; stderr: string; skipped?: boolean } {
  const binary = findShellBinary(shell);
  if (!binary) return { ok: true, stderr: "", skipped: true };
  const directory = dirname(managedFile(shell));
  ensureDir(directory);
  const file = join(directory, `.check.${shell}.${process.pid}.${crypto.randomUUID()}.${shell === "powershell" ? "ps1" : "sh"}`);
  try {
    writeFileSync(file, (shell === "powershell" && !content.startsWith("\uFEFF") ? "\uFEFF" : "") + content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const parser = [
      "$tokens = $null; $errors = $null",
      `[void][System.Management.Automation.Language.Parser]::ParseFile('${file.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors)`,
      "if ($errors.Count) { foreach ($error in $errors) { [Console]::Error.WriteLine($error.ToString()) }; exit 1 }",
    ].join("\n");
    const argv = shell === "powershell"
      ? [binary, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(parser, "utf16le").toString("base64")]
      : [binary, "-n", toShellPath(file, shell)];
    const result = Bun.spawnSync(argv, {
      stdin: "ignore", stdout: "ignore", stderr: "pipe", env: process.env,
    });
    return { ok: result.exitCode === 0, stderr: new TextDecoder().decode(result.stderr).trimEnd() };
  } finally {
    try {
      unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Static definitions only; strings, comments and expression bodies stay opaque. */
export function powerShellNames(content: string): { aliasNames: string[]; functionNames: string[] } {
  const aliases = new Set<string>();
  const functions = new Set<string>();
  const validName = /^[A-Za-z_][A-Za-z0-9_-]*$/;
  const tokens = tokenize(content.replace(/^\uFEFF/, ""), "powershell");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "word" || token.quoted || token.expansion) continue;
    const previous = tokens[i - 1];
    if (previous && previous.kind !== "op") continue;
    const keyword = token.value.toLowerCase();
    if (keyword === "function" || keyword === "filter") {
      const next = tokens[i + 1];
      const name = next?.kind === "word" ? next.value.replace(/^(?:global|script|local|private):/i, "") : "";
      if (validName.test(name)) functions.add(name);
    } else if (["set-alias", "new-alias", "sal", "nal"].includes(keyword)) {
      const args = [];
      for (const arg of tokens.slice(i + 1)) {
        if (arg.kind === "op") break;
        args.push(arg);
      }
      const named = args.findIndex(arg => arg.value.toLowerCase() === "-name");
      let name = named >= 0 ? args[named + 1] : undefined;
      if (named < 0) {
        for (let j = 0; j < args.length; j++) {
          const arg = args[j]!;
          if (!arg.quoted && arg.value.startsWith("-")) {
            if (!/^-(?:force|passthru|whatif|confirm)(?::.*)?$/i.test(arg.value) && !arg.value.includes(":")) j++;
          } else {
            name = arg;
            break;
          }
        }
      }
      if (name && !name.expansion && validName.test(name.value)) aliases.add(name.value);
    }
  }
  return { aliasNames: [...aliases], functionNames: [...functions] };
}
