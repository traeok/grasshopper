import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initFile, toShellPath } from "../../src/core/paths.ts";
import { bashProfileNeedsSourcing, installBashProfileSourcing, installRcBlock, rcPathFor, renderRcBlock } from "../../src/shell/rc.ts";
import { withTempHome } from "../helpers/env.ts";

describe("rc integration", () => {
  test("creates a missing rc and installs one idempotent block with distinct backups", () => withTempHome((home) => {
    const rc = join(home, ".bashrc");
    expect(rcPathFor("bash")).toBe(rc);
    installRcBlock("bash");
    const content = readFileSync(rc, "utf8");
    expect(content).toBe(renderRcBlock("bash"));
    expect(content).toContain(toShellPath(initFile("bash"), "bash"));
    expect(readdirSync(home).filter((name) => name.includes("ghop-backup"))).toHaveLength(0);
    installRcBlock("bash");
    installRcBlock("bash");
    expect(readFileSync(rc, "utf8")).toBe(content);
    const backups = readdirSync(home).filter((name) => /^\.bashrc\.ghop-backup-\d{14}$/.test(name));
    expect(backups).toHaveLength(2);
    for (const name of backups) expect(readFileSync(join(home, name), "utf8")).toBe(content);
  }));

  test("backs up exact original bytes and keeps foreign content around a replaced block", () => withTempHome((home) => {
    const rc = rcPathFor("bash");
    const original = "# before\r\n# >>> grasshopper >>>\r\nold init\r\n# <<< grasshopper <<<\r\n# after\r\n";
    writeFileSync(rc, original);
    installRcBlock("bash");
    expect(readFileSync(rc, "utf8")).toBe(`# before\r\n${renderRcBlock("bash")}# after\r\n`);
    const backup = readdirSync(home).find((name) => name.startsWith(".bashrc.ghop-backup-"))!;
    expect(readFileSync(join(home, backup), "utf8")).toBe(original);
  }));

  test("appends a newline and honors normalized ZDOTDIR with quoted init paths", () => withTempHome((home) => {
    const directory = join(home, "zsh config");
    mkdirSync(directory);
    process.env.ZDOTDIR = directory.replaceAll("\\", "/");
    process.env.GRASSHOPPER_HOME = join(home, "hopper's files");
    const rc = join(directory, ".zshrc");
    expect(rcPathFor("zsh")).toBe(rc);
    writeFileSync(rc, "# keep");
    installRcBlock("zsh");
    expect(readFileSync(rc, "utf8")).toBe(`# keep\n${renderRcBlock("zsh")}`);
    expect(renderRcBlock("zsh")).toContain("hopper'\\''s files");
  }));

  test("detects and fixes bash profile sourcing without changing already-sourcing files", () => withTempHome((home) => {
    const profile = join(home, ".bash_profile");
    expect(bashProfileNeedsSourcing()).toBe(false);
    installBashProfileSourcing();
    expect(existsSync(profile)).toBe(false);
    writeFileSync(profile, "export EDITOR=vim");
    expect(bashProfileNeedsSourcing()).toBe(true);
    installBashProfileSourcing();
    expect(readFileSync(profile, "utf8")).toBe("export EDITOR=vim\ntest -f ~/.bashrc && . ~/.bashrc\n");
    expect(bashProfileNeedsSourcing()).toBe(false);
    const backups = readdirSync(home).filter((name) => name.startsWith(".bash_profile.ghop-backup-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(home, backups[0]!), "utf8")).toBe("export EDITOR=vim");
    installBashProfileSourcing();
    expect(readdirSync(home).filter((name) => name.startsWith(".bash_profile.ghop-backup-"))).toHaveLength(1);
  }));

  test("PowerShell profiles retain foreign content, quote native paths and replace one BOM-prefixed block", () => withTempHome(home => {
    const rc = process.env.GHOP_POWERSHELL_PROFILE!;
    mkdirSync(join(home, "PowerShell"));
    process.env.GRASSHOPPER_HOME = join(home, "hopper's files");
    writeFileSync(rc, "\uFEFF# keep\r\n");
    expect(rcPathFor("powershell")).toBe(rc);
    installRcBlock("powershell");
    installRcBlock("powershell");
    const content = readFileSync(rc, "utf8");
    expect(content).toBe(`\uFEFF# keep\r\n${renderRcBlock("powershell")}`);
    expect(content).toContain("hopper''s files");
    const backups = readdirSync(join(home, "PowerShell")).filter(name => name.includes(".ghop-backup-"));
    expect(backups.map(name => readFileSync(join(home, "PowerShell", name), "utf8"))).toContain("\uFEFF# keep\r\n");
  }));

  test("PowerShell setup preserves UTF-16 profile content and backs up its original bytes", () => withTempHome(home => {
    const rc = process.env.GHOP_POWERSHELL_PROFILE!;
    mkdirSync(join(home, "PowerShell"));
    const bytes = Buffer.from("\uFEFF# été\r\n$global:kept = 'é'\r\n", "utf16le");
    writeFileSync(rc, bytes);
    installRcBlock("powershell");
    expect(readFileSync(rc, "utf8")).toBe(`\uFEFF# été\r\n$global:kept = 'é'\r\n${renderRcBlock("powershell")}`);
    const backup = readdirSync(join(home, "PowerShell")).find(name => name.includes(".ghop-backup-"))!;
    expect(readFileSync(join(home, "PowerShell", backup))).toEqual(bytes);
  }));
});
