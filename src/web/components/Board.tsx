import type { ReactNode } from "react";
import type { State, Session, Activity, LiveWorkflow, LastRun } from "../types.ts";
import { HARNESSES, isHarness, type Harness } from "../../shared/harness.ts";
import { useNow } from "../useNow.ts";
import { usePersistedValue } from "../usePersistedValue.ts";
import { buildSessionTree, type SessionNode } from "../sessionTree.ts";
import { Lane, Column } from "./Lane.tsx";
import { SessionCard } from "./SessionCard.tsx";
import { AppBar } from "./AppBar.tsx";
import { TodosSection } from "./TodosSection.tsx";
import { ActivityFeed } from "./ActivityFeed.tsx";
import { ToolStats } from "./ToolStats.tsx";
import { CostPanel } from "./CostPanel.tsx";
import { CostBreakdown } from "./CostBreakdown.tsx";
import { WorkflowsSection } from "./WorkflowsSection.tsx";
import { Segmented, Skeleton } from "./primitives.tsx";

/** Needs you first: the board's job is to tell you when it needs you. */
const SESSION_COLS: { id: Session["status"]; title: string }[] = [
  { id: "needs_you", title: "Needs you" },
  { id: "working", title: "Working" },
  { id: "idle", title: "Idle / done" },
];

/** Short labels for the Segmented harness filter (§5.1) - `harnessLabel`'s
 *  "Claude Code" is right for a tooltip but too wide for a 3-way toggle. */
const FILTER_LABEL: Record<Harness, string> = { claude: "Claude", codex: "Codex", cursor: "Cursor" };

