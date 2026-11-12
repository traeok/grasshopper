import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { shellDump } from "../../src/core/paths.ts";
import { prepareAnalysis } from "../../src/llm/analyze.ts";
import { COMMANDS, isKnownWord } from "../../src/privacy/dictionary.ts";
import { assertOutboundSafe, validateProfile } from "../../src/privacy/egress.ts";
import { withTempHome } from "../helpers/env.ts";

function mulberry32(seed: number): () => number {
  return () => {
    let value = seed += 0x6D2B79F5;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test("2000 seeded histories expose neither random tokens nor their identifying fragments", () => withTempHome(async home => {
  for (const kind of ["aliases", "info"] as const) {
    const target = shellDump("bash", kind);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(new URL(`../fixtures/shell/bash.${kind}`, import.meta.url), target);
  }
  const random = mulberry32(1337);
  const integer = (size: number) => Math.floor(random() * size);
  const base62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const fragments = new Set<string>();
  const string = (length: number, alphabet = base62): string => {
    let value = "";
    for (let i = 0; i < length; i++) value += alphabet[integer(alphabet.length)]!;
    fragments.add(value);
    return value;
  };
  const generatedToken = (): string => {
    let token: string;
    switch (integer(6)) {
      case 0: token = string(8 + integer(33)); break;
      case 1: token = string(8 + integer(33), "0123456789abcdef"); break;
      case 2: token = `x${string(8)}.corp-int.net`; break;
      case 3: token = `/c/Users/u${string(8)}/p${string(8)}`; break;
      case 4: token = `u${string(8)}@h${string(8)}.io`; break;
      default: token = `--k${string(8)}=${string(8)}`; break;
    }
    fragments.add(token);
    return token;
  };
  const commands = [...COMMANDS];
  const entries = Array.from({ length: 2000 }, () => {
    const command = commands[integer(commands.length)]!;
    const tokens = Array.from({ length: 1 + integer(4) }, generatedToken);
    return [command, ...tokens].join(" ");
  });
  const file = join(home, "fuzz-history.txt");
  await Bun.write(file, entries.join("\n") + "\n");

  const { profile, messages, stats } = await prepareAnalysis({ source: { shell: "bash", file }, slots: 8 }, {
    which: name => ["npm", "winget"].includes(name) ? `/fixture/${name}` : null,
  });
  expect(stats.entries).toBe(2000);
  expect(stats.kept).toBeGreaterThan(0);
  expect(profile.topCommands.length).toBeGreaterThan(0);
  expect(messages.some(message => message.role === "user" && message.content.includes(JSON.stringify(profile)))).toBe(true);
  expect(() => validateProfile(profile)).not.toThrow();
  expect(() => assertOutboundSafe(messages, { literals: [] })).not.toThrow();

  // Check random components as well as whole tokens: leaking only a username,
  // path segment, or custom flag name must still fail this proof.
  const sensitive = [...fragments].filter(fragment => fragment.length >= 8 && !isKnownWord(fragment));
  expect(sensitive.length).toBeGreaterThan(2000);
  for (const payload of [JSON.stringify(profile), JSON.stringify(messages)]) {
    for (const fragment of sensitive) expect(payload).not.toContain(fragment);
  }
}));
