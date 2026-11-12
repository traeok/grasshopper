import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";

const moduleUrl = new URL("../../src/ui/art.ts", import.meta.url).href;
const png = readFileSync(new URL("../../assets/grasshopper.png", import.meta.url));

function render(tty: boolean, env: Record<string, string> = {}, after = "", exitCode = 0): string {
  const childEnv = { ...process.env };
  for (const key of ["TERM", "TERM_PROGRAM", "NO_COLOR", "FORCE_COLOR", "TMUX", "STY", "KITTY_WINDOW_ID", "WEZTERM_PANE", "GHOSTTY_RESOURCES_DIR", "ITERM_SESSION_ID"]) delete childEnv[key];
  const result = Bun.spawnSync([process.execPath, "--eval", `
    import { printArt } from ${JSON.stringify(moduleUrl)};
    Object.defineProperty(process.stdout, "isTTY", { value: ${tty} });
    Object.defineProperty(process.stdout, "columns", { value: 80 });
    Object.defineProperty(process.stdout, "rows", { value: 24 });
    printArt();
    ${after}
  `], { cwd: tmpdir(), env: { ...childEnv, TERM: "xterm-256color", ...env } });
  if (result.exitCode !== exitCode) throw new Error(`Exit ${result.exitCode}: ${result.stderr}`);
  return result.stdout.toString();
}

describe("welcome artwork", () => {
  test.each([
    [false, { TERM_PROGRAM: "kitty" }],
    [true, { TERM_PROGRAM: "unknown" }],
    [true, { TERM_PROGRAM: "kitty", NO_COLOR: "1", FORCE_COLOR: "1" }],
    [true, { TERM_PROGRAM: "kitty", TERM: "dumb" }],
    [true, { TERM_PROGRAM: "kitty", TMUX: "/tmp/tmux/1" }],
    [true, { TERM_PROGRAM: "iterm.app", STY: "screen-session" }],
    [true, { TERM_PROGRAM: "kitty", TERM: "screen-256color" }],
    [true, { TERM_PROGRAM: "vscode", KITTY_WINDOW_ID: "1", ITERM_SESSION_ID: "outer" }],
  ] satisfies [boolean, Record<string, string>][])("uses text without leaking graphics for tty=%s, env=%j", (tty, env) => {
    const output = render(tty, env);
    expect(output).not.toContain("\x1b_G");
    expect(output).not.toContain("\x1b]1337;File=");
    expect(stripVTControlCharacters(output)).toMatch(/^[\x20-\x7e\r\n]+$/);
  });

  test.each(["kitty", "ghostty", "wezterm", "warpterminal", "tty7"])("transmits the complete bounded PNG in %s", (program) => {
    const output = render(true, { TERM_PROGRAM: program });
    const chunks = [...output.matchAll(/\x1b_G([^;]+);([A-Za-z0-9+/=]+)\x1b\\/g)];
    expect(chunks[0]?.[1]).toContain("a=T,f=100,q=2,C=1,c=20,r=8");
    for (const [index, chunk] of chunks.entries()) {
      expect(chunk[2]!.length).toBeLessThanOrEqual(4096);
      expect(chunk[1]).toContain(`m=${index === chunks.length - 1 ? 0 : 1}`);
    }
    expect(Buffer.from(chunks.map(chunk => chunk[2]).join(""), "base64")).toEqual(png);
    // Reserve image rows before painting, then leave the cursor on its last row.
    expect(output.startsWith("\n".repeat(8) + "\x1b[8A\r")).toBe(true);
    const id = /(?:^|,)i=(\d+)(?:,|$)/.exec(chunks[0]![1]!)?.[1];
    expect(Number(id)).toBeGreaterThan(0);
    expect(output.endsWith(`\x1b[7B\r\n\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`)).toBe(true);
  });

  test.each([
    ["normal completion", "", 0],
    ["prompt cancellation", "process.exit(0);", 0],
    ["failure", "throw new Error('setup failed');", 1],
    ["interrupt", "process.emit('SIGINT');", 130],
    ["termination", "process.emit('SIGTERM');", 143],
  ] as const)("deletes only the banner after %s", (_name, finish, exitCode) => {
    const output = render(true, { TERM_PROGRAM: "tty7" }, `console.log("finished"); ${finish}`, exitCode);
    const commands = [...output.matchAll(/\x1b_G([^;]*?)(?:;[A-Za-z0-9+/=]*)?\x1b\\/g)]
      .map(match => Object.fromEntries(match[1]!.split(",").map(pair => pair.split("="))));
    const image = commands.find(command => command.a === "T")!;
    const deletes = commands.filter(command => command.a === "d");
    expect(deletes).toEqual([{ a: "d", d: "I", i: image.i, q: "2" }]);
    expect(output.indexOf("\x1b_Ga=d")).toBeGreaterThan(output.indexOf("finished"));
  });

  test("repeated banners replace the owned image rather than leaving old placements", () => {
    const output = render(true, { TERM_PROGRAM: "tty7" }, "printArt();");
    const ids = [...output.matchAll(/\x1b_Ga=T,[^;]*,i=(\d+),/g)].map(match => match[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect([...output.matchAll(/\x1b_Ga=d,/g)]).toHaveLength(1);
    expect(output.endsWith(`\x1b_Ga=d,d=I,i=${ids[0]},q=2\x1b\\`)).toBe(true);
  });

  test("keeps an existing prompt signal handler in control of cancellation", () => {
    const output = render(true, { TERM_PROGRAM: "tty7" }, `
      process.once("SIGINT", () => { console.log("prompt cancelled"); process.exit(0); });
      process.emit("SIGINT");
    `);
    expect(output).toContain("prompt cancelled");
    expect([...output.matchAll(/\x1b_Ga=d,/g)]).toHaveLength(1);
  });

  test("iTerm2 receives an inline, aspect-preserving PNG rather than a download", () => {
    const output = render(true, { TERM_PROGRAM: "iTerm.app" });
    const image = /^\x1b\]1337;File=([^:]+):([A-Za-z0-9+/=]+)\x07\n$/.exec(output);
    expect(image?.[1]).toContain("inline=1");
    expect(image?.[1]).toContain(`size=${png.length}`);
    expect(image?.[1]).toContain("width=20;height=8;preserveAspectRatio=1");
    expect(Buffer.from(image![2]!, "base64")).toEqual(png);
  });
});
