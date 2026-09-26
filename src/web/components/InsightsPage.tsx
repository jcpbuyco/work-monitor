import { useCallback, useEffect, useRef, useState } from "react";
import type { State, LiveWorkflow } from "../types.ts";
import type { InsightsResponse } from "../../shared/insights.ts";
import { AppBar } from "./AppBar.tsx";
import { SectionHeader } from "./primitives.tsx";
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

  return (
    <div className="mx-auto max-w-board px-4 pb-16 sm:px-6">
      <AppBar state={state} workflows={workflows} ready={ready} route="#/insights" connected={connected} lastMessageAt={lastMessageAt} />
      <div className="sticky top-12 z-10 -mx-4 flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1.5 border-b-hairline border-border-weak bg-surface-0/[0.72] px-4 py-1.5 backdrop-blur-[20px] sm:-mx-6 sm:px-6">
        <span className="shrink-0 whitespace-nowrap text-sm font-semibold text-ink">Insights</span>
        <span className="shrink-0 whitespace-nowrap text-2xs text-ink-3">
          Lifetime since {data?.meta.firstAt != null ? new Date(data.meta.firstAt).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" }) : "-"} · local time
          {data?.meta.tz ? ` (${data.meta.tz})` : ""}
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
        <div className="py-24 text-center text-sm text-ink-3" role="status" aria-live="polite">
          Loading insights…
        </div>
      ) : data.meta.usageRows === 0 ? (
        <div className="py-24 text-center text-sm text-ink-3">No usage recorded yet. Insights appear once agents start spending tokens.</div>
      ) : (
        <div className="space-y-6 pt-4">
          <section>
            <SectionHeader label="Spend" />
            <KpiRow data={data} />
          </section>

          <section>
            <RecordsStrip data={data} onHoverDay={setRingedDay} onGoToCalendar={goToCalendar} />
          </section>

          <section className="space-y-4 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
            <MonthlyByModel data={data} refetching={refetching} />
            <MonthPace data={data} refetching={refetching} />
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

          <section>
            <LifetimeCalendar data={data} ringedDay={ringedDay} id={CALENDAR_ID} refetching={refetching} />
          </section>

          <section>
            <SectionHeader label="Rhythm" />
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
