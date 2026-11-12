export type ColorDepth = "none" | "16m" | "256" | "16";

export function colorDepth(): ColorDepth {
  const env = process.env;
  if (env.NO_COLOR || (!process.stdout.isTTY && env.FORCE_COLOR === undefined)) {
    return "none";
  }
  if (
    env.COLORTERM === "truecolor" ||
    env.COLORTERM === "24bit" ||
    env.WT_SESSION !== undefined ||
    ["mintty", "vscode", "iTerm.app", "WezTerm", "ghostty"].includes(env.TERM_PROGRAM ?? "")
  ) {
    return "16m";
  }
  if (env.TERM?.includes("256color") || env.TERM_PROGRAM === "Apple_Terminal") {
    return "256";
  }
  return "16";
}

export const palette = {
  leaf: "#7CB518",
  stem: "#4F772D",
  sprout: "#B5E48C",
  meadow: "#99D98C",
  teal: "#52B69A",
  wheat: "#D4A373",
  warn: "#F4A259",
  danger: "#E63946",
} as const;

export function fg(hex: string): (s: string) => string {
  return (s) => {
    const depth = colorDepth();
    if (depth === "none") return s;
    const prefix = Bun.color(hex, `ansi-${depth}`);
    return prefix ? `${prefix}${s}\x1b[39m` : s;
  };
}

function effect(open: number, close: number): (s: string) => string {
  return (s) => colorDepth() === "none" ? s : `\x1b[${open}m${s}\x1b[${close}m`;
}

export const bold = effect(1, 22);
export const dim = effect(2, 22);
export const italic = effect(3, 23);
export const underline = effect(4, 24);

export const leaf = fg(palette.leaf);
export const stem = fg(palette.stem);
export const sprout = fg(palette.sprout);
export const meadow = fg(palette.meadow);
export const teal = fg(palette.teal);
export const wheat = fg(palette.wheat);
export const warn = fg(palette.warn);
export const danger = fg(palette.danger);

export const categoryColors = {
  workflow: wheat,
  alias: sprout,
  tip: meadow,
  "red-flag": danger,
  tool: leaf,
  shortcut: teal,
} as const;
