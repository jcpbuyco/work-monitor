import type { Store } from "./store.ts";
import { ensureMultiharnessBackup } from "./retention.ts";

export const USAGE_DEDUPE_MARKER = "usage_dedupe_v1";

interface Row {
  message_uuid: string;
  session_id: string;
  agent_id: string | null;
  model: string;
  input_tokens: number;
  cache_read_tokens: number;
  cache_create_5m_tokens: number;
  cache_create_1h_tokens: number;
  output_tokens: number;
  at: number;
}

/** All-time `cost_usd` total, ignoring NULL (unpriced) rows -- used only for
 *  the migration's before/after log line, so a real dollar delta is visible
 *  alongside the row counts (§2.2: "log before/after row counts and totals"). */
function totalCostUsd(store: Store): number {
  return (store.db.query(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM usage`).get() as { c: number }).c;
}

/** Content-based grouping key for one API message, for rows recorded BEFORE
 *  `message_key` existed (§2.2): `message.id`/`requestId` were never stored, so
 *  historic duplicates can only be found by the tokens Claude Code repeats
 *  identically across every content-block line of one message. Validated
 *  against real data: 30,296 groups vs 30,295 real message ids on the rows
 *  still on disk (2 collisions) -- good enough for a one-time cleanup pass,
 *  where `repriceIfNeeded` fixes up `cost_usd` afterward regardless. */
function groupKey(r: Row): string {
  return [r.session_id, r.agent_id ?? "", r.model, r.input_tokens, r.cache_read_tokens, r.cache_create_5m_tokens, r.cache_create_1h_tokens].join(
    "\u0000"
  );
}

/** One-time historic collapse migration (§2.2), run after the §1.4 backup.
 *  Also deletes legacy `model = '<synthetic>'` rows outright: §2.1 skips them
 *  before they ever reach a row for any NEW line, but historic rows recorded
 *  before that ingest-time guard existed are exactly the "no row" the spec
 *  describes, just late -- carrying them forward would permanently pollute
 *  `unpricedModels` with a synthetic, always-0-token, never-real entry.
 *
 *  Everything else groups every remaining pre-existing `usage` row on
 *  `(session_id, agent_id, model, input_tokens, cache_read_tokens,
 *  cache_create_5m_tokens, cache_create_1h_tokens)`, keeps the row with the
 *  smallest `at` (ties broken by uuid for determinism) with its
 *  `output_tokens` raised to the group's MAX, and deletes the rest of the
 *  group. `cost_usd` is intentionally left alone here -- `repriceIfNeeded`
 *  (§2.3) recomputes it from the now-correct tokens right after this runs, so
 *  there is no need to duplicate that pricing logic in this migration too.
 *
 *  Guarded by `app_meta.usage_dedupe_v1`; a no-op after the first successful
 *  run. Logs before/after row counts AND cost totals, per §2.2 -- the caller
 *  must not re-log the same event (a duplicate line was itself a past finding). */
export function dedupeHistoricUsage(
  store: Store,
  dbPath: string,
  now: number
): { before: number; after: number; deleted: number; groups: number; beforeCostUsd: number; afterCostUsd: number } {
  if (store.getMeta(USAGE_DEDUPE_MARKER)) {
    return { before: 0, after: 0, deleted: 0, groups: 0, beforeCostUsd: 0, afterCostUsd: 0 };
  }

  ensureMultiharnessBackup(store, dbPath, now);

  const beforeCostUsd = totalCostUsd(store);
  const rows = store.db
    .query(
      `SELECT message_uuid, session_id, agent_id, model, input_tokens, cache_read_tokens,
              cache_create_5m_tokens, cache_create_1h_tokens, output_tokens, at
       FROM usage`
    )
    .all() as Row[];
  const before = rows.length;

  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.model === "<synthetic>") continue; // deleted outright below, never grouped
    const key = groupKey(r);
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  let deleted = 0;
  let dupedGroups = 0;
  store.db.transaction(() => {
    deleted += store.db.query(`DELETE FROM usage WHERE model = '<synthetic>'`).run().changes;

    const bumpOutput = store.db.query(`UPDATE usage SET output_tokens = $out WHERE message_uuid = $u`);
    const del = store.db.query(`DELETE FROM usage WHERE message_uuid = $u`);
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      dupedGroups++;
      g.sort((a, b) => a.at - b.at || a.message_uuid.localeCompare(b.message_uuid));
      const keeper = g[0];
      const maxOutput = Math.max(...g.map((r) => r.output_tokens));
      if (maxOutput !== keeper.output_tokens) bumpOutput.run({ $out: maxOutput, $u: keeper.message_uuid });
      for (let i = 1; i < g.length; i++) {
        del.run({ $u: g[i].message_uuid });
        deleted++;
      }
    }
    store.setMeta(USAGE_DEDUPE_MARKER, String(now));
  })();

  if (deleted > 0) store.bumpUsageVersion();
  const after = before - deleted;
  const afterCostUsd = totalCostUsd(store);
  console.log(
    `[usage-dedupe] ${before} rows -> ${after} rows ($${beforeCostUsd.toFixed(2)} -> $${afterCostUsd.toFixed(2)}), ` +
      `${deleted} deleted across ${dupedGroups} duplicate groups`
  );
  return { before, after, deleted, groups: dupedGroups, beforeCostUsd, afterCostUsd };
}
