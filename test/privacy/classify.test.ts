import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { setConfigValue } from "../../src/core/config.ts";
import { classifyEntry } from "../../src/privacy/classify.ts";
import type { Classification } from "../../src/privacy/classify.ts";
import { withTempHome } from "../helpers/env.ts";

const ctx = { knownWords: (word: string) => ["git", "cd", "npm", "docker", "Mixed9Alias", "Mixed9Function"].includes(word) };
const corpusExpected: Classification[] = [
  { drop: "secret", secretRule: "github-token" },
  { drop: "secret", secretRule: "openai-key" },
  { drop: "secret", secretRule: "npm-token" },
  { drop: "registry-config" },
  { drop: "secret", secretRule: "login-password" },
  { drop: "secret", secretRule: "inline-db-password" },
  { drop: "secret", secretRule: "url-credentials" },
  { drop: "secret", secretRule: "gitlab-token" },
  { drop: null },
  { drop: null },
  { drop: "secret", secretRule: "aws-secret-key" },
  { drop: "secret", secretRule: "aws-access-key" },
  { drop: "credential-command" },
  { drop: "credential-command" },
  { drop: "secret", secretRule: "jwt" },
  { drop: "secret", secretRule: "curl-user" },
  { drop: "registry-config" },
  { drop: null },
  { drop: null },
  { drop: null },
  { drop: null },
  { drop: "leading-space" },
  { drop: "secret", secretRule: "sshpass-password" },
  { drop: "secret", secretRule: "netrc-line" },
  { drop: "secret", secretRule: "openssl-pass" },
  { drop: "possible-password" },
  { drop: null },
  { drop: null },
  { drop: null },
  { drop: "secret", secretRule: "auth-header" },
  { drop: "secret", secretRule: "slack-webhook" },
  { drop: null },
  { drop: null },
];

