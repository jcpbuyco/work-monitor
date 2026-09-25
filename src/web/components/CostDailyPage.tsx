import { Fragment, useMemo, useEffect, useState } from "react";
import { formatUsd, formatTokens, formatDay, costDailyRange, type CostWindow } from "../cost.ts";
import { groupByDay } from "../groupByDay.ts";
import { useMediaQuery } from "../useMediaQuery.ts";
import { Segmented, Skeleton, DownCaret } from "./primitives.tsx";
import { HarnessMark } from "./HarnessMark.tsx";
import { AppBar } from "./AppBar.tsx";
import { HARNESSES, harnessLabel, isHarness, type Harness } from "../../shared/harness.ts";
import type { State, LiveWorkflow } from "../types.ts";

const EMPTY_STATE: State = {
  sessions: [], todos: [], activity: [], stats: [],
  cost: { perSession: {}, liveTotalUsd: 0, todayUsd: 0, byModelToday: [], byProject: [], byBranch: [] },
};

interface Row {
  project: string;
  branch: string | null;
  day: string;
  /** null when every usage row that day is unpriced -- never a fabricated
   *  $0.00 (server: store.ts §2.3). */
  costUsd: number | null;
  tokens: number;
  /** §5.3, finding fix: the token total of just the UNPRICED slice of this
   *  row (server: store.ts's `UNPRICED_TOKEN_SUM`). A row can be PARTIALLY
   *  unpriced -- some usage from a priced model, some from one the pricing
   *  table doesn't know yet -- in which case `costUsd` is a real number that
   *  nonetheless understates the row's true spend. Optional/defaults to 0
   *  for the same restart-skew reason `harness` below is optional. */
  unpricedTokens?: number;
  /** §5.3: absent on a row from a server that predates it (restart-skew
   *  gotcha, same convention as every other optional field) -- reads as
   *  "claude", the same default `usage.harness IS NULL` itself gets. */
  harness?: Harness | string;
}
type SortKey = "project" | "branch" | "costUsd" | "tokens";

const WINDOWS: CostWindow[] = [7, 14, 30, "all"];
const COLS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "project", label: "Project", numeric: false },
  { key: "branch", label: "Branch", numeric: false },
  { key: "costUsd", label: "Cost", numeric: true },
  { key: "tokens", label: "Tokens", numeric: true },
];

/** Sums a day-group's cost, null-aware: null only when EVERY row in the group
 *  is itself unpriced (never a fabricated $0.00 mixing priced and unpriced
 *  rows -- an unpriced row simply doesn't add to the total, same convention
 *  as WorkflowsPage's totals row). */
function sumCost(rows: Row[]): number | null {
  const priced = rows.filter((r) => r.costUsd != null);
  if (priced.length === 0) return null;
  return priced.reduce((s, r) => s + r.costUsd!, 0);
}

function sumTokens(rows: Row[]): number {
  return rows.reduce((s, r) => s + r.tokens, 0);
}

function sumUnpriced(rows: Row[]): number {
  return rows.reduce((s, r) => s + (r.unpricedTokens ?? 0), 0);
}

/** §5.3, ui.md P0-1, finding fix: the priced/partial/unpriced cell text for
 *  one row, one day's subtotal, or the whole window total -- same "$x.xx+"
 *  convention SessionCard's own cost cell already uses for a session that
 *  mixes priced and unpriced usage. `costUsd === null` means EVERY row in
 *  the group was unpriced; a non-null `costUsd` alongside `unpricedTokens >
 *  0` means the group is a PARTIAL mix, which used to render as a plain
 *  dollar figure with no signal that it understated the true spend. */
function costCell(costUsd: number | null, unpricedTokens: number): { text: string; title?: string } {
  if (costUsd == null) return { text: formatUsd(null) };
  if (unpricedTokens > 0) return { text: `${formatUsd(costUsd)}+`, title: "some usage from unpriced models" };
  return { text: formatUsd(costUsd) };
}

function SkeletonTable() {
  return (
    <table className="w-full border-collapse font-mono text-xs" aria-hidden="true">
      <tbody>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <tr key={i} className="h-8 border-b border-border-weak">
            <td className="px-2 py-[0.3125rem]" colSpan={COLS.length + 1}>
              <Skeleton w={i % 2 === 0 ? "w-2/3" : "w-1/2"} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SkeletonCards() {
  return (
    <div className="space-y-2" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-1.5 rounded-md border-hairline border-border-weak p-3">
          <Skeleton w="w-2/3" />
          <Skeleton w="w-1/2" />
        </div>
      ))}
    </div>
  );
}

