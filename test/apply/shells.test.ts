import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findShellBinary, syntaxCheck } from "../../src/apply/shells.ts";
import { upsertBlock, writeReload } from "../../src/apply/managed.ts";
import { writeTextAtomic } from "../../src/core/fsx.ts";
import { managedFile, reloadFile } from "../../src/core/paths.ts";
import { withTempHome } from "../helpers/env.ts";

const bash = findShellBinary("bash");
const powershell = findShellBinary("powershell");

describe("shell binary and syntax checks", () => {
  test("resolves platform shell binaries", () => {
    if (process.platform !== "win32") {
      expect(findShellBinary("bash")).toBe(Bun.which("bash"));
    } else if (bash) {
      expect(bash).not.toMatch(/[\\/](?:Windows[\\/]System32|WindowsApps)[\\/]/i);
      expect(existsSync(bash)).toBe(true);
    }
    expect(findShellBinary("zsh")).toBe(Bun.which("zsh"));
  });

  test.skipIf(!bash)("checks valid and invalid bash without changing the managed file", () => withTempHome(() => {
    const original = "# untouched managed content\n";
    writeTextAtomic(managedFile("bash"), original);
    expect(syntaxCheck("bash", "alias gs='git status'\n")).toEqual({ ok: true, stderr: "" });
    const invalid = syntaxCheck("bash", "if then\n");
    expect(invalid.ok).toBe(false);
    expect(invalid.stderr.length).toBeGreaterThan(0);
    expect(readFileSync(managedFile("bash"), "utf8")).toBe(original);
    expect(readdirSync(dirname(managedFile("bash"))).filter((name) => name.startsWith(".check."))).toEqual([]);
  }));

  test.skipIf(!bash)("checks quote-heavy alias and reload paths with real bash", () => withTempHome(() => {
    process.env.GRASSHOPPER_HOME = join(process.env.GRASSHOPPER_HOME!, "quoted ' root");
    const command = `printf '%s\\n' 'a b' "$HOME"`;
    const quoted = command.replaceAll("'", "'\\''");
    upsertBlock("bash", { id: 12, key: "quoted-alias" }, [`alias quoted='${quoted}'`]);
    expect(syntaxCheck("bash", readFileSync(managedFile("bash"), "utf8")).ok).toBe(true);
    writeReload("bash", ["unalias quoted 2>/dev/null"]);
    expect(syntaxCheck("bash", readFileSync(reloadFile("bash"), "utf8")).ok).toBe(true);
    expect(readdirSync(dirname(managedFile("bash"))).filter((name) => name.startsWith(".check."))).toEqual([]);
  }));

  test.skipIf(Boolean(Bun.which("zsh")))("reports skipped checks without creating files when zsh is absent", () => withTempHome(() => {
    expect(syntaxCheck("zsh", "intentionally not shell syntax")).toEqual({ ok: true, stderr: "", skipped: true });
    expect(existsSync(dirname(managedFile("zsh")))).toBe(false);
  }));

  test.skipIf(!powershell)("PowerShell parses without executing commands and rejects errors without changing managed files", () => withTempHome(() => {
    const marker = join(dirname(managedFile("powershell")), "never-executed");
    const original = "\uFEFF# untouched\n";
    writeTextAtomic(managedFile("powershell"), original);
    const script = `[System.IO.File]::WriteAllText('${marker.replaceAll("'", "''")}', 'bad')\nfunction ghop_test { 'literal' }`;
    expect(syntaxCheck("powershell", script)).toEqual({ ok: true, stderr: "" });
    expect(existsSync(marker)).toBe(false);
    const invalid = syntaxCheck("powershell", "function missing {");
    expect(invalid.ok).toBe(false);
    expect(invalid.stderr.length).toBeGreaterThan(0);
    expect(readFileSync(managedFile("powershell"), "utf8")).toBe(original);
    expect(readdirSync(dirname(managedFile("powershell"))).filter(name => name.startsWith(".check."))).toEqual([]);
  }));
});
