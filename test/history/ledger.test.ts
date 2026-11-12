import { describe, expect, test } from "bun:test";
import { tx } from "../../src/core/db.ts";
import { localDate } from "../../src/core/dates.ts";
import { getMeta } from "../../src/core/state.ts";
import { addToLedger, computeTrends, loadLedger, saveLedger } from "../../src/history/ledger.ts";
import type { Ledger } from "../../src/history/ledger.ts";
import type { NormEntry } from "../../src/privacy/normalize.ts";
import { withTempHome } from "../helpers/env.ts";

const today = "2026-11-12";

function dayAgo(age: number): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) - age * 86_400_000).toISOString().slice(0, 10);
}

function norm(seq: number, keys: [string, string | null][], ts: number | null = null): NormEntry {
  return {
    entry: { text: "fixture", ts, seq, durationSec: null },
    commands: keys.map(([cmdKey, subKey]) => ({ cmdKey, subKey, tokens: [], rawCmd: cmdKey })),
    ops: [],
  };
}

function trendLedger(ages: number[] = Array.from({ length: 10 }, (_, index) => index)): Ledger {
  return {
    firstUntimedDay: null,
    days: Object.fromEntries(ages.map((age) => [dayAgo(age), { timed: false, counts: { [`fixture${age}`]: 1 } }])),
  };
}

describe("history ledger", () => {
  test("counts every command, wrappers and subcommands only from fresh normalized entries", () => {
    const ledger: Ledger = { firstUntimedDay: null, days: {} };
    const fresh = [norm(1, [["sudo", null], ["apt", "apt install"]]), norm(2, [["git", "git status"]])];
    expect(addToLedger(ledger, fresh, today)).toBe(ledger);
    expect(ledger.firstUntimedDay).toBe(today);
    expect(ledger.days[today]).toEqual({ timed: false, counts: { sudo: 1, apt: 1, "apt install": 1, git: 1, "git status": 1 } });
    addToLedger(ledger, [], today);
    expect(ledger.days[today]!.counts.git).toBe(1);
    addToLedger(ledger, [norm(3, [["git", "git status"]])], dayAgo(-1));
    expect(ledger.firstUntimedDay).toBe(today);
    expect(ledger.days[dayAgo(-1)]!.counts.git).toBe(1);
  });

  test("timestamps use local dates and make a mixed day timed", () => {
    const timestamp = Math.floor(new Date(2026, 10, 10, 12).getTime() / 1000);
    const day = localDate(new Date(timestamp * 1000));
    const ledger: Ledger = { firstUntimedDay: null, days: {} };
    addToLedger(ledger, [norm(0, [["git", null]], timestamp)], today);
    expect(ledger.firstUntimedDay).toBeNull();
    expect(ledger.days[day]).toEqual({ timed: true, counts: { git: 1 } });
    addToLedger(ledger, [norm(1, [["ls", null]])], day);
    expect(ledger.days[day]).toEqual({ timed: true, counts: { git: 1, ls: 1 } });
    expect(ledger.firstUntimedDay).toBeNull();
  });

  test("prunes dates older than 120 calendar days even with no fresh entries", () => {
    const ledger = trendLedger([0, 120, 121]);
    addToLedger(ledger, [], today);
    expect(Object.keys(ledger.days).sort()).toEqual([dayAgo(120), today]);
  });

  test("SQLite round-trips, replaces removed rows, and rolls back with the caller", () => withTempHome(() => {
    expect(loadLedger()).toEqual({ firstUntimedDay: null, days: {} });
    const ledger = trendLedger([0, 1]);
    ledger.firstUntimedDay = dayAgo(1);
    ledger.days[today]!.timed = true;
    ledger.days[today]!.counts["git status"] = 12;
    tx(() => saveLedger(ledger));
    expect(loadLedger()).toEqual(ledger);
    expect(getMeta("ledgerFirstUntimedDay")).toBe(dayAgo(1));
    const replacement = trendLedger([2]);
    expect(() => tx(() => {
      saveLedger(replacement);
      throw new Error("fixture rollback");
    })).toThrow("fixture rollback");
    expect(loadLedger()).toEqual(ledger);
    tx(() => saveLedger(replacement));
    expect(loadLedger()).toEqual(replacement);
  }));

  test("refuses a rewrite outside a transaction", () => withTempHome(() => {
    expect(() => saveLedger(trendLedger())).toThrow("requires a transaction");
    expect(loadLedger().days).toEqual({});
  }));
});

