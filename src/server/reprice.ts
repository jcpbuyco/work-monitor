import type { Store } from "./store.ts";
import { costOf, RATES_VERSION, type Tokens } from "./pricing.ts";

export const RATES_VERSION_META_KEY = "rates_version";

/** Generic repricing (§2.3). Every stored `usage` row keeps its raw tokens and
 *  model, so a rate change never needs the old delete-and-re-tail dance this
 *  module used to do (that hardcoded exactly `claude-opus-5`/`claude-sonnet-5`
 *  and required a transcript to still be on disk to recover the spend) --
 *  a plain `UPDATE ... SET cost_usd` from the stored tokens is enough, for
 *  every model, every time the rate table changes.
 *
 *  Runs once per rate-table change: `app_meta.rates_version` is compared
 *  against `RATES_VERSION` (a hash of the table, so no one has to remember to
 *  bump a version number by hand). A mismatch reprices EVERY row in one
 *  transaction, then stores the new version so a restart with unchanged rates
 *  is a no-op. `costOf` returning null (an unpriced model) writes cost_usd
 *  back to NULL -- which is exactly the point of §2.3's nullable column: an
 *  unpriced row is never left silently costed at a stale price, or at $0. */
export function repriceIfNeeded(store: Store, now: number): { updated: number; version: string } | null {
  if (store.getMeta(RATES_VERSION_META_KEY) === RATES_VERSION) return null;

  let updated = 0;
  store.db.transaction(() => {
    const rows = store.db
      .query(
        `SELECT message_uuid, model, input_tokens, output_tokens, cache_read_tokens,
                cache_create_5m_tokens, cache_create_1h_tokens
         FROM usage`
      )
      .all() as {
      message_uuid: string;
      model: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_create_5m_tokens: number;
      cache_create_1h_tokens: number;
    }[];
    const update = store.db.query(`UPDATE usage SET cost_usd = $cost WHERE message_uuid = $u`);
    for (const r of rows) {
      const tokens: Tokens = {
        input: r.input_tokens,
        output: r.output_tokens,
        cache_read: r.cache_read_tokens,
        cache_create_5m: r.cache_create_5m_tokens,
        cache_create_1h: r.cache_create_1h_tokens,
      };
      update.run({ $cost: costOf(r.model, tokens), $u: r.message_uuid });
      updated++;
    }
    store.setMeta(RATES_VERSION_META_KEY, RATES_VERSION);
  })();
  // A rate-table change with an EMPTY usage table still writes the marker
  // above (so it never re-scans on the next boot), but there is nothing
  // usage-derived to invalidate.
  if (updated > 0) store.bumpUsageVersion();
  return { updated, version: RATES_VERSION };
}
