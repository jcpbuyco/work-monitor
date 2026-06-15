# Live cost tracking — design

- **Status:** approved (brainstorm), pending implementation plan
- **Date:** 2026-06-15
- **Topic:** per-session + board-level live cost on the dashboard

## Summary

Show what running Claude Code sessions are costing, live on the dashboard:

- a **per-session** cost + token line on each session card;
- a sidebar **SESSION COST** panel with a **live total** (across visible sessions), a **today** total (all sessions, resets at local midnight), and a **per-model** breakdown for today.

Cost is computed from each session's transcript JSONL (which agent-monitor already
tracks via `transcript_path`), priced with a small in-repo pricing map, stored
per assistant message in SQLite, and pushed over the existing SSE state feed.

## Background / feasibility

Each session row already stores `transcript_path`, and the file exists on disk.
Every assistant line in the transcript carries `message.model` and `message.usage`:

```jsonc
{
  "uuid": "…", "requestId": "…", "timestamp": "2026-06-15T…", "isSidechain": false,
  "message": {
    "model": "claude-opus-4-8",
    "usage": {
      "input_tokens": 8994,
      "output_tokens": 196,
      "cache_read_input_tokens": 15492,
      "cache_creation_input_tokens": 2299,
      "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 2299 },
      "iterations": [ /* per-iteration breakdown — already aggregated into the fields above */ ]
    }
  }
}
```

No `costUSD` field is present, so we compute cost from tokens × pricing. The
`uuid` is a stable dedup key; the `cache_creation` split lets us price 5-minute
vs 1-hour cache writes correctly. This is the same data ccusage reads — we just
scope it per session and feed it through our own SSE feed instead of a subprocess.

## Scope

**In:**

- Per-session lifetime cost + total token count on each session card.
- Sidebar panel: live total, today total, per-model (today) breakdown.
- Idempotent ingestion from transcripts, surviving server restarts.

**Out (future):**

- ccusage-style burn-rate / 5-hour-block projection panel.
- Historical charts / daily history beyond "today".
- `server_tool_use` (web search/fetch) pricing — ignored in v1.
- Real (billed) cost reconciliation — the figure is **API-equivalent**, notional
  for Pro/Max subscription users (labeled as such in the UI).

## Decisions (from brainstorming)

1. **Scope:** per-session cost + a board total panel.
2. **Total window:** both a **live** total (visible/non-ended sessions) and a
   **today** total (all sessions, local-midnight reset), with per-model breakdown.
3. **Approach:** per-message `usage` table fed by tailing transcripts
   (vs. cumulative-on-session-row, which can't do today/per-model; vs. shelling
   out to ccusage, which adds a subprocess + session-id mapping).
4. **Compute trigger:** on the `stop` / `session_end` hook events, plus a re-tail
   of each *working* session on the existing 60s sweep tick.
5. **Pricing:** a hand-maintained in-repo map with an unknown-model → `$0` + warn
   fallback.

## Architecture

### Data model (`db.ts` migration, `CREATE TABLE IF NOT EXISTS`)

```sql
CREATE TABLE IF NOT EXISTS usage (
  message_uuid    TEXT PRIMARY KEY,   -- transcript line uuid → dedup / idempotent re-reads
  session_id      TEXT NOT NULL,
  model           TEXT NOT NULL,
  input_tokens            INTEGER NOT NULL DEFAULT 0,
  output_tokens           INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_create_5m_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_create_1h_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL NOT NULL,
  at              INTEGER NOT NULL     -- epoch ms from the line's timestamp
);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_at ON usage(at);
```

Plus one idempotent column add on `sessions`:

```sql
ALTER TABLE sessions ADD COLUMN usage_offset INTEGER NOT NULL DEFAULT 0;
```

`usage_offset` is the byte offset of the transcript already parsed — a perf
optimization. Correctness comes from the `message_uuid` primary key (re-parsing
the same bytes is a no-op upsert), so the offset can be wrong without
double-counting. The migration follows the existing idempotent pattern (mirrors
the `sessions.branch` add and the todo-status migration), guarded so re-runs
don't throw.

### Pricing — `src/server/pricing.ts` (pure)

A map of model id → `{ input, output }` USD-per-MTok rates:

| Model | input | output |
|---|---|---|
| `claude-opus-4-8` / `4-7` / `4-6` / `4-5` | 5 | 25 |
| `claude-sonnet-4-6` / `4-5` | 3 | 15 |
| `claude-haiku-4-5` | 1 | 5 |
| `claude-fable-5` / `claude-mythos-5` | 10 | 50 |

Cache multipliers applied to the **input** rate: `cache_read ×0.1`,
`cache_create_5m ×1.25`, `cache_create_1h ×2.0`.

```
costOf(model, t) =
    (t.input            * inRate)
  + (t.output           * outRate)
  + (t.cache_read       * inRate * 0.10)
  + (t.cache_create_5m  * inRate * 1.25)
  + (t.cache_create_1h  * inRate * 2.00)
```
(rates divided by 1e6 to go from per-MTok to per-token.)

Unknown model → cost `0` and a one-time `console.warn` keyed by model id; the
panel never crashes on a model we haven't priced yet. `server_tool_use` request
counts are not priced in v1.

### Ingestion — `src/server/usage.ts`

- `parseUsageLine(line: string) → ParsedUsage | null` — **pure.** Parses one
  JSONL line; returns `{ uuid, model, tokens, at }` for assistant lines that have
  `message.usage`, else `null`. Reads the **top-level** `message.usage` fields
  (which already aggregate the `iterations` array — reading `iterations` too would
  double-count). Splits `cache_creation` into 5m/1h. Includes `isSidechain` /
  subagent turns (they cost money). Swallows malformed JSON → `null`.
