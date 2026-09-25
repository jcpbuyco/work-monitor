import type { Store } from "./store.ts";
import { costOf, type Tokens } from "./pricing.ts";

export const USAGE_ORPHAN_MERGE_MARKER = "usage_orphan_merge_v1";

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

/** One-time cleanup for the exact deploy boundary this feature (§2.2)
 *  introduces: a message whose earlier content-block line(s) were recorded by
 *  an OLDER server build -- before it ever computed `message_key` -- and whose
 *  LATER lines arrive after the restart, now correctly keyed, ends up as TWO
 *  rows for the one API message instead of one (double-priced). Every row that
 *  predates this deploy has `message_key IS NULL`; every message ingested
 *  going forward gets one from its very first line, so this situation can only
 *  ever exist across THIS one upgrade -- there is nothing for it to do on any
 *  later boot, which is why it is guarded by its own one-shot marker rather
 *  than running on every sweep tick.
 *
 *  For every still-unkeyed row, looks for EXACTLY ONE keyed row sharing its
 *  content key (session_id, agent_id, model, input/cache tokens -- the fields
 *  Claude Code repeats identically across a message's content-block lines).
 *  A match to more than one keyed row is left alone -- too ambiguous to merge
 *  safely, the same tolerance `dedupeHistoricUsage` accepts for its own
 *  content-key grouping. On a single match, the keyed row absorbs the larger
 *  `output_tokens` and its recomputed cost, keeps the earlier `at` of the two,
 *  and the orphan row is deleted.
 *
 *  Deliberately NOT run at the same startup instant as `dedupeHistoricUsage`:
 *  that pass runs before any new tailing has happened, so the "later,
 *  correctly-keyed" half of a split message does not exist yet. The caller
 *  schedules this once, after the first sweep has had a chance to record it. */
export function mergeOrphanMessageKeys(store: Store): { merged: number } {
  if (store.getMeta(USAGE_ORPHAN_MERGE_MARKER)) return { merged: 0 };

  const orphans = store.db
    .query(
      `SELECT message_uuid, session_id, agent_id, model, input_tokens, cache_read_tokens,
              cache_create_5m_tokens, cache_create_1h_tokens, output_tokens, at
       FROM usage WHERE message_key IS NULL`
    )
    .all() as Row[];

  let merged = 0;
  store.db.transaction(() => {
    if (orphans.length > 0) {
      const findKeyed = store.db.query(
        `SELECT message_uuid, output_tokens, at FROM usage
         WHERE message_key IS NOT NULL AND session_id = $s AND model = $m AND (agent_id IS $agent)
           AND input_tokens = $in AND cache_read_tokens = $cr
           AND cache_create_5m_tokens = $c5 AND cache_create_1h_tokens = $c1
         LIMIT 2`
      );
      const adopt = store.db.query(`UPDATE usage SET output_tokens = $out, at = $at, cost_usd = $cost WHERE message_uuid = $u`);
      const del = store.db.query(`DELETE FROM usage WHERE message_uuid = $u`);

      for (const o of orphans) {
        const matches = findKeyed.all({
          $s: o.session_id,
          $m: o.model,
          $agent: o.agent_id,
          $in: o.input_tokens,
          $cr: o.cache_read_tokens,
          $c5: o.cache_create_5m_tokens,
          $c1: o.cache_create_1h_tokens,
        }) as { message_uuid: string; output_tokens: number; at: number }[];
        if (matches.length !== 1) continue; // none, or too ambiguous -- leave alone

        const keeper = matches[0];
        const output = Math.max(keeper.output_tokens, o.output_tokens);
        const tokens: Tokens = {
          input: o.input_tokens,
          output,
          cache_read: o.cache_read_tokens,
          cache_create_5m: o.cache_create_5m_tokens,
          cache_create_1h: o.cache_create_1h_tokens,
        };
        adopt.run({ $out: output, $at: Math.min(keeper.at, o.at), $cost: costOf(o.model, tokens), $u: keeper.message_uuid });
        del.run({ $u: o.message_uuid });
        merged++;
      }
    }
    store.setMeta(USAGE_ORPHAN_MERGE_MARKER, "1");
  })();

  if (merged > 0) {
    store.bumpUsageVersion();
    console.log(`[usage-orphan-merge] merged ${merged} split message(s) from the message_key upgrade boundary`);
  }
  return { merged };
}
