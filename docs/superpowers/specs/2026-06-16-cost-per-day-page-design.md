# Cost per project / branch / day page — design

- **Status:** approved (brainstorm), pending implementation plan
- **Date:** 2026-06-16
- **Topic:** a separate page showing cost + tokens broken down by project, branch, and day

## Summary

Add a **separate page** to the dashboard that shows historical spend as a flat,
sortable table — one row per `(project, branch, day)` with **cost** and **tokens**.
It complements (does not replace) the live `CostBreakdown` sidebar panel: the panel
is an at-a-glance live/all-time summary, this page is the deeper historical view you
navigate to.

- **Layout:** flat sortable table — columns `Project · Branch · Day · Cost · Tokens`.
  Click a header to sort by that column (toggle asc/desc).
- **Default window:** last **14 days**, with a range toggle (**7 / 14 / 30 / all**).
- **Navigation:** lightweight hash route `#/cost`, reached via a link in the
  dashboard header; a "← Dashboard" link returns. No router dependency.

## Background / feasibility

The data already exists. The `usage` table carries everything needed:

- `project TEXT`, `branch TEXT` — stamped at ingestion (merged `2f8dbed`).
- `cost_usd REAL`, the five token columns, and `at INTEGER` (epoch ms).
- Index `idx_usage_at` on `at` for time-ranged scans.

Pre-migration rows have `NULL` project/branch and bucket under `'unknown'`
(known limitation — see the cost-tracking status). Day bucketing uses the
**local** day to match the existing `startOfLocalDay` semantics.

## Architecture

Three thin units, each independently testable:

1. **`Store.costDaily(range?)`** (server) — the aggregation query.
2. **`GET /api/cost/daily`** (server) — pull endpoint exposing it.
3. **`CostDailyPage` + `useHashRoute`** (web) — the page and its routing.

### 1. `Store.costDaily(range?)`

```ts
costDaily(range?: { since?: number; until?: number }): {
  project: string;
  branch: string | null;
  day: string;       // "YYYY-MM-DD", local day
  costUsd: number;
  tokens: number;
}[]
```

SQL shape:

```sql
SELECT COALESCE(usage.project, 'unknown') AS project,
       usage.branch AS branch,
       strftime('%Y-%m-%d', at / 1000, 'unixepoch', 'localtime') AS day,
       SUM(cost_usd) AS cost,
       SUM(<TOKEN_SUM>) AS tokens
FROM usage <rangeClause>
GROUP BY usage.project, usage.branch, day
ORDER BY day DESC, cost DESC
```

- Reuses the existing module-level `TOKEN_SUM` and `rangeClause` helpers
  (`since` inclusive, `until` exclusive).
- `project` coalesced to `'unknown'`; `branch` stays `null` when absent.
- Grouping by `(project, branch, day)` keeps same-named branches distinct across
  repos, exactly like `costByBranch`.
- Default order is day desc then cost desc; final ordering is the client's job
  (sortable table), this is just a stable baseline.

### 2. `GET /api/cost/daily?since=<ms>&until=<ms>`

- Returns `{ rows: CostDailyRow[] }` via the existing `json(res, …)` helper.
- `since` / `until` are optional epoch-ms query params; absent ⇒ all-time.
- Lives alongside the other `/api/*` routes in `http.ts`. **Not** added to
  `buildState` / the SSE stream — this data is historical and unbounded in time,
  the wrong fit for a per-event live broadcast.

### 3. Web: routing + page

- **`useHashRoute()`** — a small hook returning the current `window.location.hash`
  route, subscribing to `hashchange`. `#/cost` ⇒ cost page; anything else ⇒ the
  existing dashboard. Navigation is plain `<a href="#/cost">` / `<a href="#/">`
  anchors (the hash updates the URL, the hook re-renders) — no dependency, no
  history manipulation.
- **`App`** switches on the route: `#/cost` → `<CostDailyPage />`, else
  `<Board state={state} />`. The SSE subscription stays for the dashboard;
  `CostDailyPage` fetches its own data.
- **`CostDailyPage`**:
  - Local state: selected window (`7 | 14 | 30 | "all"`, default 14), sort column +
    direction, fetched rows, loading/empty flags.
  - On mount and whenever the window changes: compute `since`/`until` from the
    window — `since` = local midnight `N−1` days ago (plain client-side `Date`
    math; for `"all"`, omit `since`), `until` omitted (⇒ up to now) — then
    `fetch('/api/cost/daily?…')` and store rows.
  - Renders the sortable table; click-header toggles sort; rows formatted with
    `formatUsd` / `formatTokens` and a new `formatDay("YYYY-MM-DD")` → `"Jun 16"`.
  - Empty state ("No usage in this window") and a header with the range toggle and
    a "← Dashboard" link.
- **Nav into the page**: a "Cost ↗" link in the dashboard `AppBar` pointing at
  `#/cost`.
- **`formatDay`** added to `src/web/cost.ts` next to the other formatters.

## Data flow

```
usage table ──Store.costDaily(range)──▶ GET /api/cost/daily ──fetch──▶ CostDailyPage
                                                                          │
                                          window toggle / sort ──────────┘ (client-side)
```

The dashboard's live SSE path is untouched.

## Error handling

- Endpoint: malformed `since`/`until` (non-numeric) are ignored (treated as
  absent) rather than erroring — a bad query param shouldn't 500.
- Page: a failed fetch shows an inline "couldn't load" state with a retry, never a
  blank/broken table. Empty result shows the empty state.
- Consistent with the recent skew fix: the page tolerates an empty/missing `rows`
  array without crashing.

## Testing (TDD)

- **`Store.costDaily`** (bun, in-memory DB): day-bucketing (two rows same local
  day merge; >24h apart split), `(project, branch, day)` grouping, range filter
  (since inclusive / until exclusive), `'unknown'` bucket, token sum, ordering.
  TZ pinned (e.g. `TZ=UTC`) so `'localtime'` day strings are deterministic.
- **`GET /api/cost/daily`** (bun, http): returns `{ rows }`; respects `since`/`until`;
  ignores malformed params.
- **`useHashRoute`** (vitest): returns route, updates on `hashchange`.
- **`CostDailyPage`** (vitest/testing-library, mocked `fetch`): renders rows, sort
  toggle reorders, range change refetches with new params, empty state, fetch-error
  state.

## Scope guards (YAGNI — explicitly out)

- No CSV/export, no charts/graphs, no per-model split on this page.
- No auto-refresh / SSE for this page (pull on mount + window change; add a manual
  refresh only if asked).
- No server-side sorting/pagination — windows are small (days), client sorts.

These are all easy to layer on later without reworking the above.