test("leak corpus matches every ordered category and secret rule", () => withTempHome(() => {
  const corpus = readFileSync(new URL("../fixtures/history/leak-corpus.txt", import.meta.url), "utf8")
    .replace(/\r/g, "").replace(/\n$/, "").split("\n");
  expect(corpus).toHaveLength(33);
  const counts: Record<string, number> = {};
  for (const [index, text] of corpus.entries()) {
    const result = classifyEntry(text, ctx);
    expect(result, `corpus line ${index + 1}`).toEqual(corpusExpected[index]!);
    const key = result.drop ?? "kept";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  expect(counts).toEqual({ kept: 11, secret: 16, "credential-command": 2, "registry-config": 2, "possible-password": 1, "leading-space": 1 });
}));

test("ordinary commands and git hashes are kept", () => withTempHome(() => {
  for (const text of [
    "git status", "cd ..", "npm run dev", "git log --oneline -n 20", "docker compose up -d",
    "git show 3f2a9c1e5b7d4a6f8e0c2b4d6f8a0c2e4b6d8f0a",
    "Mixed9Alias", "Mixed9Function", "", "wordonly", "Abcde", "abc123",
  ]) expect(classifyEntry(text, ctx)).toEqual({ drop: null });
}));

test("variable references are credential commands rather than inline secrets", () => withTempHome(() => {
  for (const text of [
    'curl -H "Authorization: token $GITHUB_TOKEN" https://api.github.com/user',
    "export GH_TOKEN=$(gh auth token)",
    "docker login -u me -p $REGISTRY_PASS reg.example.com",
    'curl -H "Authorization: Bearer ${GITHUB_TOKEN}" https://api.github.com/user',
    "export GH_TOKEN='$GH_TOKEN'",
  ]) expect(classifyEntry(text, ctx)).toEqual({ drop: "credential-command" });
  // A compound value is not solely a variable reference under the specified rule.
  expect(classifyEntry("curl -u '$API_USER:$API_PASS' https://api.github.com/user", ctx))
    .toEqual({ drop: "secret", secretRule: "curl-user" });
}));

test("first-command credential checks unwrap commands and shell suffixes", () => withTempHome(() => {
  for (const text of [
    "passwd", "ssh-add ~/.ssh/id_ed25519", "op item list", "sudo -n env CI=1 command AWS.EXE sts assume-role-with-web-identity",
    "sudo -u root gpg --list-keys", "doas -- git credential-manager get", "gsudo winpty nohup gh auth status",
    "time --format '%E' aws ssm get-parameters-by-path", "env -u DEBUG vault status",
    "git config --global credential.helper store", "git config url.ssh://example.com/.insteadOf https://example.com/",
    "gh one two three login", "az login", "kubectl config set-credentials admin",
  ]) expect(classifyEntry(text, ctx)).toEqual({ drop: "credential-command" });
  expect(classifyEntry("echo one two three four login", ctx)).toEqual({ drop: null });
  expect(classifyEntry("echo ok; passwd", ctx)).toEqual({ drop: null });
}));

test("registry configuration and URL-valued registry flags are dropped", () => withTempHome(() => {
  for (const text of [
    "npm config set registry https://packages.example.com/", "yarn set registry https://packages.example.com/",
    "dotnet nuget add source https://packages.example.com/", "nuget sources add -source https://packages.example.com/",
    "pip config set global.trusted-host packages.example.com", "npm install --registry https://packages.example.com/",
    "pip install --index-url=https://packages.example.com/simple package", "pip install --extra-index-url https://packages.example.com/simple package",
    "pip install -i https://packages.example.com/simple package", "echo ok && npm install --registry https://packages.example.com/",
  ]) expect(classifyEntry(text, ctx)).toEqual({ drop: "registry-config" });
  expect(classifyEntry("ssh -i ~/.ssh/id_ed25519 server", ctx)).toEqual({ drop: null });
  expect(classifyEntry("npm config get registry", ctx)).toEqual({ drop: null });
}));

test("priority is size, leading space, user rule, secret, then command checks", () => withTempHome(() => {
  setConfigValue("privacy.extraDropPatterns", JSON.stringify(["never-send", "ghp_"]));
  expect(classifyEntry(" " + "x".repeat(1000), ctx)).toEqual({ drop: "oversized" });
  expect(classifyEntry(Array(16).fill("echo ok").join("\n"), ctx)).toEqual({ drop: "oversized" });
  expect(classifyEntry("echo " + "x".repeat(995), ctx)).toEqual({ drop: null });
  expect(classifyEntry(Array(15).fill("echo ok").join("\n"), ctx)).toEqual({ drop: null });
  expect(classifyEntry(" NEVER-SEND", ctx)).toEqual({ drop: "leading-space" });
  expect(classifyEntry("\tgit status", ctx)).toEqual({ drop: "leading-space" });
  expect(classifyEntry("echo NEVER-SEND", ctx)).toEqual({ drop: "user-rule" });
  expect(classifyEntry("export GH_TOKEN=ghp_Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LzXcVb", ctx)).toEqual({ drop: "user-rule" });
  expect(classifyEntry("op item get AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", ctx)).toEqual({ drop: "secret", secretRule: "high-entropy" });
}));

test("unknown single mixed-class words are possible passwords", () => withTempHome(() => {
  expect(classifyEntry("Abc123", ctx)).toEqual({ drop: "possible-password" });
  expect(classifyEntry("abc12!", ctx)).toEqual({ drop: "possible-password" });
  expect(classifyEntry("Mixed9Alias", { knownWords: () => false })).toEqual({ drop: "possible-password" });
  expect(classifyEntry("echo Abc123", ctx)).toEqual({ drop: null });
}));

test("PowerShell credentials, scoped environment secrets and REST headers fail closed", () => withTempHome(() => {
  const ps = { knownWords: (word: string) => ["get-childitem", "get-process"].includes(word), shell: "powershell" as const };
  for (const text of [
    "$env:TOKEN = 'private-value'",
    "${env:PASSWORD}='private-value'",
    "Set-Item env:API_TOKEN 'private-value'",
    "Set-Variable -Name Password -Value 'private-value'",
    "Write-Output ok; Get-Credential",
    "ConvertTo-SecureString 'private-value' -AsPlainText -Force",
    "Invoke-RestMethod -Uri 'https://private.example' -Headers @{ Authorization = 'Basic private-value' }",
    "Invoke-RestMethod -Hea`ders $privateHeaders",
    "$credential = [pscredential]::new('private-user', $secure)",
  ]) expect(classifyEntry(text, ps).drop).not.toBeNull();
  expect(classifyEntry("Get-ChildItem", ps)).toEqual({ drop: null });
  expect(classifyEntry("Get-ChildItem C:\\private\\file.txt", ps)).toEqual({ drop: null });
  expect(classifyEntry("Get-Process | Select-Object -First 5", ps)).toEqual({ drop: null });
}));
