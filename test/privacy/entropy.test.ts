import { expect, test } from "bun:test";
import { findHighEntropyTokens, shannon } from "../../src/privacy/entropy.ts";

const diverse = "AbCdEfGhIjKlMnOpQrStUv01";

test("Shannon entropy is bits per character with empty and constant inputs at zero", () => {
  expect(shannon("")).toBe(0);
  expect(shannon("aaaaaaaa")).toBe(0);
  expect(shannon("ab")).toBe(1);
  expect(shannon("aabb")).toBe(1);
  expect(shannon("abcd")).toBe(2);
  expect(shannon("aaab")).toBeCloseTo(0.8112781244591328, 12);
  expect(shannon("😀😀ab")).toBe(1.5);
});

test("entropy requires at least 24 characters in one maximal run", () => {
  expect(diverse.length).toBe(24);
  expect(findHighEntropyTokens(diverse)).toEqual([diverse]);
  expect(findHighEntropyTokens(diverse.slice(1))).toEqual([]);
  expect(findHighEntropyTokens(`${diverse.slice(0, 12)}.${diverse.slice(12)}`)).toEqual([]);
  expect(findHighEntropyTokens(`${diverse}${"A".repeat(200)}`)).toEqual([]);
});

test("entropy candidates require digits, uppercase and lowercase letters", () => {
  expect(findHighEntropyTokens(diverse.toLowerCase())).toEqual([]);
  expect(findHighEntropyTokens(diverse.toUpperCase())).toEqual([]);
  expect(findHighEntropyTokens("AbCdEfGhIjKlMnOpQrStUvWx")).toEqual([]);
  expect(findHighEntropyTokens("Aa1".repeat(20))).toEqual([]);
});

test("entropy threshold is 4.2 bits per character", () => {
  const above = "AbCdEfGhIjKlMnOpQr01AbCd";
  const below = "AbCdEfGhIjKlMnOpQ01AbCdE";
  expect(above.length).toBe(24);
  expect(below.length).toBe(24);
  expect(shannon(above)).toBeCloseTo(4.251629167387822, 12);
  expect(shannon(below)).toBeCloseTo(4.16829583405449, 12);
  expect(findHighEntropyTokens(above)).toEqual([above]);
  expect(findHighEntropyTokens(below)).toEqual([]);
});

test("maximal candidates include permitted punctuation but at most two slashes", () => {
  const punctuated = `+_${diverse}=-`;
  const twoSlashes = `/${diverse}/`;
  expect(findHighEntropyTokens(`"${punctuated}" '${twoSlashes}'`)).toEqual([punctuated, twoSlashes]);
  expect(findHighEntropyTokens(`//${diverse}/`)).toEqual([]);
});

test("hexadecimal SHAs and UUIDs are not high entropy credentials", () => {
  expect(findHighEntropyTokens("3f2a9c1e5b7d4a6f8e0c2b4d6f8a0c2e4b6d8f0a")).toEqual([]);
  expect(findHighEntropyTokens("72f988bf-86f1-41af-91ab-2d7cd011db47")).toEqual([]);
  expect(findHighEntropyTokens("72F988BF-86F1-41AF-91AB-2D7CD011DB47")).toEqual([]);
});

test("detection preserves occurrence order and duplicates without state between calls", () => {
  const other = "ZyXwVuTsRqPoNmLkJiHgFe98";
  const text = `echo "${diverse}" '${other}' "${diverse}"`;
  const expected = [diverse, other, diverse];
  expect(findHighEntropyTokens(text)).toEqual(expected);
  expect(findHighEntropyTokens(text)).toEqual(expected);
  expect(findHighEntropyTokens("")).toEqual([]);
  expect(shannon(diverse)).toBe(shannon(diverse));
});
