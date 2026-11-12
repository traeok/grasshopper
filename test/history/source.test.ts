import { expect, test } from "bun:test";
import { join } from "node:path";
import { withTempHome } from "../helpers/env.ts";
import { defaultHistoryFile, detectShell, resolveSource } from "../../src/history/source.ts";
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