/** §5.3: `state`/`workflows`/`ready`/`connected`/`lastMessageAt` feed the
 *  shared AppBar (a single App-level fetch/SSE subscription - this page never
 *  opens its own). All optional with safe defaults so this page stays
 *  independently renderable (every existing test mounts it bare, with no App
 *  around it). */
export function CostDailyPage({
  state = EMPTY_STATE,
  workflows = [],
  ready = true,
  connected = true,
  lastMessageAt = null,
}: {
  state?: State;
  workflows?: LiveWorkflow[];
  ready?: boolean;
  connected?: boolean;
  lastMessageAt?: number | null;
} = {}) {
  const [range, setRange] = useState<CostWindow>(14);
  const [harness, setHarness] = useState<"" | Harness>("");
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "project", dir: "asc" });
  // §5.3: "tables become stacked cards below md" -- one layout renders at a
  // time (see useMediaQuery's doc for why not a CSS-hidden pair).
  const isMobile = useMediaQuery("(max-width: 767px)");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    const { since } = costDailyRange(range, Date.now());
    const params = new URLSearchParams();
    if (since != null) params.set("since", String(since));
    if (harness) params.set("harness", harness);
    const qs = params.toString();
    fetch(`/api/cost/daily${qs ? `?${qs}` : ""}`)
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
  }, [range, harness]);

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

  // §5.3 day grouping: always newest-day-first -- there is no longer a
  // separate "Day" sort column (the group header IS the day), so Project/
  // Branch/Cost/Tokens sort WITHIN a day rather than across the whole window.
  const dayGroups = useMemo(() => groupByDay(sorted, (r) => r.day, false), [sorted]);

  // §5.3: "window total in the header" -- the whole loaded window, not a
  // per-day figure.
  const windowTotal = useMemo(
    () => ({ cost: sumCost(rows), tokens: sumTokens(rows), unpricedTokens: sumUnpriced(rows) }),
    [rows]
  );

  const toggleSort = (col: { key: SortKey; numeric: boolean }) =>
    setSort((s) =>
      s.key === col.key
        ? { key: col.key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key: col.key, dir: col.numeric ? "desc" : "asc" }
    );

  return (
    <div className="mx-auto max-w-page px-3 pb-16 sm:px-6">
      <AppBar
        state={state}
        workflows={workflows}
        ready={ready}
        route="#/cost"
        connected={connected}
        lastMessageAt={lastMessageAt}
      />
      {/* §5.2: the page's own slim toolbar, right under the shared AppBar -
          replaces the old standalone PageHeader (which dropped the AppBar
          entirely on this route). */}
      <div className="sticky top-12 z-10 -mx-3 flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1.5 border-b-hairline border-border-weak bg-surface-0/[0.72] px-3 py-1.5 backdrop-blur-[20px] sm:-mx-6 sm:px-6">
        <span className="shrink-0 whitespace-nowrap text-sm font-semibold text-ink">Cost by day</span>
        {/* §5.3: window total, right in the header -- not a table footer. */}
        {status === "ok" && rows.length > 0 && (
          <span
            title={costCell(windowTotal.cost, windowTotal.unpricedTokens).title}
            className="shrink-0 whitespace-nowrap font-mono text-2xs tabular-nums slashed-zero text-ink-3"
          >
            {costCell(windowTotal.cost, windowTotal.unpricedTokens).text} total
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <div className="group relative inline-flex items-center">
            <select
              value={harness}
              onChange={(e) => setHarness(isHarness(e.target.value) ? e.target.value : "")}
              aria-label="Filter by harness"
              className="h-7 cursor-pointer appearance-none rounded-md border-hairline border-border bg-transparent py-0 pl-2.5 pr-6 text-xs text-ink-3 transition-colors duration-quick ease-quad hover:text-ink"
            >
              <option value="">All harnesses</option>
              {HARNESSES.map((h) => (
                <option key={h} value={h}>{harnessLabel(h)}</option>
              ))}
            </select>
            <DownCaret />
          </div>
          <Segmented
            value={range}
            onChange={setRange}
            options={WINDOWS.map((w) => ({ value: w, label: w === "all" ? "All" : `${w}d` }))}
          />
        </div>
      </div>

      {status === "error" ? (
        <p className="py-16 text-center text-sm text-ink-3">Couldn't load cost data.</p>
      ) : status === "loading" ? (
        <>
          <p role="status" aria-live="polite" className="sr-only">Loading…</p>
          {isMobile ? <SkeletonCards /> : <SkeletonTable />}
        </>
      ) : sorted.length === 0 ? (
        <p className="py-16 text-center text-sm text-ink-3">No usage in this window.</p>
      ) : isMobile ? (
        <div className="space-y-3">
          {dayGroups.map((g) => {
            const daySubtotal = costCell(sumCost(g.rows), sumUnpriced(g.rows));
            return (
              <div key={g.day}>
                <div className="mb-1.5 flex items-center justify-between text-3xs font-semibold uppercase tracking-caps text-ink-4">
                  <span>{formatDay(g.day)}</span>
                  <span title={daySubtotal.title} className="normal-case tabular-nums slashed-zero">
                    {daySubtotal.text} · {formatTokens(sumTokens(g.rows))} tok
                  </span>
                </div>
                <div className="space-y-2">
                  {g.rows.map((r) => {
                    const cell = costCell(r.costUsd, r.unpricedTokens ?? 0);
                    return (
                      // The harness belongs in this key (finding fix): once
                      // the server groups NULL and 'claude' rows into one
                      // (store.ts), a project/branch can still have TWO rows
                      // for the SAME day if it used more than one harness --
                      // without the harness here they'd collide on this key
                      // exactly like the desktop key below already avoids.
                      <div key={`${r.project}/${r.branch ?? ""}/${r.harness ?? ""}`} data-testid="cost-row" className="rounded-md border-hairline border-border-weak p-3">
                        <div className="flex items-center gap-2">
                          <HarnessMark harness={isHarness(r.harness) ? r.harness : "claude"} />
                          <span className="text-sm font-medium text-ink">{r.project}</span>
                          <span className="text-xs text-ink-3">{r.branch ?? "-"}</span>
                        </div>
                        <div className="mt-1 flex items-center gap-3 font-mono text-2xs">
                          <span title={cell.title} className="tabular-nums slashed-zero text-ink">{cell.text}</span>
                          <span className="tabular-nums slashed-zero text-ink-4">{formatTokens(r.tokens)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <table className="w-full border-collapse font-mono text-xs">
          <thead>
            <tr>
              <th className="sticky top-[5.75rem] z-10 h-8 border-b border-border bg-surface-0 px-2 text-left font-normal">
                <span className="text-2xs uppercase tracking-caps text-ink-4">Harness</span>
              </th>
              {COLS.map((c) => (
                <th
                  key={c.key}
                  aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                  className={`sticky top-[5.75rem] z-10 h-8 border-b border-border bg-surface-0 px-2 text-left font-normal ${c.numeric ? "text-right" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(c)}
                    className="inline-flex items-center gap-1 text-2xs uppercase tracking-caps text-ink-4 transition-colors duration-quick ease-quad hover:text-ink"
                  >
                    {c.label}
                    {sort.key === c.key && <span aria-hidden="true" className="text-3xs">{sort.dir === "asc" ? "▲" : "▼"}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dayGroups.map((g) => {
              const subtotal = costCell(sumCost(g.rows), sumUnpriced(g.rows));
              const subtotalTokens = sumTokens(g.rows);
              return (
                <Fragment key={g.day}>
                  <tr className="bg-surface-1">
                    <td colSpan={COLS.length + 1} className="px-2 py-1 text-3xs font-semibold uppercase tracking-caps text-ink-4">
                      {formatDay(g.day)}
                    </td>
                  </tr>
                  {g.rows.map((r) => {
                    const cell = costCell(r.costUsd, r.unpricedTokens ?? 0);
                    return (
                      <tr
                        key={`${r.project}/${r.branch ?? ""}/${r.harness ?? ""}`}
                        data-testid="cost-row"
                        className="h-8 border-b border-border-weak transition-colors duration-quick ease-quad hover:bg-surface-2"
                      >
                        <td className="px-2 py-[0.3125rem]">
                          <HarnessMark harness={isHarness(r.harness) ? r.harness : "claude"} />
                        </td>
                        <td className="px-2 py-[0.3125rem] font-medium text-ink">{r.project}</td>
                        <td className="px-2 py-[0.3125rem] text-ink-3">{r.branch ?? "-"}</td>
                        <td title={cell.title} className="px-2 py-[0.3125rem] text-right tabular-nums slashed-zero text-ink">{cell.text}</td>
                        <td className="px-2 py-[0.3125rem] text-right tabular-nums slashed-zero text-ink-4">{formatTokens(r.tokens)}</td>
                      </tr>
                    );
                  })}
                  {/* §5.3: per-day subtotal row. */}
                  <tr data-testid="cost-subtotal" className="border-b border-border bg-surface-1 font-semibold text-ink">
                    <td className="px-2 py-[0.3125rem]" />
                    <td className="px-2 py-[0.3125rem]" colSpan={2}>Subtotal</td>
                    <td title={subtotal.title} className="px-2 py-[0.3125rem] text-right tabular-nums slashed-zero">{subtotal.text}</td>
                    <td className="px-2 py-[0.3125rem] text-right tabular-nums slashed-zero">{formatTokens(subtotalTokens)}</td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
