import { useCallback, useEffect, useRef, useState } from "react";
import type { State, LiveWorkflow } from "../types.ts";
import type { InsightsResponse } from "../../shared/insights.ts";
import { AppBar } from "./AppBar.tsx";
import { SectionHeader, Skeleton } from "./primitives.tsx";
import { ago } from "../time.ts";
import { KpiRow } from "./insights/KpiRow.tsx";
import { RecordsStrip } from "./insights/RecordsStrip.tsx";
import { MonthlyByModel } from "./insights/MonthlyByModel.tsx";
import { MonthPace } from "./insights/MonthPace.tsx";
import { TokenClass } from "./insights/TokenClass.tsx";
import { WhoDoesTheWork } from "./insights/WhoDoesTheWork.tsx";
import { WorkflowRunCosts } from "./insights/WorkflowRunCosts.tsx";
import { PriceOfOutput } from "./insights/PriceOfOutput.tsx";
import { LifetimeCalendar } from "./insights/LifetimeCalendar.tsx";
import { WeeklyRhythm } from "./insights/WeeklyRhythm.tsx";
import { Leverage } from "./insights/Leverage.tsx";
import { ProjectsByMonth } from "./insights/ProjectsByMonth.tsx";

const EMPTY_STATE: State = {
  sessions: [], todos: [], activity: [], stats: [],
  cost: { perSession: {}, liveTotalUsd: 0, todayUsd: 0, byModelToday: [], byProject: [], byBranch: [] },
};

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const CALENDAR_ID = "insights-calendar";

type Status = "loading" | "ok" | "error";

/** The Insights page (`#/insights`): one lifetime scope, no filters -- every
 *  number on the page always agrees with every other (§3). Pull-only, never
 *  streamed; a background refetch dims the previous render instead of
 *  flashing a skeleton (§6, "States shared by every card"). */
