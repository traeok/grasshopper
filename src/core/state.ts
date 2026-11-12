import { z } from "zod";
import { openDb, tx } from "./db.ts";
import { GhopError } from "./errors.ts";

const MetaSchemas = {
  installSalt: z.string().regex(/^[a-f0-9]{32}$/),
  consent: z.object({ granted: z.literal(true), at: z.string() }).strict().nullable(),
  lastSource: z.object({ shell: z.enum(["bash", "zsh", "powershell"]), file: z.string() }).strict().nullable(),
  lastAnalysisAt: z.string().nullable(),
  lastAnalysisId: z.string().nullable(),
  lastAnalysisError: z.string().nullable(),
  ledgerFirstUntimedDay: z.string().nullable(),
} as const;

export type Metadata = { [K in keyof typeof MetaSchemas]: z.infer<(typeof MetaSchemas)[K]> };
export type MetaKey = keyof Metadata;

const WatermarkSchema = z.object({
  tailHashes: z.array(z.string()),
  lastTs: z.number().int().nullable(),
}).strict();

export type Watermark = z.infer<typeof WatermarkSchema>;

/** The installation salt is generated once, even when two processes start together. */
export function getMeta<K extends MetaKey>(key: K): Metadata[K] {
  const db = openDb();
  let row = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key);
  if (!row && key === "installSalt") {
    row = tx(() => {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      const salt = Buffer.from(bytes).toString("hex");
      db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING")
        .run(key, JSON.stringify(salt));
      return db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key);
    });
  }
  try {
    return MetaSchemas[key].parse(row ? JSON.parse(row.value) : null) as Metadata[K];
  } catch {
    throw new GhopError(`Invalid stored metadata (${key}).`);
  }
}

export function setMeta<K extends MetaKey>(key: K, value: Metadata[K]): void {
  const parsed = MetaSchemas[key].safeParse(value);
  if (!parsed.success) throw new GhopError(`Invalid metadata (${key}).`);
  openDb().query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(parsed.data));
}

export function getWatermark(source: string): Watermark | undefined {
  const row = openDb().query<{ tail_hashes: string; last_ts: number | null }, [string]>(
    "SELECT tail_hashes, last_ts FROM watermarks WHERE source = ?",
  ).get(source);
  if (!row) return undefined;
  try {
    return WatermarkSchema.parse({ tailHashes: JSON.parse(row.tail_hashes), lastTs: row.last_ts });
  } catch {
    throw new GhopError("Invalid stored history watermark.");
  }
}

export function setWatermark(source: string, value: Watermark): void {
  const parsed = WatermarkSchema.safeParse(value);
  if (!parsed.success) throw new GhopError("Invalid history watermark.");
  openDb().query(`
    INSERT INTO watermarks (source, tail_hashes, last_ts) VALUES (?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET tail_hashes = excluded.tail_hashes, last_ts = excluded.last_ts
  `).run(source, JSON.stringify(parsed.data.tailHashes), parsed.data.lastTs);
}
