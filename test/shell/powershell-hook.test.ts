import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readShellDumps } from "../../src/history/shell-dumps.ts";
import { detectEnvironment } from "../../src/profile/environment.ts";
import { renderInit } from "../../src/shell/init.ts";
import { withTempHome } from "../helpers/env.ts";

const engines = ["pwsh", "powershell"].map(name => ({ name, binary: Bun.which(name) }));

for (const { name, binary } of engines) describe(`${name} native shell integration`, () => {
  test.skipIf(!binary)("retains the prompt and exit code, captures PSReadLine, reloads changes, and notifies once", () => withTempHome(home => {
    const root = join(process.env.GRASSHOPPER_HOME!, "grasshopper's été");
    process.env.GRASSHOPPER_HOME = root;
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(root, "managed"));
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const init = join(root, "init.ps1");
    const history = join(home, "custom PSReadLine.txt");
    writeFileSync(init, "\uFEFF" + renderInit("powershell", root));
    writeFileSync(join(root, "managed", "powershell.ps1"), "\uFEFF$env:GHOP_MANAGED_LOADED = 'yes'\n");
    writeFileSync(join(root, "reload.powershell.ps1"), "\uFEFF$env:GHOP_RELOADED = 'yes'\n");
    writeFileSync(join(root, "fresh.flag"), "2");
    writeFileSync(join(bin, "ghop.ps1"), `
[IO.File]::AppendAllText((Join-Path $env:GHOP_FIXTURE_ROOT 'calls.log'), ($args -join '|') + [Environment]::NewLine)
if ($args[0] -eq 'daily') { [IO.File]::WriteAllText((Join-Path $env:GHOP_FIXTURE_ROOT 'daily.stamp'), (Get-Date -Format 'yyyy-MM-dd')) }
if ($args[0] -eq 'notify') { Remove-Item -LiteralPath (Join-Path $env:GHOP_FIXTURE_ROOT 'fresh.flag') -Force }
if ($args[0] -eq 'fail') { $global:LASTEXITCODE = 7 } else { $global:LASTEXITCODE = 0 }
`);
    const script = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
Import-Module PSReadLine
Set-PSReadLineOption -HistorySavePath ${quote(history)} -EditMode Windows
function global:prompt { "prior:$global:LASTEXITCODE> " }
. ${quote(init)}
. ${quote(init)}
Set-Alias -Name zqx -Value Get-ChildItem
function zqfunc { 'useful' }
$global:LASTEXITCODE = 23
$priorPrompt = prompt
$promptCode = $global:LASTEXITCODE
__ghop_precmd
$capturedHistory = $env:GHOP_HISTFILE
ghop fail 'two words'
$wrapperCode = $global:LASTEXITCODE
@{ prompt = $priorPrompt; promptCode = $promptCode; wrapperCode = $wrapperCode; history = $capturedHistory; managed = $env:GHOP_MANAGED_LOADED; reload = $env:GHOP_RELOADED; shell = $env:GHOP_SHELL } | ConvertTo-Json -Compress
exit 0
`;
    const result = Bun.spawnSync([binary!, "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      env: { ...process.env, PATH: bin + (process.platform === "win32" ? ";" : ":") + process.env.PATH, CI: "", GHOP_DISABLE: "", TERM: "xterm-256color", GHOP_FIXTURE_ROOT: root },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000,
    });
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout).trim())).toEqual({
      prompt: "prior:23> ", promptCode: 23, wrapperCode: 7, history, managed: "yes", reload: "yes", shell: "powershell",
    });
    expect(readFileSync(join(root, "calls.log"), "utf8").trim().split(/\r?\n/)).toEqual(["daily", "notify", "fail|two words"]);
    expect(existsSync(join(root, "reload.powershell.ps1"))).toBe(false);
    expect(existsSync(join(root, "fresh.flag"))).toBe(false);
    const dumps = readShellDumps("powershell");
    expect(dumps.aliases).toContainEqual({ name: "zqx", expansion: "Get-ChildItem" });
    expect(dumps.functions).toContain("zqfunc");
    const env = detectEnvironment("powershell", dumps, () => null);
    expect(env.shellVersion).toMatch(/^\d+\.\d+$/);
    expect(env.keymap).toBe("windows");
    expect(env.history).toMatchObject({ ignoreSpace: null, fileLimit: null, appendIncremental: true, shared: true });
  }), 30000);

  test.skipIf(!binary)("does not integrate into noninteractive or disabled sessions", () => withTempHome(home => {
    const init = join(home, "init.ps1");
    writeFileSync(init, "\uFEFF" + renderInit("powershell", process.env.GRASSHOPPER_HOME!));
    for (const disabled of [false, true]) {
      const script = `$ProgressPreference = 'SilentlyContinue'; . '${init.replaceAll("'", "''")}'; if (Get-Variable __ghop_home -Scope Global -ErrorAction SilentlyContinue) { exit 9 }; exit 0`;
      const result = Bun.spawnSync([binary!, "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", disabled ? "-NoExit" : "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
        env: { ...process.env, CI: "", TERM: "xterm-256color", GHOP_DISABLE: disabled ? "1" : "" },
        stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000,
      });
      expect(new TextDecoder().decode(result.stderr)).toBe("");
      expect(result.exitCode).toBe(0);
    }
  }), 30000);
});