export function InsightsPage({
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
  const [data, setData] = useState<InsightsResponse | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);
  const [ringedDay, setRingedDay] = useState<string | null>(null);
  // A background refetch's own React state, not a ref: a ref mutation alone
  // triggers no re-render, so reading `inFlight.current` at render time (the
  // previous approach) could only ever reflect whatever it happened to be at
  // the LAST unrelated render -- in practice always `false`, since nothing
  // re-renders the instant a background fetch starts. The result was that the
  // spec's "dim the previous render to 60% while refetching" never visibly
  // happened at all (reviewer finding). `inFlight` (the ref) still exists to
  // de-dupe overlapping calls to `load`.
  const [refetching, setRefetching] = useState(false);
  const inFlight = useRef(false);

  const load = useCallback((background: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (!background) setStatus("loading");
    else setRefetching(true);
    fetch("/api/insights")
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((body: InsightsResponse) => {
        if (!body || typeof body.meta?.usageRows !== "number") throw new Error("malformed /api/insights response");
        setData(body);
        setStatus("ok");
        setRefreshFailed(false);
        setLastFetchedAt(Date.now());
      })
      .catch(() => {
        if (background) setRefreshFailed(true);
        else setStatus("error");
      })
      .finally(() => {
        inFlight.current = false;
        setRefetching(false);
      });
  }, []);

  useEffect(() => {
    load(false);
    const onFocus = () => load(true);
    window.addEventListener("focus", onFocus);
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load(true);
    }, REFRESH_INTERVAL_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(interval);
    };
  }, [load]);

  const goToCalendar = useCallback(() => {
    document.getElementById(CALENDAR_ID)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const loading = status === "loading";

  const sinceLabel = `Lifetime since ${data?.meta.firstAt != null ? new Date(data.meta.firstAt).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" }) : "-"} · local time${data?.meta.tz ? ` (${data.meta.tz})` : ""}`;

  return (
    // px-3, matching the Cost/Workflows pages' own gutter (§5.2) -- this
    // page's px-4 was the one route with a different phone-width gutter, so
    // the AppBar above it (which always renders at -mx-3, the app-wide
    // convention) sat 1px narrower than the toolbar right under it at every
    // width (reviewer finding, B13).
    <div className="mx-auto max-w-board px-3 pb-16 sm:px-6">
      <AppBar state={state} workflows={workflows} ready={ready} route="#/insights" connected={connected} lastMessageAt={lastMessageAt} />
      <div className="sticky top-12 z-10 -mx-3 flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1.5 border-b-hairline border-border-weak bg-surface-0/[0.72] px-3 py-1.5 backdrop-blur-[20px] sm:-mx-6 sm:px-6">
        <span className="shrink-0 whitespace-nowrap text-sm font-semibold text-ink">Insights</span>
        {/* min-w-0 + truncate, not `shrink-0 whitespace-nowrap`: at 390/22 the
           full "Lifetime since ... (Europe/Malta)" string ran past the
           viewport's own right edge and forced the whole page to scroll
           sideways (reviewer finding, A2/B13) -- `title` keeps the full text
           reachable on hover/long-press.

           `w-full` below `sm`, not `flex-1` at every width: squeezed onto the
           same row as "Insights" and the refresh controls at phone width, it
           truncated down to a bare, contentless "Life..." -- wide enough to
           still overflow, narrow enough to say nothing (reviewer finding,
           O7). Its own full-width row below `sm` gives it real room; `title`
           (and `truncate` as a safety net for a pathological string) still
           apply either way. */}
        <span className="min-w-0 w-full truncate text-2xs text-ink-3 sm:w-auto sm:flex-1" title={sinceLabel}>
          {sinceLabel}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {refreshFailed && <span className="text-2xs text-attention">Refresh failed</span>}
          <span className="text-2xs text-ink-4">{lastFetchedAt ? `Updated ${ago(lastFetchedAt)}` : ""}</span>
          <button
            type="button"
            data-press
            onClick={() => load(true)}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs text-ink-3 transition-colors duration-quick ease-quad hover:bg-surface-2 hover:text-ink"
          >
            Refresh
          </button>
        </div>
      </div>

      {status === "error" ? (
        <div className="flex flex-col items-center gap-3 py-24 text-center">
          <p className="text-sm text-ink-3">Couldn't load insights.</p>
          <button type="button" onClick={() => load(false)} className="rounded-md border-hairline border-border px-3 py-1.5 text-xs text-ink-2 hover:bg-surface-2">
            Retry
          </button>
        </div>
      ) : loading || !data ? (
        <InsightsSkeleton />
      ) : data.meta.usageRows === 0 ? (
        <div className="py-24 text-center text-sm text-ink-3">No usage recorded yet. Insights appear once agents start spending tokens.</div>
      ) : (
        <div className="space-y-6 pt-4">
          {/* One section per SectionHeader (reviewer finding, B15): the
             records strip and the C3/C4 spend-pace row used to sit between
             two headers with no label of their own, reading as their own
             unlabelled section under "Spend". */}
          <section className="space-y-4">
            <SectionHeader label="Spend" />
            <KpiRow data={data} />
            <RecordsStrip data={data} onHoverDay={setRingedDay} onGoToCalendar={goToCalendar} />
            <div className="space-y-4 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
              <MonthlyByModel data={data} refetching={refetching} />
              <MonthPace data={data} refetching={refetching} />
            </div>
          </section>

          <section>
            <SectionHeader label="Where it goes" />
            <div className="space-y-4 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
              <TokenClass data={data} refetching={refetching} />
              <WhoDoesTheWork data={data} refetching={refetching} />
            </div>
          </section>

          <section>
            <SectionHeader label="Efficiency" />
            <div className="space-y-4 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
              <WorkflowRunCosts data={data} refetching={refetching} />
              <PriceOfOutput data={data} refetching={refetching} />
            </div>
          </section>

          {/* "Rhythm" now covers the calendar too (reviewer finding, B15): the
             full-width calendar used to sit directly under the "Efficiency"
             header with no header of its own, reading as if it belonged to
             that section instead of the rhythm-chart pair right below it. */}
          <section className="space-y-4">
            <SectionHeader label="Rhythm" />
            <LifetimeCalendar data={data} ringedDay={ringedDay} id={CALENDAR_ID} refetching={refetching} />
            <div className="space-y-4 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
              <WeeklyRhythm data={data} refetching={refetching} />
              <Leverage data={data} refetching={refetching} />
            </div>
          </section>

          <section>
            <SectionHeader label="Projects" />
            <ProjectsByMonth data={data} refetching={refetching} />
          </section>
        </div>
      )}
    </div>
  );
}

/** First-load placeholder, built from the page's REAL structure -- the same
 *  5 labelled sections, the same 10 chart cards (plus the full-width calendar
 *  and projects table), each titled and roughly at its own card's height --
 *  so the layout doesn't visibly jump when the data lands (reviewer finding,
 *  A12). Titled shells rather than mounting the real cards in `loading` mode:
 *  every real card destructures `data` directly (`data.months`, ...) with no
 *  null-safe path for "no data yet", so this stays the lower-risk structural
 *  match instead of a data-shape change across every card. */
function InsightsSkeleton() {
  const card = "rounded-lg border-hairline border-border bg-surface-1 p-4";
  const chart = (key: string, title: string, subtitle: string, h: number) => (
    <div key={key} className={`${card} flex flex-col`}>
      <Skeleton w="w-40" className="h-[0.875rem]" />
      <span className="sr-only">{title}</span>
      <Skeleton w="w-64" className="mt-2 block h-[0.625rem]" />
      <span className="sr-only">{subtitle}</span>
      <div className="am-pulse mt-4 flex-1 rounded bg-surface-2" style={{ minHeight: h }} />
    </div>
  );
  return (
    <div className="space-y-6 pt-4" data-testid="insights-skeleton" role="status" aria-live="polite">
      <span className="sr-only">Loading insights</span>

      <div className="space-y-4">
        <SectionHeader label="Spend" />
        <div className="space-y-4 lg:grid lg:grid-cols-3 lg:gap-4 lg:space-y-0">
          <div className={`${card} lg:col-span-1`}>
            <Skeleton w="w-44" className="h-9" />
            <Skeleton w="w-56" className="mt-3 block" />
            <Skeleton w="w-48" className="mt-2 block" />
          </div>
          <div className="grid grid-cols-2 gap-4 lg:col-span-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className={`${card} p-3`}>
                <Skeleton w="w-20" />
                <Skeleton w="w-24" className="mt-1 block h-5" />
                {/* A delta line plus a sparkline/meter-shaped bar -- a real
                   `StatTile` almost always renders both, and the skeleton's
                   own real height matters (it sizes the page BEFORE data
                   lands, so the layout shouldn't jump once it does): leaving
                   them out made every skeleton tile ~50px shorter than its
                   loaded counterpart (reviewer finding, O6). */}
                <Skeleton w="w-32" className="mt-1 block h-3" />
                <Skeleton w="w-16" className="mt-2 block h-5" />
              </div>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className={`${card} p-3`}>
              <Skeleton w="w-20" />
              <Skeleton w="w-16" className="mt-1 block h-4" />
              <Skeleton w="w-24" className="mt-1 block h-3" />
            </div>
          ))}
        </div>
        <div className="space-y-4 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
          {chart("c3", "Monthly spend by model", "How fast is monthly spend growing?", 252)}
          {chart("c4", "Month pace", "Cumulative spend by day of month", 264)}
        </div>
      </div>

      <div className="space-y-4">
        <SectionHeader label="Where it goes" />
        <div className="space-y-4 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
          {chart("c5", "Cost by token class", "How much of spend is context, not output?", 252)}
          {chart("c6", "Who does the work", "How much comes from orchestration?", 252)}
        </div>
      </div>

      <div className="space-y-4">
        <SectionHeader label="Efficiency" />
        <div className="space-y-4 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
          {chart("c7", "Workflow run costs", "What a typical run costs", 264)}
          {chart("c8", "Price of output by model", "All-in cost per 1M output tokens", 216)}
        </div>
      </div>

      <div className="space-y-4">
        <SectionHeader label="Rhythm" />
        {chart("c9", "Lifetime calendar", "Every active day, at a glance", 236)}
        <div className="space-y-4 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
          {chart("c10", "Weekly rhythm", "Which hours and weekdays are busy?", 192)}
          {chart("c11", "Active hours and cost per active hour", "", 296)}
        </div>
      </div>

      <div className="space-y-4">
        <SectionHeader label="Projects" />
        {/* This card's real body is a table sized to its own row count (13:
           10 ranked projects plus Other/(no project) plus a header), not a
           fixed chart budget -- 280px (the old estimate) was noticeably
           shorter than the loaded table, one more source of the page
           visibly growing once data lands (reviewer finding, O6). */}
        {chart("c12", "Projects by month", "Which projects consumed the budget?", 40 + 13 * 28)}
      </div>
    </div>
  );
}
