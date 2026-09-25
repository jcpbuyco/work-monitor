import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { formatUsd, formatTokens, prettyModel, costDailyRange, type CostWindow } from "../cost.ts";
import { formatDuration, formatWhen, dayGroupLabel, localDayKey } from "../time.ts";
import { statusClass, statusKnown, statusGlyphKind, agentStateClass, isRunLive } from "../workflowStatus.ts";
import { groupByDay } from "../groupByDay.ts";
import { useDebouncedValue } from "../useDebouncedValue.ts";
import { useMediaQuery } from "../useMediaQuery.ts";
import { useNow } from "../useNow.ts";
import { useHashRoute } from "../useHashRoute.ts";
import { Segmented, Chip, Chevron, Skeleton, DownCaret } from "./primitives.tsx";
import { StatusGlyph } from "./StatusGlyph.tsx";
import { AppBar } from "./AppBar.tsx";
import type { WorkflowRunSummary, WorkflowRun, WorkflowAgentView, AgentCounts, State, LiveWorkflow } from "../types.ts";

const EMPTY_STATE: State = {
  sessions: [], todos: [], activity: [], stats: [],
  cost: { perSession: {}, liveTotalUsd: 0, todayUsd: 0, byModelToday: [], byProject: [], byBranch: [] },
};

type SortKey = "when" | "workflow" | "project" | "status" | "duration" | "agents" | "tokens" | "cost";

const PAGE_SIZE = 50;
const WINDOWS: CostWindow[] = [7, 14, 30, "all"];
const COLS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "when", label: "When", numeric: true },
  { key: "workflow", label: "Workflow", numeric: false },
  { key: "project", label: "Project/Branch", numeric: false },
  { key: "status", label: "Status", numeric: false },
  { key: "duration", label: "Duration", numeric: true },
  { key: "agents", label: "Agents", numeric: true },
  { key: "tokens", label: "Tokens", numeric: true },
  { key: "cost", label: "Cost", numeric: true },
];

function sortValue(r: WorkflowRunSummary, key: SortKey): number | string {
  switch (key) {
    case "when":
      return r.started_at ?? 0;
    case "workflow":
      return r.name ?? r.run_id;
    case "project":
      return r.project;
    case "status":
      return r.status ?? r.state;
    case "duration":
      return r.duration_ms ?? 0;
    case "agents":
      return r.agent_counts.total;
    case "tokens":
      return r.tokens;
    case "cost":
      return r.costUsd ?? -1; // unpriced sorts below every priced amount, never confused with a real $0
  }
}

/** "1 run" vs "2 runs" -- the totals rows' phrasing (§5.3) is the only place
 *  this page ever says a word out loud next to a count; the desktop table's
 *  AGENTS/COST columns never need it. */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The totals row/line's leading phrase: "N runs" once every match is loaded,
 *  "N of M runs" mid-pagination, "1 run" (not "1 runs") in the single-run
 *  edge case either way. */
function runsCountLabel(loaded: number, total: number): string {
  if (total === 1) return "1 run";
  return loaded === total ? `${loaded} runs` : `${loaded} of ${total} runs`;
}

/** §5.3, ui.md P1-7: the manifest's own declared concurrency (`agent_count`)
 *  vs. the actual row count including retries (`agent_counts.total`) --
 *  "11 (7 + 4 retried)" when they differ, a plain "7" when they agree (or the
 *  manifest count is unknown). */
function formatAgentsCount(r: WorkflowRunSummary): string {
  const total = r.agent_counts.total;
  const declared = r.agent_count;
  if (declared == null || declared <= 0 || declared >= total) return String(total);
  return `${total} (${declared} + ${total - declared} retried)`;
}

/** §5.3, ui.md P1-8: duplicate labels ("verify:tabs-and-scope" x7) are
 *  otherwise indistinguishable -- append the manifest's own `idx` (falling
 *  back to an enumeration position if `idx` itself is unset) to every agent
 *  whose label repeats within this run. Labels that occur once are untouched. */
