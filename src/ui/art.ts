import { randomInt } from "node:crypto";
import { readFileSync, writeSync } from "node:fs";
import { loadConfig } from "../core/config.ts";
import { leaf, stem, wheat } from "./style.ts";

export function mark(): string {
  return loadConfig().ui.emoji ? "🦗" : "~o";
}

const ART = [
  stem("                     \\   /"),
  stem("                      \\ /"),
  `${stem("          __          ")}${leaf("(")}${wheat("o")}${leaf(")_")}`,
  `${stem("         /  \\")}${leaf("_____.---' __)")}`,
  leaf("    ____/_________.---'/"),
  leaf("   <_____________/___/"),
  stem("         / /      \\  \\"),
  stem("        /_/        \\__\\"),
].join("\n");

let imageId: number | undefined;

function clearImage(): void {
  if (imageId === undefined) return;
  // Exit handlers cannot wait for buffered writes. Delete only our image and data.
  writeSync(process.stdout.fd, `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`);
  imageId = undefined;
  process.removeListener("exit", clearImage);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
}

function interrupt(): void {
  clearImage();
  // Let interactive prompts retain their cancellation handling.
  if (process.listenerCount("SIGINT") === 0) process.exit(130);
}

function terminate(): void {
  clearImage();
  if (process.listenerCount("SIGTERM") === 0) process.exit(143);
}

export function printArt(): void {
  const { env, stdout } = process;
  const term = env.TERM?.toLowerCase() ?? "";
  if (!stdout.isTTY || env.NO_COLOR || env.TMUX || env.STY || term === "dumb" || /^(screen|tmux)/.test(term)) return console.log(ART);

  const program = env.TERM_PROGRAM?.toLowerCase() ?? "";
  // Do not trust outer-terminal session variables inside a different emulator.
  const kitty = ["kitty", "ghostty", "wezterm", "warpterminal", "tty7"].includes(program)
    || (!program && (env.KITTY_WINDOW_ID || env.WEZTERM_PANE || env.GHOSTTY_RESOURCES_DIR || term === "xterm-kitty" || term === "xterm-ghostty"));
  const iterm = program === "iterm.app" || (!program && env.ITERM_SESSION_ID);
  if (!kitty && !iterm) return console.log(ART);

  const png = readFileSync(new URL("../../assets/grasshopper.png", import.meta.url));
  const data = png.toString("base64");
  const columns = Math.min(20, stdout.columns || 20);
  const rows = Math.min(8, Math.max(1, (stdout.rows || 10) - 2));
  if (iterm) return console.log(`\x1b]1337;File=inline=1;size=${png.length};width=${columns};height=${rows};preserveAspectRatio=1:${data}\x07`);

  if (imageId === undefined) {
    imageId = randomInt(1, 0x100000000);
    process.once("exit", clearImage);
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
  }

  // Reserve room before painting so a banner at the bottom can scroll safely.
  // C=1 disables Kitty's cursor movement; position it explicitly for the greeting.
  let output = `${"\n".repeat(rows)}\x1b[${rows}A\r`;
  for (let offset = 0; offset < data.length; offset += 4096) {
    const params = offset === 0 ? `a=T,f=100,q=2,C=1,c=${columns},r=${rows},i=${imageId},` : "";
    const more = offset + 4096 < data.length ? 1 : 0;
    output += `\x1b_G${params}m=${more};${data.slice(offset, offset + 4096)}\x1b\\`;
  }
  console.log(output + (rows > 1 ? `\x1b[${rows - 1}B\r` : "\r"));
}

export const PHRASES = {
  welcome: "Welcome, young grasshopper.",
  analyzing: "Meditating on your history…",
  chatting: "Consulting the smol sensei…",
  empty: "Nothing new to learn today. Practice is the path.",
  done: "Well done, grasshopper.",
  discarded: "Discarded. The grasshopper hops on.",
  fresh: (n: number): string => `${n} fresh recommendation${n === 1 ? "" : "s"} await, young grasshopper. Run ghop`,
} as const;
