# Cost per project/branch/day page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a separate `#/cost` page showing a flat, sortable table of cost + tokens per `(project, branch, day)`, backed by a new aggregation and pull endpoint.

**Architecture:** A new `Store.costDaily()` SQL aggregation (local-day buckets) → a pull `GET /api/cost/daily` endpoint (not on the SSE stream) → a hash-routed `CostDailyPage` that fetches and renders a client-sorted table with a 7/14/30/all window toggle. Complements the existing live `CostBreakdown` sidebar panel.

**Tech Stack:** Bun + `bun:sqlite` (server), `bun test` (server tests); React 18 + Vite + Tailwind (web), Vitest + @testing-library/react (web tests).

**Spec:** `docs/superpowers/specs/2026-06-16-cost-per-day-page-design.md`

**Branch:** `feat/cost-per-day-page` (already created; spec committed as `e04222b`).

**Conventions to follow:**
- Reuse the module-level `TOKEN_SUM` const and `rangeClause()` helper in `src/server/store.ts` (added for `costByProject`/`costByBranch`).
- Server tests: in-memory DB via `new Store(openDb(":memory:"))`; `tok()` helper already in `tests/cost-store.test.ts`.
- Web pure logic + formatters live in `src/web/cost.ts`; hooks are `src/web/useX.ts`; components in `src/web/components/`.
- Run server tests with `bun test tests/`, web tests with `npx vitest run`, types with `bun run typecheck`.

---

### Task 1: `Store.costDaily()` aggregation

**Files:**
- Modify: `src/server/store.ts` (add method after `costByBranch`, ~line 330)
- Test: `tests/cost-store.test.ts` (append inside the existing `describe("Store usage rows", …)`)

- [ ] **Step 1: Write the failing tests**

Append these tests inside the existing `describe` block in `tests/cost-store.test.ts` (the `tok` helper and `store` `beforeEach` already exist there):

```ts
  it("groups cost + tokens by (project, branch, local day)", () => {
    store.applyEvent("a", { status: "working", project: "alpha", branch: "main", last_activity_at: 1 }, 1);
    const T = 1_700_000_000_000;
    const DAY = 24 * 3600 * 1000;
    // two rows on the SAME instant (same day) + one 26h later (a different
    // calendar day in ANY timezone, DST included).
    store.recordUsage({ uuid: "d1", sessionId: "a", model: "claude-opus-4-8", tokens: tok(10), at: T, cost: 1.0 });
    store.recordUsage({ uuid: "d2", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: T, cost: 2.0 });
    store.recordUsage({ uuid: "d3", sessionId: "a", model: "claude-opus-4-8", tokens: tok(5), at: T + 26 * 3600 * 1000, cost: 4.0 });

    const rows = store.costDaily();
    expect(rows.length).toBe(2); // two distinct local days for alpha·main
    for (const r of rows) {
      expect(r.project).toBe("alpha");
      expect(r.branch).toBe("main");
      expect(r.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const days = new Set(rows.map((r) => r.day));
    expect(days.size).toBe(2); // the two days differ
    const sameDay = rows.find((r) => r.costUsd === 3.0); // 1.0 + 2.0 merged
    expect(sameDay).toBeTruthy();
    expect(sameDay!.tokens).toBe(10);
  });

  it("costDaily filters by time range (since inclusive, until exclusive)", () => {
    store.applyEvent("a", { status: "working", project: "alpha", branch: "main", last_activity_at: 1 }, 1);
    const T = 1_700_000_000_000;
    store.recordUsage({ uuid: "r1", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: T, cost: 1.0 });
    store.recordUsage({ uuid: "r2", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: T + 26 * 3600 * 1000, cost: 2.0 });
    const rows = store.costDaily({ since: T + 1 }); // excludes r1
    expect(rows.length).toBe(1);
    expect(rows[0].costUsd).toBeCloseTo(2.0, 6);
  });

  it("costDaily buckets unattributed usage under 'unknown' and keeps null branch", () => {
    // usage for a session row that doesn't exist → project/branch stamp NULL
    store.recordUsage({ uuid: "g1", sessionId: "ghost", model: "claude-opus-4-8", tokens: tok(0), at: 1_700_000_000_000, cost: 1.0 });
    const rows = store.costDaily();
    expect(rows.length).toBe(1);
    expect(rows[0].project).toBe("unknown");
    expect(rows[0].branch).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/cost-store.test.ts`
