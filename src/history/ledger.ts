import { openDb } from "../core/db.ts";
import { localDate } from "../core/dates.ts";
import { getMeta, setMeta } from "../core/state.ts";
import type { NormEntry } from "../privacy/normalize.ts";
import type { Profile, TrendItem } from "../profile/types.ts";

export interface Ledger {
  firstUntimedDay: string | null;
  days: Record<string, { timed: boolean; counts: Record<string, number> }>;
}

const DAY_MS = 86_400_000;

// Compare calendar dates, not elapsed local milliseconds (which vary at DST boundaries).
function dayNumber(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) / DAY_MS;
}

export function loadLedger(): Ledger {
  const db = openDb();
  const days: Ledger["days"] = Object.create(null);
  for (const row of db.query<{ day: string; timed: number }, []>("SELECT day, timed FROM ledger_days").all()) {
    days[row.day] = { timed: row.timed !== 0, counts: Object.create(null) };
  }
  for (const row of db.query<{ day: string; key: string; n: number }, []>("SELECT day, key, n FROM ledger_counts").all()) {
    const day = days[row.day];
    if (day) day.counts[row.key] = row.n;
  }
  return { firstUntimedDay: getMeta("ledgerFirstUntimedDay"), days };
}

/** Rewrite together with the successful analysis and watermark, inside the caller's tx(). */
export function saveLedger(ledger: Ledger): void {
  const db = openDb();
  if (!db.inTransaction) throw new Error("Saving the history ledger requires a transaction.");
  db.exec("DELETE FROM ledger_counts; DELETE FROM ledger_days;");
  const insertDay = db.query("INSERT INTO ledger_days (day, timed) VALUES (?, ?)");
  const insertCount = db.query("INSERT INTO ledger_counts (day, key, n) VALUES (?, ?, ?)");
  for (const [day, value] of Object.entries(ledger.days)) {
    insertDay.run(day, Number(value.timed));
    for (const [key, n] of Object.entries(value.counts)) insertCount.run(day, key, n);
  }
  setMeta("ledgerFirstUntimedDay", ledger.firstUntimedDay);
}

/** Mutates the supplied ledger; the profile builder supplies its own copy. */
export function addToLedger(ledger: Ledger, freshNorm: NormEntry[], today: string): Ledger {
  if (Object.keys(ledger.days).length === 0 && freshNorm.some((item) => item.entry.ts === null)) {
    ledger.firstUntimedDay = today;
  }
  for (const item of freshNorm) {
    const timed = item.entry.ts !== null;
    const day = timed ? localDate(new Date(item.entry.ts! * 1000)) : today;
    const data = ledger.days[day] ??= { timed: false, counts: Object.create(null) };
    data.timed ||= timed;
    for (const command of item.commands) {
      data.counts[command.cmdKey] = (Object.hasOwn(data.counts, command.cmdKey) ? data.counts[command.cmdKey]! : 0) + 1;
      if (command.subKey !== null) {
        data.counts[command.subKey] = (Object.hasOwn(data.counts, command.subKey) ? data.counts[command.subKey]! : 0) + 1;
      }
    }
  }
  const cutoff = dayNumber(today) - 120;
  for (const day of Object.keys(ledger.days)) {
    if (dayNumber(day) < cutoff) delete ledger.days[day];
  }
  return ledger;
}

export function computeTrends(ledger: Ledger, today: string): Profile["trends"] {
  const end = dayNumber(today);
  const counts = new Map<string, { recent: number; baseline: number }>();
  let countedDays = 0;
  let timedDays = 0;
  let earliestDay = end;
  for (const [day, data] of Object.entries(ledger.days)) {
    if (day === ledger.firstUntimedDay) continue;
    const age = end - dayNumber(day);
    if (age < 0) continue;
    earliestDay = Math.min(earliestDay, end - age);
    if (age >= 35 || !Object.values(data.counts).some((n) => n > 0)) continue;
    countedDays++;
    if (data.timed) timedDays++;
    for (const [key, n] of Object.entries(data.counts)) {
      const value = counts.get(key) ?? { recent: 0, baseline: 0 };
      if (age < 7) value.recent += n;
      else value.baseline += n;
      counts.set(key, value);
    }
  }
  if (countedDays < 10) return { available: false, reason: "collecting" };

  const rising: TrendItem[] = [];
  const falling: TrendItem[] = [];
  const added: TrendItem[] = [];
  for (const [c, { recent, baseline }] of counts) {
    const item: TrendItem = { c, recent, baseline };
    if (recent >= 5 && baseline > 0 && recent * 4 >= baseline * 2) rising.push(item);
    if (baseline >= 8 && recent * 4 <= baseline * 0.5) falling.push(item);
    if (baseline === 0 && recent >= 5 && end - earliestDay >= 14) added.push(item);
  }
  const rank = (items: TrendItem[]): TrendItem[] => items.sort((a, b) =>
    Math.abs(b.recent * 4 - b.baseline) - Math.abs(a.recent * 4 - a.baseline)
    || (a.c < b.c ? -1 : a.c > b.c ? 1 : 0)).slice(0, 5);
  return {
    available: true,
    basis: timedDays * 2 >= countedDays ? "timestamps" : "ingestion-days",
    recentDays: 7,
    baselineDays: 28,
    rising: rank(rising),
    falling: rank(falling),
    new: rank(added),
  };
}