describe("computeTrends", () => {
  test("collects ten distinct non-bootstrap days within the analysis window", () => {
    const ledger = trendLedger();
    ledger.firstUntimedDay = today;
    expect(computeTrends(ledger, today)).toEqual({ available: false, reason: "collecting" });
    ledger.days[dayAgo(35)] = { timed: true, counts: { git: 100 } };
    ledger.days[dayAgo(-1)] = { timed: true, counts: { git: 100 } };
    expect(computeTrends(ledger, today)).toEqual({ available: false, reason: "collecting" });
    ledger.days[dayAgo(10)] = { timed: false, counts: { git: 1 } };
    expect(computeTrends(ledger, today).available).toBe(true);
  });

  test("uses exact recent/baseline boundaries and threshold rates", () => {
    const ledger = trendLedger([0, 1, 2, 3, 4, 5, 6, 7, 14, 34, 35]);
    ledger.days[dayAgo(6)]!.counts = { rising: 5, tooFew: 4, falling: 1, tooHigh: 2, fresh: 5 };
    ledger.days[dayAgo(7)]!.counts = { rising: 10, tooFew: 1, falling: 8, tooHigh: 8, tiny: 7 };
    ledger.days[dayAgo(34)]!.counts.edge = 3;
    ledger.days[dayAgo(35)]!.counts = { rising: 10000, fresh: 10000, edge: 10000 };
    const trends = computeTrends(ledger, today);
    expect(trends.available).toBe(true);
    if (!trends.available) return;
    expect(trends.recentDays).toBe(7);
    expect(trends.baselineDays).toBe(28);
    expect(trends.rising).toEqual([{ c: "rising", recent: 5, baseline: 10 }]);
    expect(trends.falling).toEqual([{ c: "falling", recent: 1, baseline: 8 }]);
    expect(trends.new).toEqual([{ c: "fresh", recent: 5, baseline: 0 }]);
  });

  test("new commands require a fourteen-day span and at least five recent uses", () => {
    const ledger = trendLedger();
    ledger.days[today]!.counts = { newCommand: 5, tooFew: 4 };
    let trends = computeTrends(ledger, today);
    expect(trends.available).toBe(true);
    if (trends.available) expect(trends.new).toEqual([]);
    ledger.days[dayAgo(14)] = { timed: false, counts: { pwd: 1 } };
    trends = computeTrends(ledger, today);
    if (!trends.available) throw new Error("expected trends");
    expect(trends.new).toEqual([{ c: "newCommand", recent: 5, baseline: 0 }]);
  });

  test("bootstrap data contributes neither counts, span nor timestamp basis", () => {
    const ledger = trendLedger();
    ledger.firstUntimedDay = dayAgo(20);
    ledger.days[dayAgo(20)] = { timed: true, counts: { git: 10000 } };
    ledger.days[today]!.counts = { git: 5 };
    const trends = computeTrends(ledger, today);
    if (!trends.available) throw new Error("expected trends");
    expect(trends.basis).toBe("ingestion-days");
    expect(trends.rising).toEqual([]);
    expect(trends.new).toEqual([]);
  });

  test("basis uses counted days with timestamps winning a fifty-percent tie", () => {
    const ledger = trendLedger();
    for (let age = 0; age < 5; age++) ledger.days[dayAgo(age)]!.timed = true;
    let trends = computeTrends(ledger, today);
    if (!trends.available) throw new Error("expected trends");
    expect(trends.basis).toBe("timestamps");
    ledger.days[today]!.timed = false;
    trends = computeTrends(ledger, today);
    if (!trends.available) throw new Error("expected trends");
    expect(trends.basis).toBe("ingestion-days");
  });

  test("caps each trend group at five by absolute daily-rate change", () => {
    const ledger = trendLedger([0, 1, 2, 3, 4, 5, 6, 7, 14, 20]);
    for (let index = 0; index < 7; index++) {
      ledger.days[today]!.counts[`rise${index}`] = 5 + index;
      ledger.days[dayAgo(7)]!.counts[`rise${index}`] = 1;
      ledger.days[dayAgo(7)]!.counts[`fall${index}`] = 8 + index;
      ledger.days[today]!.counts[`new${index}`] = 5 + index;
    }
    const trends = computeTrends(ledger, today);
    if (!trends.available) throw new Error("expected trends");
    expect(trends.rising.map(({ c }) => c)).toEqual(["rise6", "rise5", "rise4", "rise3", "rise2"]);
    expect(trends.falling.map(({ c }) => c)).toEqual(["fall6", "fall5", "fall4", "fall3", "fall2"]);
    expect(trends.new.map(({ c }) => c)).toEqual(["new6", "new5", "new4", "new3", "new2"]);
  });
});