type HarnessFilter = "all" | Harness;
const isHarnessFilter = (v: unknown): v is HarnessFilter => v === "all" || isHarness(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Three skeleton rows, the board's pre-`ready` placeholder (§5.2) - enough to
 *  read as "content is coming", never as a genuinely empty column. */
function ColumnSkeleton() {
  return (
    <div className="space-y-1.5 py-1.5 pl-rail">
      <Skeleton w="w-11/12" />
      <Skeleton w="w-2/3" />
      <Skeleton w="w-5/6" />
    </div>
  );
}

export function Board({
  state,
  workflows = [],
  lastRun = null,
  /** §5.2: false until the first `/api/state` response - gates the skeleton
   *  columns and the AppBar's "…" counts. Defaults true so every existing
   *  caller (and every test) that doesn't know about this yet still renders
   *  the real board immediately. */
  ready = true,
  /** §5.2: false once the SSE stream has been silent past its staleness
   *  window - shows the "Reconnecting…" bar. */
  connected = true,
  lastMessageAt = null,
}: {
  state: State;
  workflows?: LiveWorkflow[];
  lastRun?: LastRun | null;
  ready?: boolean;
  connected?: boolean;
  lastMessageAt?: number | null;
}) {
  // Re-render every second so relative timestamps (and the reconnecting bar's
  // "last update Xm ago") tick live.
  useNow();

  const [harnessFilter, setHarnessFilter] = usePersistedValue<HarnessFilter>(
    "am-session-harness-filter",
    "all",
    isHarnessFilter
  );
  const [dismissedRuns, setDismissedRuns] = usePersistedValue<string[]>("am-degraded-dismissed", [], isStringArray);

  const harnessCounts: Record<HarnessFilter, number> = { all: state.sessions.length, claude: 0, codex: 0, cursor: 0 };
  for (const s of state.sessions) harnessCounts[s.harness ?? "claude"]++;

  const filtered = harnessFilter === "all" ? state.sessions : state.sessions.filter((s) => (s.harness ?? "claude") === harnessFilter);
  const bySession = (status: Session["status"]) => filtered.filter((x) => x.status === status);

  // Newest-first activity → first entry per session is its latest tool call.
  const latest = new Map<string, Activity>();
  for (const a of state.activity) {
    if (!latest.has(a.session_id)) latest.set(a.session_id, a);
  }

  // Computed once per render rather than passing the array down to every card.
  const wfRunBySession = new Map(workflows.map((w) => [w.session_id, w.run_id]));

  const renderNode = (node: SessionNode): ReactNode => (
    <div key={node.session.id}>
      <SessionCard
        s={node.session}
        latestTool={latest.get(node.session.id)?.tool}
        latestDetail={latest.get(node.session.id)?.detail ?? null}
        cost={state.cost.perSession[node.session.id]}
        wfRunId={wfRunBySession.get(node.session.id) ?? null}
        spawnedByProject={node.spawnedByProject}
      />
      {node.children.length > 0 && (
        // The same tree-connector idiom as WorkflowsPage's phased agent list -         // one hairline, indented past the rail, ties nested runs to Sessions'
        // visual language (§5.1).
        <div className="ml-rail border-l-hairline border-border-weak pl-3">{node.children.map(renderNode)}</div>
      )}
    </div>
  );

  // §5.2 finding fix: the banner used to gate on `workflows_degraded`, which
  // sums the process-lifetime in-memory counter (uptime causes: a broadcast
  // that threw, a background sweep that failed - never 24h-windowed, never
  // tied to a run) with the persisted per-run count. When only that in-memory
  // counter was nonzero, the banner showed with no run to name and no dismiss
  // button (both require `degradedRun`), which cannot satisfy "shows only
  // when RUNS degraded in the last 24h... dismissible". Gating on
  // `workflows_degraded_run` alone - already the exact 24h-windowed,
  // named-run value - fixes both at once.
  const degradedRun = state.workflows_degraded_run;
  const degradedDismissed = degradedRun != null && dismissedRuns.includes(degradedRun.run_id);
  const showDegradedBanner = degradedRun != null && !degradedDismissed;
  // Every session on the board is one more id this can never forget on its
  // own (localStorage, unbounded) - capped to the most recent 20 dismissals.
  const MAX_DISMISSED_RUNS = 20;
  const dismissRun = (runId: string) => setDismissedRuns([...dismissedRuns, runId].slice(-MAX_DISMISSED_RUNS));

  return (
    <div className="mx-auto max-w-board px-3 pb-16 sm:px-6">
      <AppBar
        state={state}
        workflows={workflows}
        ready={ready}
        route="#/"
        connected={connected}
        lastMessageAt={lastMessageAt}
      />

      <div className="mt-3 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <main className="min-w-0 lg:pr-6">
          {/* First in main, no top margin. Together with the needs_you row tint
              these are the only two tinted surfaces in the whole app. */}
          {showDegradedBanner && degradedRun && (
            <div className="flex h-8 items-center gap-2 rounded-md border-hairline border-attention/25 bg-attention/[0.07] px-2.5 text-2xs text-attention">
              <span className="min-w-0 flex-1 truncate">
                ⚠ workflow data looks off in "{degradedRun.name ?? degradedRun.run_id}" - Claude Code may have changed
                format
              </span>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => dismissRun(degradedRun.run_id)}
                className="shrink-0 text-attention/70 transition-colors duration-quick ease-quad hover:text-attention"
              >
                ✕
              </button>
            </div>
          )}

          {/* Sessions are the reason the page exists; the 40vh caps on Todos and
              Workflows were compensating for them sitting third. */}
          <Lane
            label="Sessions"
            hint="auto - moves itself from agent hook events"
            right={
              <Segmented<HarnessFilter>
                value={harnessFilter}
                onChange={setHarnessFilter}
                options={[
                  // §5.2 finding fix: same "…" not "0" rule as the AppBar and
                  // the column headers below - before `ready`, `harnessCounts`
                  // is just as unknown as everything else derived from `state`.
                  { value: "all", label: `All (${ready ? harnessCounts.all : "…"})` },
                  ...HARNESSES.map((h) => ({
                    value: h as HarnessFilter,
                    label: `${FILTER_LABEL[h]} (${ready ? harnessCounts[h] : "…"})`,
                  })),
                ]}
              />
            }
          >
            {SESSION_COLS.map((c) => {
              const items = bySession(c.id);
              const tree = buildSessionTree(items, state.sessions);
              return (
                <Column key={c.id} title={c.title} dot={c.id} count={items.length} ready={ready}>
                  {!ready ? <ColumnSkeleton /> : tree.map(renderNode)}
                </Column>
              );
            })}
          </Lane>

          <WorkflowsSection workflows={workflows} lastRun={lastRun} />
          <TodosSection todos={state.todos} />
        </main>

        {/* One vertical hairline replaces four bordered card boxes. Below lg the
            grid stacks and the border drops - lg: prefixes only. Order:
            Live Activity, Session cost, Cost breakdown, Tool usage (§5.2) -
            activity is the reason this sidebar exists; the others are context. */}
        <aside className="mt-6 lg:sticky lg:top-14 lg:mt-0 lg:border-l-hairline lg:border-border-weak lg:pl-6">
          <ActivityFeed activity={state.activity} sessions={state.sessions} />
          <CostPanel cost={state.cost} />
          <CostBreakdown cost={state.cost} />
          <ToolStats stats={state.stats} />
        </aside>
      </div>
    </div>
  );
}
