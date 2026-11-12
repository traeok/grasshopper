import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { GhopError } from "../../src/core/errors.ts";
import { parseBash, parsePowerShell, parseZsh, readHistory, unmetafy } from "../../src/history/parse.ts";
import { withTempHome } from "../helpers/env.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const fixture = (name: string) => new URL(`../fixtures/history/${name}`, import.meta.url);

describe("parseBash", () => {
  test("reads untimed nonempty fixture lines in order", async () => {
    const entries = parseBash(await Bun.file(fixture("bash-plain.txt")).bytes());
    expect(entries).toEqual([
      { text: "git status", ts: null, durationSec: null, seq: 0 },
      { text: "cd ~/work/api", ts: null, durationSec: null, seq: 1 },
      { text: "npm run dev", ts: null, durationSec: null, seq: 2 },
      { text: "#not-a-timestamp", ts: null, durationSec: null, seq: 3 },
      { text: "printf 'hello world'", ts: null, durationSec: null, seq: 4 },
    ]);
  });

  test("groups three-line entries and retains untimed preamble", async () => {
    const entries = parseBash(await Bun.file(fixture("bash-timestamped.txt")).bytes());
    expect(entries).toEqual([
      { text: "git status", ts: null, durationSec: null, seq: 0 },
      { text: "pwd", ts: null, durationSec: null, seq: 1 },
      { text: "printf 'first\nsecond\nthird'", ts: 1731000000, durationSec: null, seq: 2 },
      { text: "git diff", ts: 1731000060, durationSec: null, seq: 3 },
      { text: "npm test", ts: 1731000120, durationSec: null, seq: 4 },
    ]);
  });

  test("normalizes CRLF, preserves inner blank lines and leading spaces", () => {
    expect(parseBash(bytes("#1731000000\r\nprintf 'a\r\n\r\nb'\r\n#1731000060\r\n hidden\r\n")))
      .toEqual([
        { text: "printf 'a\n\nb'", ts: 1731000000, durationSec: null, seq: 0 },
        { text: " hidden", ts: 1731000060, durationSec: null, seq: 1 },
      ]);
  });

  test("accepts only complete 9–11 digit timestamp markers", () => {
    expect(parseBash(bytes("#12345678\n#123456789012\n#1731000000 suffix\n"))
      .map((entry) => entry.text)).toEqual(["#12345678", "#123456789012", "#1731000000 suffix"]);
    expect(parseBash(bytes("#123456789\na\n#12345678901\nb"))
      .map((entry) => entry.ts)).toEqual([123456789, 12345678901]);
  });

  test("skips empty commands and replaces invalid UTF-8 without throwing", () => {
    expect(parseBash(new Uint8Array())).toEqual([]);
    expect(parseBash(bytes("#1731000000\n#1731000060\necho ok\n#1731000120\n")))
      .toEqual([{ text: "echo ok", ts: 1731000060, durationSec: null, seq: 0 }]);
    expect(parseBash(new Uint8Array([0x65, 0x63, 0x68, 0x6f, 0x20, 0xff]))[0]?.text)
      .toBe("echo \uFFFD");
  });
});

