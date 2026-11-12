import { expect, test } from "bun:test";
import { setConfigValue } from "../../src/core/config.ts";
import type { HistoryEntry } from "../../src/history/parse.ts";
import { normalizeEntry } from "../../src/privacy/normalize.ts";
import { assignPseudonyms, renderTemplate } from "../../src/privacy/pseudonyms.ts";
import { withTempHome } from "../helpers/env.ts";

const context = { aliases: new Set<string>(), functions: new Set<string>() };
const entry = (text: string, seq = 0): HistoryEntry => ({ text, seq, ts: null, durationSec: null });
function template(text: string, count = 1, ctx = context): string {
  const entries = Array.from({ length: count }, (_, i) => normalizeEntry(entry(text, i), ctx));
  return renderTemplate(entries[0]!, assignPseudonyms(entries, ctx.aliases, 3));
}
const cases: [string, string, number?][] = [
  ['git commit -m "fix login bug"', "git commit -m <str>"],
  ["cd ~/Projects/acme", "cd <path#1>", 3],
  ["ssh deploy@build-07.acme.internal", "ssh <host>"],
  ["kubectl get pods -n payments", "kubectl get pods -n <arg#1>", 3],
  ["FOO=bar npm run dev", "<var>=<val> npm run dev"],
  ["NODE_ENV=production node server.js", "NODE_ENV=<val> node <path>"],
  ["acmectl deploy --cluster prod", "<cmd#1> <arg#1> <flag> <arg#2>", 3],
  ["docker compose up -d", "docker compose up -d"],
  ["npx create-next-app my-app", "npx create-next-app <arg>"],
  ["git push --force origin feature/ACME-123", "git push --force origin <ref>"],
  ['grep -rn "TODO" src/', "grep -rn <arg> <path>"],
  ["python -m http.server 8000", "python -m http.server <num>"],
  ["curl -s https://api.github.com/x |jq .name", "curl -s <url> | jq <arg>"],
  ["sudo apt install ripgrep", "sudo apt install <pkg>"],
  ['git log --grep "fix bug" -n 20', "git log --grep <str> -n <num>"],
  ["git checkout -- src/app.ts", "git checkout -- <path>"],
  ["scp ./a.tgz me@10.1.2.3:/srv/", "scp <path> <host>"],
  ["ssh -i ~/.ssh/id_x box1", "ssh -i <path> <host>"],
  ["cd -", "cd -"],
];
for (const [input, expected, count] of cases) {
  test(`normalizes ${input}`, () => withTempHome(() => {
    expect(template(input, count)).toBe(expected);
  }));
}

test("wrappers count separately without duplicating rendered tokens", () => withTempHome(() => {
  const norm = normalizeEntry(entry("sudo env NODE_ENV=production apt install ripgrep | cat"), context);
  expect(norm.commands.map(c => c.cmdKey)).toEqual(["sudo", "env", "apt", "cat"]);
  expect(norm.commands.map(c => c.subKey)).toEqual([null, null, "apt install", null]);
  expect(norm.ops).toEqual(["", "", "|", ""]);
  expect(renderTemplate(norm, {})).toBe("sudo env NODE_ENV=<val> apt install <pkg> | cat");
}));

test("normalizes command identities before lookup and honors alias precedence", () => withTempHome(() => {
  expect(template("GIT.EXE status")).toBe("git status");
  expect(template("./private-script.sh private-argument")).toBe("<path> <arg>");
  const ctx = { aliases: new Set(["git", "shortcut"]), functions: new Set(["git", "myfunction"]) };
  expect(template("git status", 1, ctx)).toBe("<alias#1> <arg>");
  expect(template("myfunction private-argument", 1, ctx)).toBe("<fn#1> <arg>");
}));

test("allowWords admits only explicitly configured command and argument words", () => withTempHome(() => {
  setConfigValue("privacy.allowWords", '["publicctl","public-mode"]');
  expect(template("publicctl --help --unknown public-mode private-mode")).toBe("publicctl --help <flag> public-mode <arg>");
}));

test("flags never reveal custom names or attached values", () => withTempHome(() => {
  expect(template("git --branch=private-topic --private-flag=value -abcd -abcde")).toBe("git --branch=<val> <flag> -abcd <flag>");
  expect(template("privatectl --help -x --branch=private-topic")).toBe("<cmd> <flag>");
}));

