import { expect, test } from "bun:test";
import { assignPseudonyms, renderTemplate } from "../../src/privacy/pseudonyms.ts";
import type { NormEntry, NormToken } from "../../src/privacy/normalize.ts";

function entry(tokens: NormToken[]): NormEntry {
  return { entry: { text: "fixture", ts: null, durationSec: null, seq: 0 }, commands: [{cmdKey: "cd", subKey: null, rawCmd: "cd", tokens}], ops: [] };
}
test("pseudonyms rank by frequency then lexical value without sharing raw values", () => {
  const rows = ["b", "a", "b", "a", "c"].map(value => entry([{text:"cd"},{text:"<path>",literal:{type:"path",value}}]));
  const map = assignPseudonyms(rows, ["unused"], 2);
  expect(map["<path#1>"]?.value).toBe("a");
  expect(map["<path#2>"]?.value).toBe("b");
  expect(Object.values(map).some(x => x.value === "c")).toBe(false);
  expect(map["<alias#1>"]?.value).toBe("unused");
  expect(renderTemplate(rows[0]!, map)).toBe("cd <path#2>");
});
test("generic duplicates collapse while assignment syntax and separators survive", () => {
  const row = entry([{text:"<var>=<val>",literal:{type:"var",value:"CUSTOM"}},{text:"echo"},{text:"<arg>",literal:{type:"arg",value:"a"}},{text:"<arg>",literal:{type:"arg",value:"b"}}]);
  expect(renderTemplate(row, {})).toBe("<var>=<val> echo <arg>");
  expect(renderTemplate(row, assignPseudonyms([row], [], 1))).toBe("<var#1>=<val> echo <arg#1> <arg#2>");
});