describe("parseZsh", () => {
  test("reads extended metadata and a multiline continuation", async () => {
    expect(parseZsh(await Bun.file(fixture("zsh-extended.txt")).bytes())).toEqual([
      { text: "pwd", ts: null, durationSec: null, seq: 0 },
      { text: "git status", ts: 1731000000, durationSec: 0, seq: 1 },
      { text: "printf 'first\nsecond'", ts: 1731000060, durationSec: 12, seq: 2 },
      { text: "npm test", ts: 1731000120, durationSec: 25, seq: 3 },
    ]);
  });

  test("joins odd trailing backslashes, but not even ones", () => {
    const text = "echo a" + "\\".repeat(3) + "\r\n" + "b\r\n" + "echo c" + "\\".repeat(2) + "\r\n" + "pwd\r\n";
    expect(parseZsh(bytes(text)).map((entry) => entry.text))
      .toEqual(["echo a" + "\\".repeat(2) + "\nb", "echo c" + "\\".repeat(2), "pwd"]);
  });

  test("handles multiple continuations, dangling continuation, and invalid headers", () => {
    expect(parseZsh(bytes("echo a\\\nb\\\nc\necho end\\")).map((entry) => entry.text))
      .toEqual(["echo a\nb\nc", "echo end\n"]);
    expect(parseZsh(bytes(": 123:0;echo x\n: 1731000000:x;echo y\n"))
      .map((entry) => entry.ts)).toEqual([null, null]);
    expect(parseZsh(bytes("\n\n"))).toEqual([]);
  });

  test("unmetafies an em dash before decoding UTF-8", () => {
    const stored = new Uint8Array([...bytes("echo "), 0xe2, 0x80, 0x83, 0xb4]);
    expect(parseZsh(stored)[0]?.text).toBe("echo —");
    expect([...unmetafy(new Uint8Array([0x83, 0x20, 0x83, 0xa3, 0x83, 0x82]))])
      .toEqual([0, 0x83, 0xa2]);
  });

  test("replaces invalid UTF-8 and retains dangling metafy markers", () => {
    expect(parseZsh(new Uint8Array([0xff]))[0]?.text).toBe("\uFFFD");
    expect(parseZsh(new Uint8Array([0x83]))[0]?.text).toBe("\uFFFD");
  });
});

describe("parsePowerShell", () => {
  test("decodes BOM and CRLF without inventing timestamps", () => {
    expect(parsePowerShell(bytes("\ufeffGet-Item C:\\Temp\r\n#1700000000\r\n\r\n"))).toEqual([
      { text: "Get-Item C:\\Temp", ts: null, durationSec: null, seq: 0 },
      { text: "#1700000000", ts: null, durationSec: null, seq: 1 },
    ]);
  });

  test("removes exactly one PSReadLine newline marker regardless of backtick parity", () => {
    const physical = ['Write-Output "first`', 'second"', "Write-Output one``", "two", "Write-Output three```", "four", ""];
    expect(parsePowerShell(bytes(physical.join("\r\n"))).map(entry => entry.text)).toEqual([
      'Write-Output "first\nsecond"', "Write-Output one`\ntwo", "Write-Output three``\nfour",
    ]);
    expect(parsePowerShell(bytes("Write-Output dangling``"))[0]?.text).toBe("Write-Output dangling`\n");
  });
});

describe("readHistory", () => {
  test("retains only the newest entries and renumbers their seq", () => withTempHome(async (home) => {
    const file = join(home, "fixture-history");
    await Bun.write(file, await Bun.file(fixture("bash-timestamped.txt")).bytes());
    expect(await readHistory({ shell: "bash", file }, 2)).toEqual([
      { text: "git diff", ts: 1731000060, durationSec: null, seq: 0 },
      { text: "npm test", ts: 1731000120, durationSec: null, seq: 1 },
    ]);
    expect(await readHistory({ shell: "bash", file }, 0)).toEqual([]);
    expect((await readHistory({ shell: "bash", file }, 100)).length).toBe(5);
  }));

  test("selects the zsh parser", () => withTempHome(async (home) => {
    const file = join(home, "fixture-history");
    await Bun.write(file, await Bun.file(fixture("zsh-extended.txt")).bytes());
    expect(await readHistory({ shell: "zsh", file }, 1)).toEqual([
      { text: "npm test", ts: 1731000120, durationSec: 25, seq: 0 },
    ]);
  }));

  test("reports missing fixture paths as a GhopError", () => withTempHome(async (home) => {
    const file = join(home, "missing-history");
    try {
      await readHistory({ shell: "bash", file }, 10);
      throw new Error("Expected missing history to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GhopError);
      expect((error as Error).message).toContain(file);
    }
  }));
});
