import type { Store } from "./store.ts";

export const EVENTS_COLUMNS_MARKER = "events_columns_v1";

/** JS-side fallback only runs over rows SQLite itself can't parse as JSON, in
 *  fixed-size batches -- see backfillEventsColumns. */
const BATCH_SIZE = 2000;

const TOOL_NAME_RE = /"tool_name"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const AGENT_ID_RE = /"agent_id"\s*:\s*"((?:[^"\\]|\\.)*)"/;

function unescapeJsonString(s: string): string {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
}

/** Best-effort field recovery from a payload that failed `JSON.parse` - real
 *  invalid rows on disk are historic ones truncated mid-string at the old
 *  8000-char cap, so `tool_name`/`agent_id` (early, short fields) usually
 *  survive intact even though the tail of the JSON does not. */
function extractFromInvalidJson(payload: string): { toolName: string | null; agentId: string | null } {
  const tool = payload.match(TOOL_NAME_RE);
  const agent = payload.match(AGENT_ID_RE);
  return {
    toolName: tool ? unescapeJsonString(tool[1]) : null,
    agentId: agent ? unescapeJsonString(agent[1]) : null,
  };
}

/** §1.2's own minimal harness classification, applied to the RAW stored text
 *  (valid or not) rather than a parsed object -- a plain substring check works
 *  for both cases and is exact for the one signal it looks for. On its own
 *  this is only a per-EVENT guess: real Cursor payloads put "cursor_version"
 *  near the END, after tool_input/tool_output, so the old 8000-char
 *  truncation regularly cut it off historic rows. `backfillEventsColumns`
 *  corrects for that afterward with a session-wide pass (see below) -- this
 *  function is deliberately not the last word on a row's harness. */
function detectHarnessFromRaw(payload: string): string {
  return payload.includes('"cursor_version"') ? "cursor" : "claude";
}

/** One-time backfill (guarded by `app_meta` key `events_columns_v1`): populate
 *  the new `events` columns (tool_name, duration_ms, agent_id, harness) added
 *  in §1.2 for every pre-existing row, then rebuild `tool_stats` from the
 *  now-populated columns in one `INSERT ... SELECT ... GROUP BY`. Safe to call
 *  on every startup - a no-op after the first successful run.
 *
 *  Valid-JSON rows are filled with a single SQL `UPDATE` (SQLite's own
 *  `json_valid`/`json_type`/`json_extract`), so their payload text never
 *  crosses into JS - loading every row with `.all()` and looping over them
 *  (the original approach) held the FULL `events` table, payloads included,
 *  in process memory at once (measured: ~2.1GB RSS on the 918MB production
 *  DB, transient but real). Only the minority that fails `json_valid`
 *  (truncated/otherwise-broken JSON - ~32k of 300k rows on that same DB) is
 *  walked in JS with the regex fallback, in fixed-size batches so even that
 *  path never materializes more than one batch at a time. */
export function backfillEventsColumns(store: Store, now: number): { updated: number } {
  if (store.getMeta(EVENTS_COLUMNS_MARKER)) return { updated: 0 };

  let updated = 0;
  store.db.transaction(() => {
    // Bulk path: every row SQLite itself can parse. `json_type` gates each
    // extracted field to the JSON type the original per-row JS `typeof` check
    // required (a number for duration_ms, a string for tool_name/agent_id) so
    // the two paths agree; harness reuses the exact substring rule
    // `detectHarnessFromRaw` uses below.
    updated += store.db
      .query(
        `UPDATE events
         SET tool_name = CASE WHEN json_type(payload, '$.tool_name') = 'text' THEN json_extract(payload, '$.tool_name') ELSE NULL END,
             duration_ms = CASE WHEN json_type(payload, '$.duration_ms') IN ('integer', 'real') THEN json_extract(payload, '$.duration_ms') ELSE NULL END,
             agent_id = CASE WHEN json_type(payload, '$.agent_id') = 'text' THEN json_extract(payload, '$.agent_id') ELSE NULL END,
             harness = CASE WHEN payload LIKE '%"cursor_version"%' THEN 'cursor' ELSE 'claude' END
         WHERE tool_name IS NULL AND duration_ms IS NULL AND agent_id IS NULL AND harness IS NULL
           AND json_valid(payload)`
      )
      .run().changes;

    // Fallback path: the remainder (payload is NULL, or json_valid() said no),
    // walked in JS batches so this never holds more than BATCH_SIZE rows.
    const update = store.db.query(
      `UPDATE events SET tool_name = $tool, agent_id = $agent, harness = $harness WHERE id = $id`
    );
    for (;;) {
      const rows = store.db
        .query(
          `SELECT id, payload FROM events
           WHERE tool_name IS NULL AND duration_ms IS NULL AND agent_id IS NULL AND harness IS NULL
           LIMIT $n`
        )
        .all({ $n: BATCH_SIZE }) as { id: number; payload: string | null }[];
      if (rows.length === 0) break;
      for (const r of rows) {
        const payload = r.payload ?? "";
        // duration_ms is a bare, unquoted number in the JSON, so it can't be
        // recovered reliably from a truncated tail -- it stays NULL
        // (unknown), never guessed.
        const rec = extractFromInvalidJson(payload);
        const harness = detectHarnessFromRaw(payload);
        update.run({ $tool: rec.toolName, $agent: rec.agentId, $harness: harness, $id: r.id });
        updated++;
      }
      if (rows.length < BATCH_SIZE) break;
    }

    // §1.2's harness rule (both paths above) looks at each row in isolation,
    // but a session's harness is a property of which CLI is running the
    // hooks, not of an individual event -- and real Cursor payloads put
    // "cursor_version" near the END, after tool_input/tool_output, which is
    // exactly the tail the old 8000-char truncation cut off on many historic
    // rows. Fix it at the SESSION level: if ANY event in a session was
    // recognized as cursor, every event in that session is. This also fixes
    // up the `tool_stats` rebuild below, since it reads the corrected column.
    store.db.exec(
      `UPDATE events SET harness = 'cursor'
       WHERE harness = 'claude'
         AND session_id IN (SELECT DISTINCT session_id FROM events WHERE harness = 'cursor')`
    );

    // Rebuild from scratch: tool_stats is new, so there is nothing to merge
    // into, and this only ever runs once (guarded by the marker below).
    store.db.exec("DELETE FROM tool_stats;");
    store.db.exec(
      `INSERT INTO tool_stats (harness, tool, calls, timed, total_ms)
       SELECT harness, tool_name AS tool,
              COUNT(*) AS calls,
              SUM(CASE WHEN duration_ms IS NOT NULL THEN 1 ELSE 0 END) AS timed,
              COALESCE(SUM(duration_ms), 0) AS total_ms
       FROM events
       WHERE type = 'activity' AND tool_name IS NOT NULL
       GROUP BY harness, tool_name`
    );

    store.setMeta(EVENTS_COLUMNS_MARKER, String(now));
  })();

  // Reclaim the WAL this full-table rewrite leaves behind. A checkpoint can't
  // run inside a transaction, so this is deliberately outside the one above;
  // best-effort since an in-memory DB (tests) has no WAL file to shrink.
  try {
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch {
    // nothing to checkpoint (e.g. :memory:) -- fine, this is cleanup, not correctness
  }

  return { updated };
}