test("message arguments are swallowed without advancing positional context", () => withTempHome(() => {
  expect(template("git commit -m private-message -m second-message --amend")).toBe("git commit -m <str> -m <str> --amend");
  expect(template("git tag --message private-message private-tag")).toBe("git tag --message <str> <ref>");
}));

test("expansions and assignment values cannot leak", () => withTempHome(() => {
  expect(template('PRIVATE=hidden NODE_ENV=$(privatecmd) echo "$PRIVATE" ${PRIVATE} `privatecmd` <(privatecmd)')).toBe("<var>=<val> NODE_ENV=<val> echo <subshell>");
  expect(template("$(privatecmd) private-value")).toBe("<subshell> <arg>");
  expect(template('echo "private words" 123 -42 1.5M')).toBe("echo <str> <num>");
}));

test("context-specific scripts, modules, targets and packages are constrained", () => withTempHome(() => {
  const extra: [string, string][] = [
    ["npm run private-script", "npm run <script>"],
    ["pnpm private-script", "pnpm <script>"],
    ["yarn dev", "yarn dev"],
    ["make clean private-target", "make clean <arg>"],
    ["python -m private_module", "python -m <arg>"],
    ["pnpm dlx private-package", "pnpm dlx <pkg>"],
    ["npm install private-package", "npm install <pkg>"],
    ["dotnet add package Private.Package", "dotnet add package <pkg>"],
    ["pacman private-package", "pacman <pkg>"],
    ["git checkout -- private-file.js", "git checkout -- <path>"],
  ];
  for (const [input, expected] of extra) expect(template(input), input).toBe(expected);
}));

test("redirects retain operators and hide targets including heredoc delimiters", () => withTempHome(() => {
  expect(template("cat private.txt > private-output.txt 2>&1")).toBe("cat <path> > <path> 2>&1");
  expect(template("cat << PRIVATE_DELIMITER\nprivate body\nPRIVATE_DELIMITER\nprivatecmd")).toBe("cat << <path>");
  expect(template("(git status) && git diff")).toBe("( git status ) && git diff");
}));

test("host and path literal values are canonicalized locally", () => withTempHome(() => {
  const norm = normalizeEntry(entry("scp ./private-dir/ USER@PRIVATE.EXAMPLE:remote/path"), context);
  const literals = norm.commands.flatMap(c => c.tokens.flatMap(t => t.literal ? [t.literal] : []));
  expect(literals).toEqual([{ type: "path", value: "./private-dir" }, { type: "host", value: "private.example" }]);
  expect(template("cd /")).toBe("cd /");
  expect(template("echo private-host.internal 192.0.2.2 private.txt '*.private'")).toBe("echo <host> <path> <glob>");
}));

test("PowerShell templates preserve cmdlets and parameters while hiding quoted Windows paths", () => withTempHome(() => {
  const ctx = { ...context, shell: "powershell" as const };
  const norm = normalizeEntry(entry("Get-ChildItem -LiteralPath 'C:\\Jane''s Files\\private.txt' -Recurse"), ctx);
  expect(renderTemplate(norm, {})).toBe("get-childitem -literalpath <path> -recurse");
  expect(norm.commands[0]?.tokens.find(token => token.literal?.type === "path")?.literal?.value).toBe("C:\\Jane's Files\\private.txt");
  expect(template("Get-Item \\\\private-server\\share\\file.txt", 1, ctx)).toBe("get-item <path>");
  expect(template("git add -A", 1, ctx)).toBe("git add -A");
  expect(template("Get-ChildItem -Force:$false -Filter:private*", 1, ctx)).toBe("get-childitem -force=<val> -filter=<val>");
  expect(template("Write-Output '-AbCd'", 1, ctx)).toBe("write-output <str>");
}));

test("PowerShell normalizes aliases case-insensitively and keeps expression data opaque", () => withTempHome(() => {
  const ctx = { aliases: new Set(["PrivateListing"]), functions: new Set<string>(), shell: "powershell" as const };
  expect(template("PRIVATELISTING C:\\private", 1, ctx)).toBe("<alias#1> <path>");
  const norm = normalizeEntry(entry('Write-Output @{ private = \'literal\'; nested = $(Get-Item C:\\private) }; Get-Process |\n Select-Object -First 2'), ctx);
  const rendered = renderTemplate(norm, {});
  expect(rendered).toBe("write-output <subshell> ; get-process | select-object -first <num>");
  expect(rendered).not.toContain("private");
  expect(template("Write-Output @'\nprivate | string\n'@", 1, ctx)).toBe("write-output <str>");
}));