function withDisambiguation<T extends WorkflowAgentView>(agents: T[]): (T & { displayLabel: string })[] {
  const counts = new Map<string, number>();
  for (const a of agents) {
    const key = a.label ?? a.agent_id;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return agents.map((a) => {
    const key = a.label ?? a.agent_id;
    if ((counts.get(key) ?? 0) <= 1) return { ...a, displayLabel: key };
    const idx = a.idx ?? seen.get(key) ?? 0;
    seen.set(key, idx + 1);
    return { ...a, displayLabel: `${key} · #${idx}` };
  });
}

/** Agents grouped under their 1-based phase, with unphased agents last. */
function byPhase<T extends WorkflowAgentView>(agents: T[]): { title: string; agents: T[] }[] {
  const groups = new Map<number, T[]>();
  const unphased: T[] = [];
  for (const a of agents) {
    if (a.phase_index == null) unphased.push(a);
    else groups.set(a.phase_index, [...(groups.get(a.phase_index) ?? []), a]);
  }
  const out = [...groups.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([idx, list]) => ({ title: `Phase ${idx} · ${list[0].phase_title ?? ""}`.trim(), agents: list }));
  if (unphased.length) out.push({ title: "unphased", agents: unphased });
  return out;
}

/** Roughly derives the list endpoint's `agent_counts` rollup from a full
 *  detail response's own `agents` array -- used ONLY to give a deep-linked
 *  run (§5.3) a summary row when it isn't already on the loaded page, so it
 *  can be merged into the same day-grouped/sorted render as every other row.
 *  Deliberately simpler than the server's own killed-normalization: this is a
 *  display-only stand-in for a handful of cells, not a source of truth. */
function summaryFromDetail(run: WorkflowRun): WorkflowRunSummary {
  const counts: AgentCounts = { total: 0, done: 0, error: 0, running: 0, abandoned: 0, killed: 0 };
  for (const a of run.agents) {
    counts.total++;
    if (a.state === "done") counts.done++;
    else if (a.state === "error") counts.error++;
    else if (a.state === "killed") counts.killed++;
    else if (a.state === "abandoned") counts.abandoned++;
    else if (a.state === "running" || a.state === "progress") counts.running++;
  }
  const { agents: _agents, ...rest } = run;
  return { ...rest, agent_counts: counts };
}

/** The `run=<id>` deep link param (§5.3), read straight off the hash --
 *  `#/workflows?run=wf_abc` -- rather than a prop, since App.tsx doesn't (and
 *  shouldn't) know about this page's own query params. */
function linkedRunIdFrom(hash: string): string | null {
  const i = hash.indexOf("?");
  if (i < 0) return null;
  return new URLSearchParams(hash.slice(i + 1)).get("run");
}

function SkeletonTable() {
  return (
    <table className="w-full border-collapse font-mono text-xs" aria-hidden="true">
      <tbody>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <tr key={i} className="h-8 border-b border-border-weak">
            <td className="px-2 py-[0.3125rem]" colSpan={COLS.length}>
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

/** One agent's live/settled duration: `now - started_at` while the OWNING run
 *  is running and this agent itself is still moving; the stored value
 *  otherwise (§5.3 live duration - the run-level counterpart lives inline in
 *  the row map below, since it needs no shared helper). */
function agentDurationMs(a: WorkflowAgentView, live: boolean, now: number): number | null {
  if (live && (a.state === "running" || a.state === "progress") && a.started_at != null) return now - a.started_at;
  return a.duration_ms;
}

/** The expanded run's body: summary line, manifest error block, and the
 *  phase-grouped agent list. Shared verbatim between the desktop table's
 *  colspan row and the phone card layout (§5.3: "Tables become stacked cards
 *  below md" must not fork this logic in two). */
function RunDetailBody({ run, now }: { run: WorkflowRun; now: number }) {
  const live = isRunLive(run.state);
  const groups = byPhase(withDisambiguation(run.agents));
  return (
    <>
      {run.summary && <p className="mb-2 text-2xs text-ink-3">{run.summary}</p>}
      {run.error && (
        // `[font-variant-ligatures:none]`: this is verbatim code/log text (a
        // stack trace, an assertion message) -- the mono font's ligatures
        // otherwise rewrite `=>` as a single arrow glyph and `===` as a triple
        // bar, silently changing what the error actually said (ui.md finding).
        <pre className="mb-2 whitespace-pre-wrap rounded-md border-hairline border-danger/25 bg-danger/[0.06] p-2 font-mono text-2xs text-danger [font-variant-ligatures:none]">
          {run.error}
        </pre>
      )}
      {groups.map((g) => (
        <div key={g.title} className="mb-2 last:mb-0">
          <div className="text-3xs uppercase tracking-caps text-ink-4">{g.title}</div>
          {/* the rail one more time, now as a tree: a hairline connecting
              agents under their phase */}
          <div className="ml-rail border-l-hairline border-border-weak pl-3">
            {g.agents.map((a) => (
              <div key={a.agent_id} className="flex min-h-6 flex-wrap items-center gap-3 py-0.5 text-2xs">
                <span className="font-medium text-ink">{a.displayLabel}</span>
                <span className={agentStateClass(a.state, live)}>{a.state ?? "-"}</span>
                <span className="text-ink-3">{a.model ? prettyModel(a.model) : "-"}</span>
                {a.fallback_model && (
                  <span
                    className="text-attention"
                    title={`fell back from ${a.model ? prettyModel(a.model) : "the requested model"}`}
                  >
                    → {prettyModel(a.fallback_model)} (fallback)
                  </span>
                )}
                {/* §5.3: "no attempt 1 noise" -- only a RETRY is worth a line. */}
                {(a.attempt ?? 1) > 1 && <span className="text-ink-4">attempt {a.attempt}</span>}
                <span className="text-ink-4">{formatDuration(agentDurationMs(a, live, now))}</span>
                <span className="tabular-nums slashed-zero text-ink-4">{formatTokens(a.tokens)}</span>
                <span className="tabular-nums slashed-zero text-ink">{formatUsd(a.costUsd)}</span>
                {/* §5.3: "no live-blue styling on settled runs" -- the arrow
                    and working-blue tint both read as "in progress", so both
                    are gated on the OWNING RUN still being live, never on the
                    agent's own raw state alone. */}
                {a.last_tool_summary && (
                  <span className={`truncate ${live ? "text-working/70" : "text-ink-4"}`}>
                    {live ? "▸ " : ""}
                    {a.last_tool_summary}
                  </span>
                )}
                {a.error && (
                  <span className="truncate text-danger" title={a.error}>
                    {a.error}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function RunDetailSlot({ detail, now }: { detail: WorkflowRun | "loading" | "error" | undefined; now: number }) {
  if (detail === "loading" || detail === undefined) return <p className="text-2xs text-ink-4">Loading agents…</p>;
  if (detail === "error") return <p className="text-2xs text-ink-4">Couldn’t load agents.</p>;
  return <RunDetailBody run={detail} now={now} />;
}

/** §5.3: `state`/`workflows`/`ready`/`connected`/`lastMessageAt` feed the
 *  shared AppBar (a single App-level fetch/SSE subscription - this page never
 *  opens its own). All optional with safe defaults so this page stays
 *  independently renderable (every existing test mounts it bare, with no App
 *  around it). */
export function WorkflowsPage({
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
  // Named `range`, not `window`, exactly as in CostDailyPage: a state variable
  // called `window` shadows the DOM global for the whole component body.
  const [range, setRange] = useState<CostWindow>(14);
  const [qInput, setQInput] = useState("");
  const q = useDebouncedValue(qInput, 300); // §5.3 search box: refetch on pause, not per keystroke
  const [project, setProject] = useState("");
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "when", dir: "desc" });
  const [open, setOpen] = useState<Set<string>>(new Set());
  // §3: the list no longer carries agents -- an expanded row fetches its own
  // detail from GET /api/workflows/:runId, once, and keeps it here.
  const [details, setDetails] = useState<Record<string, WorkflowRun | "loading" | "error">>({});
  const detailsRef = useRef(details);
  detailsRef.current = details;
  const now = useNow(); // ticks running rows'/agents' live duration (§5.3)
  // §5.3: "tables become stacked cards below md" -- one layout renders at a
  // time (see useMediaQuery's doc for why not a CSS-hidden pair).
  const isMobile = useMediaQuery("(max-width: 767px)");

  const hash = useHashRoute();
  const linkedRunId = useMemo(() => linkedRunIdFrom(hash), [hash]);
  const [handledLinkedRunId, setHandledLinkedRunId] = useState<string | null>(null);
  const [pinnedRun, setPinnedRun] = useState<WorkflowRun | null>(null);
  const scrolledToRef = useRef<string | null>(null);

  const projects = useMemo(
    () => [...new Set((state.cost.byProject ?? []).map((p) => p.project))].sort((a, b) => a.localeCompare(b)),
    [state.cost.byProject]
  );

  // Fetches one detail exactly once (per successful/in-flight attempt) -- a
  // previously-failed fetch ("error") is retried, never stuck (§3 minor
  // finding). Shared by the manual expand toggle and the deep-link effect --
  // `pinnedRun` is only ever set from THIS id's fetch when it's still the
  // active deep link: an ordinary row expand (no `run=` in the hash, or a
  // click on some other row while a DIFFERENT run is linked) must never pin
  // itself, or it would keep injecting a stale extra row into every later
  // search/project-filtered view (found in manual E2E testing, not a test
  // that already existed -- there was no regression test for this because
  // the bug was in the one code path no per-row test exercises twice: expand
  // ANY row, then change a filter).
  const fetchDetail = (id: string) => {
    const existing = detailsRef.current[id];
    if (existing && existing !== "error") return;
    setDetails((d) => ({ ...d, [id]: "loading" }));
    fetch(`/api/workflows/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((run: WorkflowRun) => {
        setDetails((d) => ({ ...d, [id]: run }));
        if (id === linkedRunId) setPinnedRun(run);
      })
      .catch(() => setDetails((d) => ({ ...d, [id]: "error" })));
  };

  const toggleOpen = (id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    fetchDetail(id);
  };

  // §5.3 deep link: `#/workflows?run=<id>` force-opens and fetches that run's
  // detail directly, regardless of the current search/project/window filters
  // or which page it would otherwise fall on -- see `summaryFromDetail`'s doc
  // for how it still gets a row to render even when it's off the loaded page.
  useEffect(() => {
    if (!linkedRunId) {
      // The link was cleared (or never set) -- drop any previously-pinned
      // row so it stops shadowing every later filtered view.
      setPinnedRun(null);
      return;
    }
    if (linkedRunId === handledLinkedRunId) return;
    setHandledLinkedRunId(linkedRunId);
    setOpen((prev) => (prev.has(linkedRunId) ? prev : new Set(prev).add(linkedRunId)));
    fetchDetail(linkedRunId);
    // fetchDetail intentionally excluded: it closes over `details` via a ref,
    // so it never goes stale, and including it would re-run this on every
    // keystroke-driven re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedRunId, handledLinkedRunId]);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setRuns([]);
    setTotal(0);
    const { since } = costDailyRange(range, Date.now());
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (since != null) params.set("since", String(since));
    if (q.trim()) params.set("q", q.trim());
    if (project) params.set("project", project);
    fetch(`/api/workflows?${params}`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        setRuns(Array.isArray(body?.runs) ? (body.runs as WorkflowRunSummary[]) : []);
        setTotal(typeof body?.total === "number" ? body.total : 0);
        setStatus("ok");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [range, q, project]);

  // `loadMoreGen` guards against a filter change (range/q/project) racing a
  // Load-more request already in flight: the main-list effect above bumps it
  // on every dep change (its own `cancelled` flag serves the exact same
  // purpose there), so a stale page arriving after the filters moved on gets
  // dropped instead of appending onto results it no longer belongs with.
  const loadMoreGen = useRef(0);
  useEffect(() => {
    loadMoreGen.current++;
    setLoadMoreError(false);
  }, [range, q, project]);

  const loadMore = () => {
    if (loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(false);
    const gen = loadMoreGen.current;
    const { since } = costDailyRange(range, Date.now());
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(runs.length) });
    if (since != null) params.set("since", String(since));
    if (q.trim()) params.set("q", q.trim());
    if (project) params.set("project", project);
    fetch(`/api/workflows?${params}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body) => {
        if (gen !== loadMoreGen.current) return; // filters changed while this was in flight
        const more = Array.isArray(body?.runs) ? (body.runs as WorkflowRunSummary[]) : [];
        setRuns((prev) => [...prev, ...more]);
        if (typeof body?.total === "number") setTotal(body.total);
      })
      .catch(() => {
        if (gen === loadMoreGen.current) setLoadMoreError(true);
      })
      .finally(() => {
        if (gen === loadMoreGen.current) setLoadingMore(false);
      });
  };

  // The deep-linked run, when the fetch it triggered above hasn't already
  // surfaced it through a normal page load -- rendered in its OWN "Linked
  // run" block (below), never merged into `runs`/`sorted`: a pinned run can
  // be outside the active window/project/search filters entirely, and
  // folding it into the same array used to inflate the totals row, the
  // runsCountLabel and the Load-more arithmetic with a run the server-side
  // `total` never counted (found in manual E2E testing -- "12 of 11 runs").
  const pinnedOutsideFilters = useMemo(() => {
    if (!pinnedRun || runs.some((r) => r.run_id === pinnedRun.run_id)) return null;
    return summaryFromDetail(pinnedRun);
  }, [runs, pinnedRun]);

  const sorted = useMemo(() => {
    const copy = [...runs];
    const { key, dir } = sort;
    copy.sort((a, b) => {
      const av = sortValue(a, key);
      const bv = sortValue(b, key);
      const c = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return dir === "asc" ? c : -c;
    });
    return copy;
  }, [runs, sort]);

  // §5.3 day grouping: group order follows the row order verbatim while
  // sorted by "When" (so toggling the column's direction flips the groups
  // too); any other column sort still groups by day, newest day first, with
  // the chosen column sorting WITHIN each day.
  const dayGroups = useMemo(
    () => groupByDay(sorted, (r) => (r.started_at != null ? localDayKey(r.started_at) : "unknown"), sort.key === "when"),
    [sorted, sort.key]
  );

  const totals = useMemo(
    () =>
      sorted.reduce(
        (t, r) => ({ agents: t.agents + r.agent_counts.total, tokens: t.tokens + r.tokens, cost: t.cost + (r.costUsd ?? 0) }),
        { agents: 0, tokens: 0, cost: 0 }
      ),
    [sorted]
  );

  const toggleSort = (col: { key: SortKey; numeric: boolean }) =>
    setSort((s) =>
      s.key === col.key
        ? { key: col.key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key: col.key, dir: col.numeric ? "desc" : "asc" }
    );

  // Scrolls to the deep-linked run once it actually has a DOM row to scroll
  // to -- runs after every render (cheap: one attribute query), guarded so it
  // only ever fires once per linked id. Two elements can share `data-run-id`
  // (the desktop row and the phone card); scrollIntoView on the CSS-hidden
  // one is a harmless no-op, so calling it on both is safe.
  //
  // `status === "loading"` is excluded (regression, found in real-browser
  // testing, not by any existing test): the run's own detail fetch often
  // resolves BEFORE the main list fetch does, and while the list is still
  // loading the linked run can only ever render in the "Linked run" block
  // right below the toolbar (see `pinnedOutsideFilters`) -- scrolling there
  // and locking `scrolledToRef` left the page stuck at that position even
  // after the list finished loading and the SAME run took its real, much
  // further down, chronological place in the day-grouped table.
  useEffect(() => {
    if (!linkedRunId || scrolledToRef.current === linkedRunId || status === "loading") return;
    const els = document.querySelectorAll(`[data-run-id="${linkedRunId}"]`);
    if (els.length === 0) return;
    els.forEach((el) => {
      const e = el as HTMLElement;
      if (typeof e.scrollIntoView === "function") e.scrollIntoView({ block: "center" });
    });
    scrolledToRef.current = linkedRunId;
  });

  const runLabel = (r: WorkflowRunSummary) => r.status ?? r.state;

  // Desktop and mobile row renderers, shared between the normal day-grouped
  // list and the "Linked run" block below (a deep-linked run outside the
  // active filters) -- so a deep link renders through the EXACT same markup
  // as every other row instead of a second, drifting copy.
  const renderRow = (r: WorkflowRunSummary) => {
    const label = runLabel(r);
    const isOpen = open.has(r.run_id);
    return (
      <Fragment key={r.run_id}>
        <tr data-testid="wf-row" data-run-id={r.run_id} className="h-8 border-b border-border-weak transition-colors duration-quick ease-quad hover:bg-surface-2">
          <td className="px-2 py-[0.3125rem] text-right tabular-nums text-ink-3">{formatWhen(r.started_at)}</td>
          <td className="px-2 py-[0.3125rem] font-medium text-ink">
            {/* §5.3 keyboard-accessible expander: a real
                <button aria-expanded>, not a <tr onClick> a
                keyboard user could never reach. */}
            <button
              type="button"
              aria-expanded={isOpen}
              aria-controls={`wf-detail-${r.run_id}`}
              onClick={() => toggleOpen(r.run_id)}
              className="inline-flex max-w-full items-center gap-1.5 text-left transition-colors duration-quick ease-quad hover:text-accent"
            >
              {/* SVG only - no text content, or findByText("research") stops resolving */}
              <span className="inline-flex shrink-0 align-[-0.1em]">
                <Chevron open={isOpen} />
              </span>
              {r.name ?? r.run_id}
            </button>
            {!r.schema_ok && <Chip className="ml-1.5">structure unavailable</Chip>}
          </td>
          <td className="px-2 py-[0.3125rem] text-ink-3">
            {r.project} · {r.branch ?? "-"}
          </td>
          {/* `label` MUST stay a direct text child of the <td>:
              testing-library's getByText reads only an element's own
              text nodes, so wrapping it in a span would move both
              `data-status-known` assertions off the matched element
              (WorkflowsPage.test:57-59). The glyph is a sibling. */}
          <td data-status-known={String(statusKnown(label))} className={`px-2 py-[0.3125rem] ${statusClass(label)}`}>
            <span className="mr-1.5 inline-flex align-[-0.1em]">
              <StatusGlyph kind={statusGlyphKind(label)} animate={false} />
            </span>
            {label}
          </td>
          <td className="px-2 py-[0.3125rem] text-right tabular-nums text-ink-3">
            {/* §5.3 live duration: a running row ticks off `now`
                rather than the value captured at fetch time. */}
            {formatDuration(r.state === "running" && r.started_at != null ? now - r.started_at : r.duration_ms)}
          </td>
          <td className="px-2 py-[0.3125rem] text-right tabular-nums text-ink-3">{formatAgentsCount(r)}</td>
          <td className="px-2 py-[0.3125rem] text-right tabular-nums slashed-zero text-ink-4">{formatTokens(r.tokens)}</td>
          <td className="px-2 py-[0.3125rem] text-right tabular-nums slashed-zero text-ink">{formatUsd(r.costUsd)}</td>
        </tr>
        {isOpen && (
          <tr id={`wf-detail-${r.run_id}`} className="border-b border-border-weak bg-surface-1">
            <td colSpan={COLS.length} className="px-3 py-2">
              <RunDetailSlot detail={details[r.run_id]} now={now} />
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  const renderCard = (r: WorkflowRunSummary) => {
    const label = runLabel(r);
    const isOpen = open.has(r.run_id);
    return (
      <div key={r.run_id} data-testid="wf-card" className="rounded-md border-hairline border-border-weak p-3">
        {/* `data-run-id` sits on the HEADER row, not this whole card: a deep
            link's scrollIntoView({block:'center'}) targets it, and a large
            run's expanded agent list can run thousands of pixels tall -
            centring the OUTER card on that height stranded the viewport deep
            inside the agent list, with the run's own name/status far above
            (found in manual phone-width testing, wf-390-deeplink.png). */}
        <div data-run-id={r.run_id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <button
            type="button"
            aria-expanded={isOpen}
            aria-controls={`wf-detail-card-${r.run_id}`}
            onClick={() => toggleOpen(r.run_id)}
            className="inline-flex min-w-0 items-center gap-1.5 text-left text-sm font-medium text-ink"
          >
            <span className="inline-flex shrink-0 align-[-0.1em]">
              <Chevron open={isOpen} />
            </span>
            <span className="truncate">{r.name ?? r.run_id}</span>
          </button>
          {!r.schema_ok && <Chip>structure unavailable</Chip>}
          <span className={`ml-auto shrink-0 text-2xs font-medium ${statusClass(label)}`}>
            <StatusGlyph kind={statusGlyphKind(label)} animate={false} className="mr-1 inline align-[-0.1em]" />
            {label}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-2xs text-ink-3">
          <span>{r.project} · {r.branch ?? "-"}</span>
          <span>{formatWhen(r.started_at)}</span>
          <span>{formatDuration(r.state === "running" && r.started_at != null ? now - r.started_at : r.duration_ms)}</span>
          <span>{formatAgentsCount(r)} agent{r.agent_counts.total === 1 ? "" : "s"}</span>
          <span className="slashed-zero">{formatTokens(r.tokens)} tok</span>
          <span className="slashed-zero text-ink">{formatUsd(r.costUsd)}</span>
        </div>
        {isOpen && (
          <div id={`wf-detail-card-${r.run_id}`} className="mt-2 border-t-hairline border-border-weak pt-2">
            <RunDetailSlot detail={details[r.run_id]} now={now} />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="mx-auto max-w-board px-3 pb-16 sm:px-6">
      <AppBar
        state={state}
        workflows={workflows}
        ready={ready}
        route="#/workflows"
        connected={connected}
        lastMessageAt={lastMessageAt}
      />
      {/* §5.2: the page's own slim toolbar, right under the shared AppBar -
          replaces the old standalone PageHeader (which dropped the AppBar
          entirely on this route). */}
      <div className="sticky top-12 z-10 -mx-3 flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1.5 border-b-hairline border-border-weak bg-surface-0/[0.72] px-3 py-1.5 backdrop-blur-[20px] sm:-mx-6 sm:px-6">
        <span className="shrink-0 whitespace-nowrap text-sm font-semibold text-ink">Workflow runs</span>
        <div className="ml-auto">
          <Segmented
            value={range}
            onChange={setRange}
            options={WINDOWS.map((w) => ({ value: w, label: w === "all" ? "All" : `${w}d` }))}
          />
        </div>
      </div>

      {/* §5.3: search + project filter -- NOT sticky, so the sticky table
          header below keeps the same fixed offset it always has. */}
      <div className="flex flex-wrap items-center gap-2 py-3">
        <input
          type="search"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="Search workflows…"
          aria-label="Search workflows"
          className="h-7 w-full max-w-[16rem] rounded-md border-hairline border-border bg-transparent px-2.5 text-xs text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/50"
        />
        <div className="group relative inline-flex items-center">
          <select
            value={project}
            onChange={(e) => setProject(e.target.value)}
            aria-label="Filter by project"
            className="h-7 cursor-pointer appearance-none rounded-md border-hairline border-border bg-transparent py-0 pl-2.5 pr-6 text-xs text-ink-3 transition-colors duration-quick ease-quad hover:text-ink"
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <DownCaret />
        </div>
      </div>

      {/* §5.3 deep link: the linked run, rendered here ONLY when it isn't
          already part of `runs` -- e.g. it's outside the active window,
          project filter or search. Deliberately NOT folded into `sorted`/
          `dayGroups` (see `pinnedOutsideFilters`'s doc above): this block is
          independent of the loading/error/empty state below, so the link
          keeps working even while the main list is still loading or matched
          nothing. */}
      {pinnedOutsideFilters && (
        <div className="mb-3 rounded-md border-hairline border-accent/30 bg-accent/[0.04] p-2">
          <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-3xs font-semibold uppercase tracking-caps text-ink-4">Linked run</span>
            <span className="text-2xs text-ink-4">outside the current window/filters</span>
          </div>
          {isMobile ? (
            renderCard(pinnedOutsideFilters)
          ) : (
            <table className="w-full border-collapse font-mono text-xs">
              <tbody>{renderRow(pinnedOutsideFilters)}</tbody>
            </table>
          )}
        </div>
      )}

      {/* Same four states, in the same order, as CostDailyPage: error → loading →
          empty → table. Without the loading branch the totals row renders "0 runs"
          for one frame on every window change. */}
      {status === "error" ? (
        <p className="py-16 text-center text-sm text-ink-3">Couldn’t load workflow runs.</p>
      ) : status === "loading" ? (
        <>
          <p role="status" aria-live="polite" className="sr-only">Loading…</p>
          {isMobile ? <SkeletonCards /> : <SkeletonTable />}
        </>
      ) : sorted.length === 0 ? (
        <div className="py-16 text-center text-sm text-ink-3">
          {/* Distinguishes "the window is genuinely empty" from "your search/
              project filter matched nothing" -- the same generic copy for both
              (found in manual testing) left a filtered-to-zero search looking
              exactly like there was no data at all, with no way back. */}
          <p>{q.trim() || project ? "No runs match these filters." : "No workflow runs in this window."}</p>
          {(q.trim() || project) && (
            <button
              type="button"
              onClick={() => {
                setQInput("");
                setProject("");
              }}
              className="mt-2 text-xs text-accent underline-offset-2 hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <>
          {/* §5.3: "tables become stacked cards below md" -- exactly one of
              these two layouts renders (see useMediaQuery's doc comment). */}
          {!isMobile && (
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
                {dayGroups.map((g) => (
                  <Fragment key={g.day}>
                    <tr className="bg-surface-1">
                      <td colSpan={COLS.length} className="px-2 py-1 text-3xs font-semibold uppercase tracking-caps text-ink-4">
                        {dayGroupLabel(g.day)}
                      </td>
                    </tr>
                    {g.rows.map(renderRow)}
                  </Fragment>
                ))}
                <tr data-testid="wf-totals" className="border-t border-border bg-surface-1 font-semibold text-ink">
                  <td className="px-2 py-[0.3125rem]" />
                  <td className="px-2 py-[0.3125rem]">{runsCountLabel(sorted.length, total)}</td>
                  <td className="px-2 py-[0.3125rem]" />
                  <td className="px-2 py-[0.3125rem]" />
                  <td className="px-2 py-[0.3125rem]" />
                  <td className="px-2 py-[0.3125rem] text-right tabular-nums">{totals.agents}</td>
                  <td className="px-2 py-[0.3125rem] text-right tabular-nums slashed-zero">{formatTokens(totals.tokens)}</td>
                  <td className="px-2 py-[0.3125rem] text-right tabular-nums slashed-zero">{formatUsd(totals.cost)}</td>
                </tr>
              </tbody>
            </table>
          )}

          {/* §5.3: the SAME dayGroups/sorted data, rendered as cards instead
              of table rows so nothing on a 390px phone forces the page to
              scroll sideways. */}
          {isMobile && (
          <div className="space-y-3">
            {dayGroups.map((g) => (
              <div key={g.day}>
                <div className="mb-1.5 text-3xs font-semibold uppercase tracking-caps text-ink-4">{dayGroupLabel(g.day)}</div>
                <div className="space-y-2">{g.rows.map(renderCard)}</div>
              </div>
            ))}
            <div data-testid="wf-totals-mobile" className="pt-1 text-2xs text-ink-3">
              {runsCountLabel(sorted.length, total)} · {plural(totals.agents, "agent")} · {formatTokens(totals.tokens)} tok ·{" "}
              {formatUsd(totals.cost)}
            </div>
          </div>
          )}

          {sorted.length < total && (
            <div className="flex flex-col items-center gap-1.5 py-4">
              {loadMoreError && <p className="text-2xs text-danger">Couldn’t load more runs.</p>}
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="rounded-md border-hairline border-border px-3 py-1.5 text-xs text-ink-3 transition-colors duration-quick ease-quad hover:text-ink disabled:opacity-50"
              >
                {loadingMore ? "Loading…" : loadMoreError ? "Retry" : "Load more"}
              </button>
            </div>
          )}

          {sorted.find((r) => r.cc_version)?.cc_version && (
            <p className="mt-3 px-2 text-2xs text-ink-4">
              format last verified on {sorted.find((r) => r.cc_version)!.cc_version}
            </p>
          )}
        </>
      )}
    </div>
  );
}
