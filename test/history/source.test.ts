import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempHome } from "../helpers/env.ts";
import { defaultAtuinFile, defaultHistoryFile, detectShell, resolveSource } from "../../src/history/source.ts";
import { setConfigValue } from "../../src/core/config.ts";
import { getMeta, setMeta } from "../../src/core/state.ts";

test("history flags override env, configuration, and remembered source", async () => {
  await withTempHome(home => {
    setMeta("lastSource", { shell: "zsh", file: join(home, "old") });
    setConfigValue("history.shell", "bash");
    setConfigValue("history.file", join(home, "configured"));
    process.env.GHOP_SHELL = "zsh";
    process.env.GHOP_HISTFILE = join(home, "environment");
    const source = resolveSource({ shell: "bash", histfile: join(home, "flag") });
    expect(source).toEqual({ shell: "bash", file: join(home, "flag") });
    expect(getMeta("lastSource")).toEqual(source);
  });
});
test("known shell supplies default history file without existence requirement", async () => {
  await withTempHome(home => {
    expect(resolveSource({ shell: "bash", persist: false })).toEqual({ shell: "bash", file: join(home, ".bash_history") });
    expect(getMeta("lastSource")).toBeNull();
  });
});

test("PowerShell uses PSReadLine history and respects captured custom paths", () => withTempHome(home => {
  const expected = process.platform === "win32"
    ? join(process.env.APPDATA!, "Microsoft", "Windows", "PowerShell", "PSReadLine", "ConsoleHost_history.txt")
    : join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "powershell", "PSReadLine", "ConsoleHost_history.txt");
  expect(defaultHistoryFile("powershell")).toBe(expected);
  expect(resolveSource({ shell: "powershell" })).toEqual({ shell: "powershell", file: expected });
  expect(getMeta("lastSource")).toEqual({ shell: "powershell", file: expected });
  process.env.GHOP_SHELL = "powershell";
  process.env.GHOP_HISTFILE = join(home, "custom PSReadLine.txt");
  expect(detectShell()).toBe("powershell");
  expect(resolveSource()).toEqual({ shell: "powershell", file: process.env.GHOP_HISTFILE! });
}));

test("auto detects Atuin at the XDG location while retaining the shell dialect", () => withTempHome(home => {
  process.env.XDG_DATA_HOME = join(home, "xdg");
  mkdirSync(join(process.env.XDG_DATA_HOME, "atuin"), { recursive: true });
  const file = join(process.env.XDG_DATA_HOME, "atuin", "history.db");
  writeFileSync(file, "");
  expect(defaultAtuinFile()).toBe(file);
  expect(resolveSource({ shell: "zsh", persist: false })).toEqual({ shell: "zsh", file, kind: "atuin" });
  expect(getMeta("lastSource")).toBeNull();
  expect(resolveSource({ shell: "zsh", source: "shell", persist: false })).toEqual({ shell: "zsh", file: defaultHistoryFile("zsh") });
}));

test("custom shell history paths override automatic Atuin detection", () => withTempHome(home => {
  process.env.ATUIN_DB_PATH = join(home, "atuin.db");
  writeFileSync(process.env.ATUIN_DB_PATH, "");
  process.env.GHOP_SHELL = "bash";
  process.env.GHOP_HISTFILE = join(home, "captured");
  expect(resolveSource({ persist: false })).toEqual({ shell: "bash", file: process.env.ATUIN_DB_PATH!, kind: "atuin" });
  expect(resolveSource({ source: "shell", persist: false })).toEqual({ shell: "bash", file: join(home, "captured") });
  delete process.env.GHOP_SHELL;
  expect(resolveSource({ shell: "bash", persist: false })).toEqual({ shell: "bash", file: join(home, "captured") });
  process.env.GHOP_SHELL = "bash";
  delete process.env.GHOP_HISTFILE;
  setConfigValue("history.file", join(home, "configured"));
  expect(resolveSource({ persist: false })).toEqual({ shell: "bash", file: join(home, "configured") });
  expect(resolveSource({ histfile: join(home, "flag"), persist: false })).toEqual({ shell: "bash", file: join(home, "flag") });
}));

test("explicit Atuin ignores captured shell paths and uses its own path precedence", () => withTempHome(home => {
  process.env.GHOP_SHELL = "bash";
  process.env.GHOP_HISTFILE = join(home, "shell-history");
  process.env.ATUIN_DB_PATH = join(home, "atuin.db");
  setConfigValue("history.source", "shell");
  setConfigValue("history.file", join(home, "configured-shell"));
  expect(resolveSource({ source: "atuin", persist: false })).toEqual({ shell: "bash", file: process.env.ATUIN_DB_PATH!, kind: "atuin" });
  const source = resolveSource({ source: "atuin", histfile: join(home, "chosen.db") });
  expect(source).toEqual({ shell: "bash", file: join(home, "chosen.db"), kind: "atuin" });
  expect(getMeta("lastSource")).toEqual(source);
  delete process.env.GHOP_HISTFILE;
  setConfigValue("history.source", "atuin");
  setConfigValue("history.file", join(home, "configured.db"));
  expect(resolveSource({ source: "shell", persist: false })).toEqual({ shell: "bash", file: defaultHistoryFile("bash") });
}));

test("remembered Atuin sources round-trip without leaking into shell selection", () => withTempHome(home => {
  const atuin = { shell: "zsh" as const, file: join(home, "remembered.db"), kind: "atuin" as const };
  setMeta("lastSource", atuin);
  expect(resolveSource({ persist: false })).toEqual(atuin);
  expect(resolveSource({ source: "shell" })).toEqual({ shell: "zsh", file: defaultHistoryFile("zsh") });
  expect(getMeta("lastSource")).toEqual({ shell: "zsh", file: defaultHistoryFile("zsh") });
  expect(() => resolveSource({ source: "invalid" })).toThrow("Source must be shell or atuin");
}));

test("Atuin defaults to the standard home data path and configured mode overrides detection", () => withTempHome(home => {
  delete process.env.XDG_DATA_HOME;
  expect(defaultAtuinFile()).toBe(join(home, ".local", "share", "atuin", "history.db"));
  setConfigValue("history.source", "atuin");
  setConfigValue("history.file", join(home, "configured.db"));
  expect(resolveSource({ shell: "bash", persist: false })).toEqual({ shell: "bash", file: join(home, "configured.db"), kind: "atuin" });
  expect(resolveSource({ source: "atuin", shell: "bash", histfile: join(home, "override.db"), persist: false }).file).toBe(join(home, "override.db"));
}));
