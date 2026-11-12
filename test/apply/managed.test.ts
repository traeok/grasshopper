import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MANAGED_HEADER, removeBlock, renderManaged, upsertBlock, writeReload } from "../../src/apply/managed.ts";
import { localDate } from "../../src/core/dates.ts";
import { writeTextAtomic } from "../../src/core/fsx.ts";
import { managedFile, reloadFile, toShellPath } from "../../src/core/paths.ts";
import { withTempHome } from "../helpers/env.ts";

const rec = { id: 12, key: "alias-git-status" };

describe("managed shell blocks", () => {
  test("renders exact markers and header without writing", () => withTempHome(() => {
    const content = renderManaged("bash", rec, ["alias gs='git status'"]);
    expect(content).toBe(`${MANAGED_HEADER}\n# >>> ghop #12 alias-git-status (${localDate()}) >>>\nalias gs='git status'\n# <<< ghop #12 <<<\n`);
    expect(existsSync(managedFile("bash"))).toBe(false);
  }));

  test("upserts in place and removes only the requested block", () => withTempHome(() => {
    const before = "# user prefix\nexport EDITOR=vi\n";
    const between = "# user middle\nprintf 'foreign'\n";
    const after = "# user suffix without newline";
    writeTextAtomic(managedFile("bash"), before);
    upsertBlock("bash", rec, ["alias gs='git status'"]);
    writeTextAtomic(managedFile("bash"), readFileSync(managedFile("bash"), "utf8") + between);
    upsertBlock("bash", { id: 123, key: "other" }, ["alias gl='git log'"]);
    writeTextAtomic(managedFile("bash"), readFileSync(managedFile("bash"), "utf8") + after);
    upsertBlock("bash", rec, ["alias gst='git status'"]);
    const content = readFileSync(managedFile("bash"), "utf8");
    expect(content.split("# >>> ghop #12 ").length).toBe(2);
    expect(content).not.toContain("alias gs=");
    expect(content).toContain("alias gst='git status'");
    expect(content.indexOf("alias gst=")).toBeLessThan(content.indexOf(between));
    removeBlock("bash", rec.id);
    expect(readFileSync(managedFile("bash"), "utf8")).toBe(`${MANAGED_HEADER}\n${before}${between}# >>> ghop #123 other (${localDate()}) >>>\nalias gl='git log'\n# <<< ghop #123 <<<\n${after}`);
  }));

  test("missing removal does not create a managed file", () => withTempHome(() => {
    removeBlock("zsh", 12);
    expect(existsSync(managedFile("zsh"))).toBe(false);
  }));

  test("normalizes CRLF and isolates shell files", () => withTempHome(() => {
    writeTextAtomic(managedFile("bash"), "# foreign\r\n");
    upsertBlock("bash", rec, ["echo first\r\necho second"]);
    expect(readFileSync(managedFile("bash"), "utf8")).not.toContain("\r");
    upsertBlock("zsh", rec, ["echo zsh"]);
    expect(readFileSync(managedFile("zsh"), "utf8")).not.toContain("echo first");
  }));

  test("reload quotes roots and places undo prefixes before source", () => withTempHome(() => {
    process.env.GRASSHOPPER_HOME = join(process.env.GRASSHOPPER_HOME!, "root with ' quote");
    for (const shell of ["bash", "zsh"] as const) {
      writeReload(shell, ["unalias gs 2>/dev/null", "unset -f helper 2>/dev/null"]);
      const path = toShellPath(managedFile(shell), shell).replaceAll("'", "'\\''");
      expect(readFileSync(reloadFile(shell), "utf8")).toBe(`unalias gs 2>/dev/null\nunset -f helper 2>/dev/null\nsource '${path}'\n`);
      writeReload(shell, []);
      expect(readFileSync(reloadFile(shell), "utf8")).toBe(`source '${path}'\n`);
    }
  }));
});
