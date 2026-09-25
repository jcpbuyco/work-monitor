import { useEffect, useMemo, useState } from "react";
import { formatUsd, formatTokens, formatDay, costDailyRange, type CostWindow } from "../cost.ts";
import { Segmented } from "./primitives.tsx";
import { AppBar } from "./AppBar.tsx";
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

/** §5.2: `state`/`workflows`/`ready`/`connected`/`lastMessageAt` feed the
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
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "day", dir: "desc" });

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    const { since } = costDailyRange(range, Date.now());
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
  }, [range]);

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
      <div className="sticky top-12 z-10 -mx-3 flex h-11 items-center gap-3 border-b-hairline border-border-weak bg-surface-0/[0.72] px-3 backdrop-blur-[20px] sm:-mx-6 sm:px-6">
        <span className="text-sm font-semibold text-ink">Cost by day</span>
        <div className="ml-auto">
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
        <p role="status" aria-live="polite" className="py-16 text-center text-sm text-ink-3">Loading…</p>
      ) : sorted.length === 0 ? (
        <p className="py-16 text-center text-sm text-ink-3">No usage in this window.</p>
      ) : (
        <table className="w-full border-collapse font-mono text-xs">
          <thead>
            <tr>
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
            {sorted.map((r) => (
              <tr
                key={`${r.project}/${r.branch ?? ""}/${r.day}`}
                data-testid="cost-row"
                className="h-8 border-b border-border-weak transition-colors duration-quick ease-quad hover:bg-surface-2"
              >
                <td className="px-2 py-[0.3125rem] font-medium text-ink">{r.project}</td>
                <td className="px-2 py-[0.3125rem] text-ink-3">{r.branch ?? "—"}</td>
                <td className="px-2 py-[0.3125rem] text-ink-3">{formatDay(r.day)}</td>
                <td className="px-2 py-[0.3125rem] text-right tabular-nums slashed-zero text-ink">{formatUsd(r.costUsd)}</td>
                <td className="px-2 py-[0.3125rem] text-right tabular-nums slashed-zero text-ink-4">{formatTokens(r.tokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
