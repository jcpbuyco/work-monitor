import { useEffect, useMemo, useState } from "react";
import { formatUsd, formatTokens, prettyModel, costDailyRange, type CostWindow } from "../cost.ts";
import { formatDuration, formatWhen } from "../time.ts";
import { statusClass, statusKnown, statusGlyphKind } from "../workflowStatus.ts";
import { PageHeader, Segmented, Chip, Chevron } from "./primitives.tsx";
import { StatusGlyph } from "./StatusGlyph.tsx";
import type { WorkflowRunSummary, WorkflowRun, WorkflowAgentView } from "../types.ts";

type SortKey = "when" | "workflow" | "project" | "status" | "duration" | "agents" | "tokens" | "cost";

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

/** Agents grouped under their 1-based phase, with unphased agents last. */
function byPhase(agents: WorkflowAgentView[]): { title: string; agents: WorkflowAgentView[] }[] {
  const groups = new Map<number, WorkflowAgentView[]>();
  const unphased: WorkflowAgentView[] = [];
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

export function WorkflowsPage() {
  // Named `range`, not `window`, exactly as in CostDailyPage: a state variable
  // called `window` shadows the DOM global for the whole component body.
  const [range, setRange] = useState<CostWindow>(14);
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "when", dir: "desc" });
  const [open, setOpen] = useState<Set<string>>(new Set());
  // §3: the list no longer carries agents -- an expanded row fetches its own
  // detail from GET /api/workflows/:runId, once, and keeps it here.
  const [details, setDetails] = useState<Record<string, WorkflowRun | "loading" | "error">>({});

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    const { since } = costDailyRange(range, Date.now());
    const qs = since != null ? `?since=${since}&limit=500` : "?limit=500";
    fetch(`/api/workflows${qs}`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        setRuns(Array.isArray(body?.runs) ? (body.runs as WorkflowRunSummary[]) : []);
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

  // Fetches the run's agents lazily, once, on its first expand -- the list
  // endpoint deliberately never carries them (§3). The fetch is a plain side
  // effect in the event handler body, never inside a `setDetails` updater
  // function: React.StrictMode (main.tsx) invokes updater functions twice in
  // development, so a fetch launched from inside one fires twice per click.
  // "error" is retryable on the next expand rather than sticking forever;
  // "loading" (an in-flight fetch from a prior click) still short-circuits.
  const toggleOpen = (id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    const existing = details[id];
    if (existing && existing !== "error") return; // already fetched, or a fetch is already in flight
    setDetails((d) => ({ ...d, [id]: "loading" }));
    fetch(`/api/workflows/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((run: WorkflowRun) => setDetails((d) => ({ ...d, [id]: run })))
      .catch(() => setDetails((d) => ({ ...d, [id]: "error" })));
  };

  return (
    <div className="mx-auto max-w-board px-6 pb-16">
      <PageHeader
        title="Workflow runs"
        right={
          <Segmented
            value={range}
            onChange={setRange}
            options={WINDOWS.map((w) => ({ value: w, label: w === "all" ? "All" : `${w}d` }))}
          />
        }
      />

      {/* Same four states, in the same order, as CostDailyPage: error → loading →
          empty → table. Without the loading branch the totals row renders "0 runs"
          for one frame on every window change. */}
      {status === "error" ? (
        <p className="py-16 text-center text-sm text-ink-3">Couldn’t load workflow runs.</p>
      ) : status === "loading" ? (
        <p role="status" aria-live="polite" className="py-16 text-center text-sm text-ink-3">Loading…</p>
      ) : sorted.length === 0 ? (
        <p className="py-16 text-center text-sm text-ink-3">No workflow runs in this window.</p>
      ) : (
        <>
          <table className="w-full border-collapse font-mono text-xs">
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th
                    key={c.key}
                    aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                    className={`sticky top-12 z-10 h-8 border-b border-border bg-surface-0 px-2 text-left font-normal ${c.numeric ? "text-right" : ""}`}
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
              {sorted.map((r) => {
                const label = r.status ?? r.state;
                return [
                  <tr
                    key={r.run_id}
                    data-testid="wf-row"
                    onClick={() => toggleOpen(r.run_id)}
                    className="h-8 cursor-pointer border-b border-border-weak transition-colors duration-quick ease-quad hover:bg-surface-2"
                  >
                    <td className="px-2 py-[0.3125rem] text-right tabular-nums text-ink-3">{formatWhen(r.started_at)}</td>
                    <td className="px-2 py-[0.3125rem] font-medium text-ink">
                      {/* SVG only — no text content, or findByText("research") stops resolving */}
                      <span className="mr-1.5 inline-flex align-[-0.1em]">
                        <Chevron open={open.has(r.run_id)} />
                      </span>
                      {r.name ?? r.run_id}
                      {!r.schema_ok && (
                        <Chip className="ml-1.5">structure unavailable</Chip>
                      )}
                    </td>
                    <td className="px-2 py-[0.3125rem] text-ink-3">
                      {r.project} · {r.branch ?? "—"}
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
                    <td className="px-2 py-[0.3125rem] text-right tabular-nums text-ink-3">{formatDuration(r.duration_ms)}</td>
                    <td className="px-2 py-[0.3125rem] text-right tabular-nums text-ink-3">{r.agent_counts.total}</td>
                    <td className="px-2 py-[0.3125rem] text-right tabular-nums slashed-zero text-ink-4">{formatTokens(r.tokens)}</td>
                    <td className="px-2 py-[0.3125rem] text-right tabular-nums slashed-zero text-ink">{formatUsd(r.costUsd)}</td>
                  </tr>,
                  open.has(r.run_id) ? (
                    <tr key={`${r.run_id}-detail`} className="border-b border-border-weak bg-surface-1">
                      <td colSpan={COLS.length} className="px-3 py-2">
                        {(() => {
                          const detail = details[r.run_id];
                          if (detail === "loading" || detail === undefined) {
                            return <p className="text-2xs text-ink-4">Loading agents…</p>;
                          }
                          if (detail === "error") {
                            return <p className="text-2xs text-ink-4">Couldn’t load agents.</p>;
                          }
                          return byPhase(detail.agents).map((g) => (
                            <div key={g.title} className="mb-2 last:mb-0">
                              <div className="text-3xs uppercase tracking-caps text-ink-4">{g.title}</div>
                              {/* the rail one more time, now as a tree: a hairline
                                  connecting agents under their phase */}
                              <div className="ml-rail border-l-hairline border-border-weak pl-3">
                                {g.agents.map((a) => (
                                  <div key={a.agent_id} className="flex h-6 flex-wrap items-center gap-3 text-2xs">
                                    <span className="font-medium text-ink">{a.label ?? a.agent_id}</span>
                                    <span className="text-ink-3">{a.model ? prettyModel(a.model) : "—"}</span>
                                    <span className="text-ink-3">{a.state ?? "—"}</span>
                                    <span className="text-ink-4">attempt {a.attempt ?? 1}</span>
                                    <span className="text-ink-4">{formatDuration(a.duration_ms)}</span>
                                    <span className="tabular-nums slashed-zero text-ink-4">{formatTokens(a.tokens)}</span>
                                    <span className="tabular-nums slashed-zero text-ink">{formatUsd(a.costUsd)}</span>
                                    {a.last_tool_summary && <span className="truncate text-working/70">▸ {a.last_tool_summary}</span>}
                                  </div>
                                ))}
                              </div>
                            </div>
                          ));
                        })()}
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
              <tr data-testid="wf-totals" className="border-t border-border bg-surface-1 font-semibold text-ink">
                <td className="px-2 py-[0.3125rem]" />
                <td className="px-2 py-[0.3125rem]">{sorted.length} runs</td>
                <td className="px-2 py-[0.3125rem]" />
                <td className="px-2 py-[0.3125rem]" />
                <td className="px-2 py-[0.3125rem]" />
                <td className="px-2 py-[0.3125rem] text-right tabular-nums">{totals.agents}</td>
                <td className="px-2 py-[0.3125rem] text-right tabular-nums slashed-zero">{formatTokens(totals.tokens)}</td>
                <td className="px-2 py-[0.3125rem] text-right tabular-nums slashed-zero">{formatUsd(totals.cost)}</td>
              </tr>
            </tbody>
          </table>
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
