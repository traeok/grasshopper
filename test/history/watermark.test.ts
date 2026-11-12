import { describe, expect, test } from "bun:test";
import type { HistoryEntry } from "../../src/history/parse.ts";
import { computeFresh } from "../../src/history/watermark.ts";

function entries(texts: string[], timestamps: (number | null)[] = []): HistoryEntry[] {
  return texts.map((text, seq) => ({ text, seq, ts: timestamps[seq] ?? null, durationSec: null }));
}

const salt = "fixture-install-salt";

describe("computeFresh", () => {
  test("the first read is all fresh and stores the last five salted hashes", () => {
    const input = entries(["a", "b", "c", "d", "e", "f"]);
    const result = computeFresh(input, undefined, salt);
    expect(result.fresh).toEqual(input);
    expect(result.fresh[0]).toBe(input[0]);
    expect(result.next.lastTs).toBeNull();
    expect(result.next.tailHashes).toEqual(input.slice(-5).map(({ text }) =>
      new Bun.CryptoHasher("sha256").update(salt + text).digest("hex").slice(0, 16)));
  });

  test("untimed history uses the last matching contiguous tail", () => {
    const before = computeFresh(entries(["a", "b", "c", "d", "e"]), undefined, salt);
    const input = entries(["a", "b", "c", "d", "e", "middle", "a", "b", "c", "d", "e", "new"]);
    expect(computeFresh(input, before.next, salt).fresh).toEqual(input.slice(-1));
    expect(computeFresh(entries(["a", "b", "c", "d", "e"]), before.next, salt).fresh).toEqual([]);
  });

  test("short histories advance incrementally", () => {
    const before = computeFresh(entries(["git status", "pwd"]), undefined, salt);
    const input = entries(["git status", "pwd", "ls"]);
    expect(computeFresh(input, before.next, salt).fresh).toEqual(input.slice(2));
  });

  test("rotation retains overlap; missing or noncontiguous overlap reingests", () => {
    const before = computeFresh(entries(["old", "a", "b", "c", "d", "e"]), undefined, salt);
    const rotated = entries(["a", "b", "c", "d", "e", "new"]);
    expect(computeFresh(rotated, before.next, salt).fresh).toEqual(rotated.slice(5));
    const missing = entries(["a", "b", "inserted", "c", "d", "e"]);
    expect(computeFresh(missing, before.next, salt).fresh).toEqual(missing);
    expect(computeFresh(rotated, before.next, "different-salt").fresh).toEqual(rotated);
    expect(computeFresh(rotated, { tailHashes: [], lastTs: null }, salt).fresh).toEqual(rotated);
  });

  test("exactly half timestamped uses strict timestamps and retains original objects", () => {
    const input = entries(["untimed", "old", "same", "new", "other", "last"], [null, 99, 100, 101, null, null]);
    const result = computeFresh(input, { tailHashes: [], lastTs: 100 }, salt);
    expect(result.fresh).toEqual([input[3]!]);
    expect(result.fresh[0]).toBe(input[3]);
    expect(result.next.lastTs).toBe(101);
  });

  test("less than half timestamped uses overlap instead of timestamps", () => {
    const before = computeFresh(entries(["a", "b", "c", "d", "e"]), undefined, salt);
    const input = entries(["a", "b", "c", "d", "e", "new"], [null, null, null, null, null, 1]);
    expect(computeFresh(input, { ...before.next, lastTs: 100 }, salt).fresh).toEqual(input.slice(5));
  });

  test("a missing previous timestamp ingests all; next stores maximum rather than final timestamp", () => {
    const input = entries(["new", "old", "untimed"], [101, 100, null]);
    const result = computeFresh(input, { tailHashes: [], lastTs: null }, salt);
    expect(result.fresh).toEqual(input);
    expect(result.next.lastTs).toBe(101);
    expect(computeFresh(entries(["epoch", "later"], [0, 1]), { tailHashes: [], lastTs: 0 }, salt).fresh)
      .toEqual(entries(["later"], [1]).map((entry) => ({ ...entry, seq: 1 })));
  });

  test("an empty history has no fresh entries or next timestamp", () => {
    expect(computeFresh([], { tailHashes: ["previous"], lastTs: 100 }, salt))
      .toEqual({ fresh: [], next: { tailHashes: [], lastTs: null } });
  });
});
