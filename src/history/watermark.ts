import type { Watermark } from "../core/state.ts";
import type { HistoryEntry } from "./parse.ts";

export function computeFresh(
  entries: HistoryEntry[],
  wm: Watermark | undefined,
  salt: string,
): { fresh: HistoryEntry[]; next: Watermark } {
  const hashes = entries.map((entry) => new Bun.CryptoHasher("sha256")
    .update(salt + entry.text).digest("hex").slice(0, 16));
  let timed = 0;
  let lastTs: number | null = null;
  for (const entry of entries) {
    if (entry.ts === null) continue;
    timed++;
    lastTs = lastTs === null ? entry.ts : Math.max(lastTs, entry.ts);
  }
  const next: Watermark = { tailHashes: hashes.slice(-5), lastTs };
  if (!wm) return { fresh: entries.slice(), next };

  if (entries.length > 0 && timed * 2 >= entries.length) {
    const previousTs = wm.lastTs;
    return {
      fresh: previousTs === null
        ? entries.slice()
        : entries.filter((entry) => entry.ts !== null && entry.ts > previousTs),
      next,
    };
  }

  // Short histories have fewer than five tail hashes; they still overlap on the next read.
  const width = wm.tailHashes.length;
  if (width > 0 && width <= 5) {
    for (let end = hashes.length - 1; end >= width - 1; end--) {
      let matches = true;
      for (let offset = 0; offset < width; offset++) {
        if (hashes[end - width + 1 + offset] !== wm.tailHashes[offset]) {
          matches = false;
          break;
        }
      }
      if (matches) return { fresh: entries.slice(end + 1), next };
    }
  }
  return { fresh: entries.slice(), next };
}
