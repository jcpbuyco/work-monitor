import { existsSync } from "node:fs";
import type { Store } from "./store.ts";
import { tailUsage } from "./usage.ts";

export const REPRICE_MARKER = "reprice_5_series_done";

/** One-shot maintenance routine (spec §0b). `recordUsage()` is INSERT OR IGNORE
 *  on message_uuid, so a row inserted at the wrong price is never repriced in
 *  place — the only fix is delete-and-reingest.
 *
 *  All affected rows belong to ENDED sessions, which `sessionsToTail()` filters
 *  out, so step 5 (the in-process re-tail) is NOT optional: without it this is a
 *  pure deletion and the spend is lost. Steps 3–5 run in one transaction so a
 *  crash between the DELETE and the re-tail is impossible. */
export function repriceFiveSeries(
  store: Store,
  now: number
): { sessions: number; deleted: number; recorded: number } {
  const owners = store.db
    .query(
      `SELECT DISTINCT session_id FROM usage
       WHERE cost_usd = 0 AND model IN ('claude-opus-5', 'claude-sonnet-5')`
    )
    .all() as { session_id: string }[];

  // Drop any session whose transcript is gone — its rows are unrecoverable and
  // deleting them would lose token history for nothing.
  const kept: { id: string; path: string }[] = [];
  for (const { session_id } of owners) {
    const info = store.getTailInfo(session_id);
    if (!info?.transcript_path) continue;
    if (!existsSync(info.transcript_path)) continue;
    kept.push({ id: session_id, path: info.transcript_path });
  }

  if (kept.length === 0) {
    store.setMeta(REPRICE_MARKER, String(now));
    return { sessions: 0, deleted: 0, recorded: 0 };
  }

  const placeholders = kept.map((_, i) => `$s${i}`).join(", ");
  const params: Record<string, string> = {};
  kept.forEach((k, i) => (params[`$s${i}`] = k.id));

  let deleted = 0;
  let recorded = 0;
  store.db.transaction(() => {
    // The model filter is load-bearing: it leaves the `<synthetic>` $0.00 rows,
    // which are legitimately free, untouched.
    const res = store.db
      .query(
        `DELETE FROM usage
         WHERE cost_usd = 0 AND model IN ('claude-opus-5', 'claude-sonnet-5')
           AND session_id IN (${placeholders})`
      )
      .run(params);
    deleted = res.changes;
    for (const k of kept) {
      store.setUsageOffset(k.id, 0);
      if (tailUsage(store, { id: k.id, transcript_path: k.path, usage_offset: 0 })) recorded++;
    }
    store.setMeta(REPRICE_MARKER, String(now));
  })();

  return { sessions: kept.length, deleted, recorded };
}
