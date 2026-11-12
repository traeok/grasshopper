import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../../src/core/db.ts";

const ENV_KEYS = ["HOME", "USERPROFILE", "GRASSHOPPER_HOME", "GHOP_SHELL", "GHOP_HISTFILE", "GHOP_POWERSHELL", "GHOP_POWERSHELL_PROFILE", "SHELL", "APPDATA", "GIT_CONFIG_GLOBAL", "XDG_CONFIG_HOME", "ZDOTDIR"] as const;

/** Isolate home-dependent fixtures; callbacks may be synchronous or asynchronous. */
export function withTempHome<T>(fn: (home: string) => T): T {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
    (typeof ENV_KEYS)[number], string | undefined
  >;
  const root = mkdtempSync(join(tmpdir(), "ghop-test-"));
  const home = join(root, "home");
  const data = join(root, "data");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(data, { recursive: true, mode: 0o700 });
  closeDb();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.GRASSHOPPER_HOME = data;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  process.env.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  delete process.env.ZDOTDIR;
  delete process.env.GHOP_SHELL;
  delete process.env.GHOP_HISTFILE;
  delete process.env.SHELL;
  delete process.env.GHOP_POWERSHELL;
  process.env.GHOP_POWERSHELL_PROFILE = join(home, "PowerShell", "profile.ps1");

  const cleanup = () => {
    try {
      closeDb();
    } finally {
      for (const key of ENV_KEYS) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  };

  let result: T;
  try {
    result = fn(home);
  } catch (error) {
    cleanup();
    throw error;
  }
  if (result instanceof Promise) return result.finally(cleanup) as T;
  cleanup();
  return result;
}