Expected: FAIL — `store.costDaily is not a function`.

- [ ] **Step 3: Implement `costDaily`**

In `src/server/store.ts`, add this method immediately after the `costByBranch` method (it reuses the existing module-level `TOKEN_SUM` and `rangeClause`):

```ts
  /** Cost + tokens grouped by (project, branch, local day "YYYY-MM-DD"), newest
   *  day first. `range` filters on the message timestamp (since inclusive, until
   *  exclusive); omit for all-time. Unattributed usage buckets under 'unknown';
   *  branch stays null when absent. Client re-sorts as needed — this order is a
   *  stable baseline. */
  costDaily(
    range: { since?: number; until?: number } = {}
  ): { project: string; branch: string | null; day: string; costUsd: number; tokens: number }[] {
    const { where, params } = rangeClause(range);
    const rows = this.db
      .query(
        `SELECT COALESCE(usage.project, 'unknown') AS project, usage.branch AS branch,
                strftime('%Y-%m-%d', at / 1000, 'unixepoch', 'localtime') AS day,
                SUM(cost_usd) AS cost, SUM${TOKEN_SUM} AS tokens
         FROM usage ${where} GROUP BY usage.project, usage.branch, day ORDER BY day DESC, cost DESC`
      )
      .all(params) as { project: string; branch: string | null; day: string; cost: number; tokens: number }[];
    return rows.map((r) => ({ project: r.project, branch: r.branch, day: r.day, costUsd: r.cost, tokens: r.tokens }));
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cost-store.test.ts`
Expected: PASS (all, including the 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/server/store.ts tests/cost-store.test.ts
git commit -m "feat(usage): costDaily aggregation (project/branch/day)"
```

---

### Task 2: `GET /api/cost/daily` endpoint

**Files:**
- Modify: `src/server/http.ts` (add a route block right after the `/api/state` block, ~line 139)
- Test: `tests/http.test.ts` (append a new `describe`)

- [ ] **Step 1: Write the failing tests**

Append to `tests/http.test.ts` (the `store` and `base` are set up in the top-level `beforeEach`):

```ts
describe("GET /api/cost/daily", () => {
  it("returns per-project/branch/day rows and respects since", async () => {
    store.applyEvent("a", { status: "working", project: "alpha", branch: "main", last_activity_at: 1 }, 1);
    const T = 1_700_000_000_000;
    const z = { input: 0, output: 0, cache_read: 0, cache_create_5m: 0, cache_create_1h: 0 };
    store.recordUsage({ uuid: "u1", sessionId: "a", model: "claude-opus-4-8", tokens: z, at: T, cost: 1.0 });
    store.recordUsage({ uuid: "u2", sessionId: "a", model: "claude-opus-4-8", tokens: z, at: T + 26 * 3600 * 1000, cost: 2.0 });

    const all = (await (await fetch(`${base}/api/cost/daily`)).json()) as any;
    expect(all.rows.length).toBe(2);
    expect(all.rows[0]).toHaveProperty("day");
    expect(all.rows[0]).toHaveProperty("costUsd");

    const ranged = (await (await fetch(`${base}/api/cost/daily?since=${T + 1}`)).json()) as any;
    expect(ranged.rows.length).toBe(1);
    expect(ranged.rows[0].costUsd).toBeCloseTo(2.0, 6);
  });

  it("ignores malformed since/until rather than erroring", async () => {
    const res = await fetch(`${base}/api/cost/daily?since=abc&until=xyz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.rows)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/http.test.ts`
Expected: FAIL — `/api/cost/daily` falls through to the 404 handler, so `body.rows` is undefined (`.length` of undefined / `Array.isArray` false).

- [ ] **Step 3: Implement the route**

In `src/server/http.ts`, add this block immediately after the `/api/state` route block (after its closing `}`):

```ts
      // --- daily cost breakdown (project/branch/day); pull, not streamed ---
      if (method === "GET" && path === "/api/cost/daily") {
        const num = (v: string | null): number | undefined => {
          const n = v == null ? NaN : Number(v);
          return Number.isFinite(n) ? n : undefined;
        };
        const rows = store.costDaily({
          since: num(url.searchParams.get("since")),
          until: num(url.searchParams.get("until")),
        });
        json(res, 200, { rows });
        return;
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/http.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/http.ts tests/http.test.ts
git commit -m "feat(server): GET /api/cost/daily pull endpoint"
```

---

### Task 3: web formatters — `formatDay` + `costDailyRange`

**Files:**
- Modify: `src/web/cost.ts`
- Test: `web-tests/cost.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `web-tests/cost.test.ts` (add `formatDay, costDailyRange` to the existing import from `../src/web/cost.ts`):

```ts
describe("formatDay", () => {
  it("formats an ISO day as 'Mon D'", () => {
    expect(formatDay("2026-06-16")).toBe("Jun 16");
    expect(formatDay("2026-01-01")).toBe("Jan 1");
  });
  it("returns the input unchanged when not an ISO day", () => {
    expect(formatDay("nope")).toBe("nope");
  });
});

describe("costDailyRange", () => {
  it("7-day window starts at local midnight 6 days before today", () => {
    const now = new Date(2026, 5, 16, 13, 30).getTime(); // local Jun 16 13:30
    const expected = new Date(2026, 5, 10, 0, 0, 0, 0).getTime(); // local Jun 10 00:00
    expect(costDailyRange(7, now).since).toBe(expected);
  });
  it("'all' has no lower bound", () => {
    expect(costDailyRange("all", now())).toEqual({});
  });
});
```

(If `now` isn't already imported in that file, use `Date.now()` instead of `now()` in the `'all'` test.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run web-tests/cost.test.ts`
Expected: FAIL — `formatDay`/`costDailyRange` are not exported.

- [ ] **Step 3: Implement the helpers**

Append to `src/web/cost.ts`:

```ts
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-06-16" → "Jun 16". Returns the input unchanged if it isn't an ISO day. */
export function formatDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

export type CostWindow = 7 | 14 | 30 | "all";

/** `since` epoch-ms for a window: local midnight (N-1) days before `nowMs`.
 *  "all" → no lower bound. `until` is always left open (up to now). */
export function costDailyRange(window: CostWindow, nowMs: number): { since?: number } {
  if (window === "all") return {};
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (window - 1));
  return { since: d.getTime() };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run web-tests/cost.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/cost.ts web-tests/cost.test.ts
git commit -m "feat(web): formatDay + costDailyRange helpers"
```

---

### Task 4: `useHashRoute` hook

**Files:**
- Create: `src/web/useHashRoute.ts`
- Test: `web-tests/useHashRoute.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web-tests/useHashRoute.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useHashRoute } from "../src/web/useHashRoute.ts";

beforeEach(() => {
  window.location.hash = "";
});

describe("useHashRoute", () => {
  it("defaults to '#/' when there is no hash", () => {
    const { result } = renderHook(() => useHashRoute());
    expect(result.current).toBe("#/");
  });

  it("updates when the hash changes", () => {
    const { result } = renderHook(() => useHashRoute());
    act(() => {
      window.location.hash = "#/cost";
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(result.current).toBe("#/cost");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web-tests/useHashRoute.test.ts`
Expected: FAIL — cannot resolve `../src/web/useHashRoute.ts`.

- [ ] **Step 3: Implement the hook**

Create `src/web/useHashRoute.ts`:

```ts
import { useEffect, useState } from "react";

/** Current location hash (e.g. "#/cost"), updated on `hashchange`.
 *  An empty hash normalizes to "#/". */
export function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash || "#/");
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run web-tests/useHashRoute.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/useHashRoute.ts web-tests/useHashRoute.test.ts
git commit -m "feat(web): useHashRoute hook"
```

---

### Task 5: `CostDailyPage` component

**Files:**
- Create: `src/web/components/CostDailyPage.tsx`
- Test: `web-tests/CostDailyPage.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `web-tests/CostDailyPage.test.tsx`:

```tsx
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { CostDailyPage } from "../src/web/components/CostDailyPage.tsx";

const ROWS = [
  { project: "alpha", branch: "main", day: "2026-06-16", costUsd: 2.0, tokens: 100 },
  { project: "beta", branch: null, day: "2026-06-15", costUsd: 9.0, tokens: 900 },
];

function mockFetch(rows: unknown) {
  const fn = vi.fn().mockResolvedValue({ json: async () => ({ rows }) });
  // @ts-expect-error test stub
  global.fetch = fn;
  return fn;
}

afterEach(cleanup);
beforeEach(() => vi.restoreAllMocks());

describe("CostDailyPage", () => {
  it("fetches and renders rows with formatted cost, day and tokens", async () => {
    mockFetch(ROWS);
    render(<CostDailyPage />);
    expect(await screen.findByText("alpha")).toBeTruthy();
    expect(screen.getByText("beta")).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1); // null branch → dash cell
    expect(screen.getByText("$9.00")).toBeTruthy();
    expect(screen.getByText("Jun 16")).toBeTruthy();
  });

  it("sorts by cost descending when the Cost header is clicked", async () => {
    mockFetch(ROWS);
    render(<CostDailyPage />);
    await screen.findByText("alpha");
    fireEvent.click(screen.getByRole("button", { name: /cost/i }));
    const rows = screen.getAllByRole("row"); // [header, ...data]
    expect(within(rows[1]).getByText("$9.00")).toBeTruthy(); // beta (9.0) now first
  });

  it("refetches with the window's since param when the range changes", async () => {
    const fn = mockFetch(ROWS);
    render(<CostDailyPage />);
    await screen.findByText("alpha");
    expect(String(fn.mock.calls[0][0])).toContain("since="); // default 14d
    fireEvent.click(screen.getByRole("button", { name: /^all$/i }));
    expect(String(fn.mock.calls.at(-1)![0])).not.toContain("since="); // all → no bound
  });

  it("shows an empty state when there is no usage", async () => {
    mockFetch([]);
    render(<CostDailyPage />);
    expect(await screen.findByText(/no usage/i)).toBeTruthy();
  });

  it("shows an error state when the fetch fails", async () => {
    // @ts-expect-error test stub
    global.fetch = vi.fn().mockRejectedValue(new Error("boom"));
    render(<CostDailyPage />);
    expect(await screen.findByText(/couldn.t load/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run web-tests/CostDailyPage.test.tsx`
Expected: FAIL — cannot resolve `../src/web/components/CostDailyPage.tsx`.

- [ ] **Step 3: Implement the page**

Create `src/web/components/CostDailyPage.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import { formatUsd, formatTokens, formatDay, costDailyRange, type CostWindow } from "../cost.ts";

interface Row {
  project: string;
  branch: string | null;
  day: string;
  costUsd: number;
  tokens: number;
}
type SortKey = "project" | "branch" | "day" | "costUsd" | "tokens";

const WINDOWS: CostWindow[] = [7, 14, 30, "all"];
const COLS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "project", label: "Project", numeric: false },
  { key: "branch", label: "Branch", numeric: false },
  { key: "day", label: "Day", numeric: false },
  { key: "costUsd", label: "Cost", numeric: true },
  { key: "tokens", label: "Tokens", numeric: true },
];

export function CostDailyPage() {
  const [window, setWindow] = useState<CostWindow>(14);
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "day", dir: "desc" });

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    const { since } = costDailyRange(window, Date.now());
    const qs = since != null ? `?since=${since}` : "";
    fetch(`/api/cost/daily${qs}`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        setRows(Array.isArray(body?.rows) ? (body.rows as Row[]) : []);
        setStatus("ok");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [window]);

  const sorted = useMemo(() => {
    const copy = [...rows];
    const { key, dir } = sort;
    copy.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      let c: number;
      if (typeof av === "number" && typeof bv === "number") c = av - bv;
      else c = String(av ?? "").localeCompare(String(bv ?? ""));
      return dir === "asc" ? c : -c;
    });
    return copy;
  }, [rows, sort]);

  const toggleSort = (col: { key: SortKey; numeric: boolean }) =>
    setSort((s) =>
      s.key === col.key
        ? { key: col.key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key: col.key, dir: col.numeric ? "desc" : "asc" }
    );

  return (
    <div className="mx-auto max-w-5xl px-4 pb-12">
      <header className="sticky top-0 z-10 -mx-4 mb-4 flex flex-wrap items-center gap-3 border-b border-border bg-background/85 px-4 py-3 backdrop-blur">
        <a href="#/" className="text-sm text-muted-foreground transition hover:text-foreground">
          ← Dashboard
        </a>
        <span className="font-semibold tracking-tight text-foreground">Cost by day</span>
        <div className="ml-auto inline-flex h-9 items-center overflow-hidden rounded-lg border border-border bg-muted text-sm text-muted-foreground">
          {WINDOWS.map((w) => (
            <button
              key={String(w)}
              type="button"
              onClick={() => setWindow(w)}
              className={`flex h-full items-center px-3 leading-none transition hover:text-foreground ${
                window === w ? "bg-chip text-foreground" : ""
              }`}
            >
              {w === "all" ? "All" : `${w}d`}
            </button>
          ))}
        </div>
      </header>

      {status === "error" ? (
        <p className="px-2 py-8 text-center text-sm text-muted-foreground">Couldn’t load cost data.</p>
      ) : status === "ok" && sorted.length === 0 ? (
        <p className="px-2 py-8 text-center text-sm text-muted-foreground">No usage in this window.</p>
      ) : (
        <table className="w-full border-collapse font-mono text-2xs">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              {COLS.map((c) => (
                <th
                  key={c.key}
                  aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                  className={`px-2 py-1.5 font-semibold ${c.numeric ? "text-right" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(c)}
                    className="inline-flex items-center gap-1 uppercase tracking-wider transition hover:text-foreground"
                  >
                    {c.label}
                    {sort.key === c.key && <span aria-hidden="true">{sort.dir === "asc" ? "▲" : "▼"}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={`${r.project}/${r.branch}/${r.day}/${i}`} className="border-b border-border/50">
                <td className="px-2 py-1 font-semibold text-foreground">{r.project}</td>
                <td className="px-2 py-1 text-muted-foreground">{r.branch ?? "—"}</td>
                <td className="px-2 py-1 text-muted-foreground">{formatDay(r.day)}</td>
                <td className="px-2 py-1 text-right tabular-nums text-foreground">{formatUsd(r.costUsd)}</td>
                <td className="px-2 py-1 text-right tabular-nums text-muted-foreground/70">{formatTokens(r.tokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run web-tests/CostDailyPage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/components/CostDailyPage.tsx web-tests/CostDailyPage.test.tsx
git commit -m "feat(web): CostDailyPage sortable per-day table"
```

---

### Task 6: wire routing into `App` + nav link in `AppBar`

**Files:**
- Modify: `src/web/App.tsx`
- Modify: `src/web/components/AppBar.tsx`
- Test: `web-tests/App.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `web-tests/App.test.tsx`:

```tsx
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const EMPTY_STATE = {
  sessions: [], todos: [], activity: [], stats: [],
  cost: { perSession: {}, liveTotalUsd: 0, todayUsd: 0, byModelToday: [], byProject: [], byBranch: [] },
};

vi.mock("../src/web/api.ts", () => ({
  fetchState: () => Promise.resolve(EMPTY_STATE),
  subscribe: () => () => {},
}));

afterEach(cleanup);
beforeEach(() => {
  // @ts-expect-error test stub
  global.fetch = vi.fn().mockResolvedValue({ json: async () => ({ rows: [] }) });
});

describe("App routing", () => {
  it("renders the cost page at #/cost", async () => {
    window.location.hash = "#/cost";
    const App = (await import("../src/web/App.tsx")).default;
    render(<App />);
    expect(await screen.findByText("Cost by day")).toBeTruthy();
  });

  it("renders the dashboard otherwise", async () => {
    window.location.hash = "#/";
    const App = (await import("../src/web/App.tsx")).default;
    render(<App />);
    expect(await screen.findByText("agent-monitor")).toBeTruthy(); // AppBar title
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web-tests/App.test.tsx`
Expected: FAIL — at `#/cost`, App still renders `<Board>`, so "Cost by day" is absent.

- [ ] **Step 3: Wire the route + nav link**

In `src/web/App.tsx`, add the imports and switch on the route. Replace the import of `Board` region and the final `return`:

```tsx
import { useEffect, useRef, useState } from "react";
import { fetchState, subscribe } from "./api.ts";
import type { State } from "./types.ts";
import { runViewTransition } from "./viewTransition.ts";
import { useHashRoute } from "./useHashRoute.ts";
import { Board } from "./components/Board.tsx";
import { CostDailyPage } from "./components/CostDailyPage.tsx";
```

…and change the final `return` line to:

```tsx
  const route = useHashRoute();
  return route === "#/cost" ? <CostDailyPage /> : <Board state={state} />;
```

(Place `const route = useHashRoute();` with the other hook calls, above the `return`.)

In `src/web/components/AppBar.tsx`, add a "Cost" link as the first child of the `ml-auto` controls `<div>` (immediately before the text-size control group):

```tsx
        <a
          href="#/cost"
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-muted px-3 text-sm leading-none text-muted-foreground transition hover:text-foreground"
        >
          <span aria-hidden="true">$</span>
          <span>Cost</span>
        </a>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run web-tests/App.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/App.tsx src/web/components/AppBar.tsx web-tests/App.test.tsx
git commit -m "feat(web): hash route to CostDailyPage + AppBar nav link"
```

---

### Task 7: full verification, build, ship

**Files:** none (verification only)

- [ ] **Step 1: Run the full suites + typecheck**

Run:
```bash
bun test tests/ && npx vitest run && bun run typecheck
```
Expected: all server tests pass, all web tests pass, typecheck clean (both `tsconfig.json` and `tsconfig.web.json`).

- [ ] **Step 2: Build the web bundle**

Run: `bun run web:build`
Expected: build succeeds; note the new `dist/web/assets/index-*.js` hash.

- [ ] **Step 3: Restart the server so it serves the new endpoint + bundle**

The running daemon predates the new route. Run:
```bash
systemctl --user restart am-server.service
```
Then verify the endpoint:
```bash
curl -s "http://localhost:4317/api/cost/daily?since=0" | head -c 300
```
Expected: a JSON object `{"rows":[...]}` (pre-migration usage rows appear under `project: "unknown"`).

- [ ] **Step 4: Commit any build artifacts if tracked**

`dist/` is gitignored — nothing to commit. Confirm with `git status` (should be clean).

---

## Self-Review

**Spec coverage:**
- Flat sortable table (Project·Branch·Day·Cost·Tokens, click-to-sort) → Task 5. ✓
- Default 14-day window + 7/14/30/all toggle → Task 5 (`WINDOWS`, default `useState(14)`) + Task 3 (`costDailyRange`). ✓
- `Store.costDaily` local-day buckets, `(project,branch,day)` grouping, range filter, `unknown` bucket → Task 1. ✓
- `GET /api/cost/daily` pull endpoint, malformed-param tolerance, not on SSE → Task 2. ✓
- `useHashRoute` + `#/cost` switch + nav links → Tasks 4, 6. ✓
- `formatDay` → Task 3. ✓
- Complements (doesn't replace) `CostBreakdown` → nothing removed; Board untouched. ✓
- Error/empty states, tolerant of missing `rows` → Task 5 (`status` states, `Array.isArray` guard). ✓
- Testing per unit → each task is TDD. ✓

**Placeholder scan:** none — every code step contains full content.

**Type consistency:** `CostWindow` (`7|14|30|"all"`) defined in Task 3, consumed in Task 5. `costDaily` row shape `{project,branch,day,costUsd,tokens}` consistent across Tasks 1/2/5. `useHashRoute(): string` returns `"#/cost"`/`"#/"`, matched in Task 6. `costDailyRange(window, nowMs) → {since?}` used identically in Tasks 3 and 5.