- `tailUsage(store, session) → boolean` — reads the session's `transcript_path`
  from `usage_offset` to EOF, upserts each parsed line via
  `store.recordUsage(...)`, advances `usage_offset`. Returns whether anything was
  recorded. Edge handling:
  - file missing/unreadable → skip, log once, leave offset.
  - file shorter than offset (shrank/rotated) → reset offset to 0 and re-parse
    (PK dedup keeps totals correct).

**Triggers:**

- In the `/events` handler (`http.ts`), after `store.applyEvent` for `stop` and
  `session_end`, call `tailUsage(store, session)` before `pushState()`.
- In the 60s sweep (`index.ts`), tail every non-ended session each tick so a long
  in-flight turn's cost trickles in, then broadcast.

### Aggregation + state — `store.costSummary(midnightMs)`

One method runs all aggregations and is added to `buildState()`:

```ts
cost: {
  perSession: { [sessionId]: { costUsd: number; tokens: number } }, // session lifetime
  liveTotalUsd: number,    // Σ cost over non-ended sessions
  todayUsd: number,        // Σ cost WHERE at >= midnightMs (all sessions)
  byModelToday: { model: string; costUsd: number }[], // today, grouped, desc
}
```

`tokens` is the sum of all token types (for the "312K tok" display).
`midnightMs` = local midnight derived from the server `now()`, passed in so the
store query stays a simple `WHERE at >= $midnight`.

### State-broadcast unification (cleanup folded in)

Today the 60s sweep broadcasts a partial state via `onChange` (`{sessions,
todos}` only), while the request path uses the richer `buildState()`
(sessions/todos/activity/stats). Cost added to `buildState()` wouldn't reach the
dashboard on a sweep-driven update. Fix: make a single `buildState()` the only
source of broadcast payloads and have the sweep use it (drop the partial
`onChange` shape). This also retroactively fixes activity/stats not updating on
sweeps.

## UI

- **`SessionCard.tsx`** — a muted line under the status badge:
  `"$1.24 · 312K tok"`, from `state.cost.perSession[session.id]`. Rendered only
  when usage exists for that session (no `$0.00` noise on fresh sessions).
- **`CostPanel.tsx`** (new) — in the right sidebar directly below `ToolStats`.
  Plain-text header `"$ SESSION COST"` (no emoji — matches the 📊→Σ mono-font
  fix), with a small `API-equiv` tag (`title=` tooltip: notional API-equivalent
  cost; subscription users aren't billed per token). Rows: `live total`, `today`,
  then per-model (today) rows, currency-formatted.
- **`web/cost.ts`** (new) — `formatUsd($3.71)` and compact token formatter
  (`312K`, `1.2M`).
- **`web/types.ts`** — extend `State` with the `cost` shape above.
- **`Board.tsx`** — mount `CostPanel` in the sidebar.

## Edge cases

- Unknown model → `$0` + one-time warn.
- Non-usage lines (user / tool_result) → skipped (no `message.usage`).
- Malformed JSON line → skipped.
- Transcript missing/unreadable → skip + log, offset untouched.
- File shrank (offset > size) → reset offset, re-parse; PK dedup keeps totals correct.
- Re-tailing the same bytes → no double-count (PK on `message_uuid`).
- Existing sessions: `usage_offset` defaults 0 → full transcript backfills on the
  next trigger, so history appears immediately, not just go-forward.
- `today` cutoff = **local** midnight from server `now()`.

## Testing

- **Unit (pure):** `costOf()` — each token type incl. the three cache
  multipliers, and unknown-model → 0; `parseUsageLine()` — field extraction,
  `null` for non-usage/malformed lines, ignores the `iterations` sub-array.
- **Unit (store):** aggregations — `sessionCost`/`perSession`, `liveTotalUsd`
  excludes ended sessions, `todayUsd` respects the midnight cutoff,
  `byModelToday` grouping; inserting the same `message_uuid` twice counts once.
- **Unit (tail):** idempotency — tail the same content twice → no double-count,
  offset advances; shrink resets offset to 0.
- **Web:** `CostPanel` renders totals + model rows; `SessionCard` shows the cost
  line when usage exists, hides it when absent.

## Files touched

- `src/server/db.ts` — `usage` table + `sessions.usage_offset` migration.
- `src/server/pricing.ts` — **new**, pricing map + `costOf`.
- `src/server/usage.ts` — **new**, `parseUsageLine` + `tailUsage`.
- `src/server/store.ts` — `recordUsage` upsert + `costSummary`.
- `src/server/http.ts` — tail on `stop`/`session_end`; `buildState` includes cost; unify pushState.
- `src/server/index.ts` — sweep tails non-ended sessions + full-state broadcast.
- `src/server/types.ts` — server-side cost types.
- `src/web/types.ts` — `State.cost`.
- `src/web/cost.ts` — **new**, currency/token formatters.
- `src/web/components/CostPanel.tsx` — **new**.
- `src/web/components/SessionCard.tsx` — cost line.
- `src/web/components/Board.tsx` — mount the panel.
- Tests under `tests/` and `web-tests/`.

## Open questions / future work

- Burn-rate / 5-hour-block panel (ccusage `blocks --live` style).
- Daily history beyond "today" (the `usage` table already retains it — just needs
  a view).
- Pricing-map maintenance as models/prices change (the one thing a ccusage
  dependency would have handled for us).
