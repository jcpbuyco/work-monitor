import { useEffect, useMemo, useState } from "react";
import { formatUsd, formatTokens, prettyModel, costDailyRange, type CostWindow } from "../cost.ts";
import { formatDuration, formatWhen } from "../time.ts";
import { statusClass, statusKnown } from "../workflowStatus.ts";
import type { WorkflowRun, WorkflowAgentView } from "../types.ts";

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

function sortValue(r: WorkflowRun, key: SortKey): number | string {
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
      return r.agents.length;
    case "tokens":
      return r.tokens;
    case "cost":
      return r.costUsd;
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
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "when", dir: "desc" });
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    const { since } = costDailyRange(range, Date.now());
    const qs = since != null ? `?since=${since}&limit=500` : "?limit=500";
    fetch(`/api/workflows${qs}`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        setRuns(Array.isArray(body?.runs) ? (body.runs as WorkflowRun[]) : []);
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
        (t, r) => ({ agents: t.agents + r.agents.length, tokens: t.tokens + r.tokens, cost: t.cost + r.costUsd }),
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

  const toggleOpen = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="mx-auto max-w-6xl px-4 pb-12">
      <header className="sticky top-0 z-10 -mx-4 mb-4 flex flex-wrap items-center gap-3 border-b border-border bg-background/85 px-4 py-3 backdrop-blur">
        <a href="#/" className="text-sm text-muted-foreground transition hover:text-foreground">
          ← Dashboard
        </a>
        <span className="font-semibold tracking-tight text-foreground">Workflow runs</span>
        <div className="ml-auto inline-flex h-9 items-center overflow-hidden rounded-lg border border-border bg-muted text-sm text-muted-foreground">
          {WINDOWS.map((w) => (
            <button
              key={String(w)}
              type="button"
              onClick={() => setRange(w)}
              className={`flex h-full items-center px-3 leading-none transition hover:text-foreground ${
                range === w ? "bg-chip text-foreground" : ""
              }`}
            >
              {w === "all" ? "All" : `${w}d`}
            </button>
          ))}
        </div>
      </header>

      {/* Same four states, in the same order, as CostDailyPage: error → loading →
          empty → table. Without the loading branch the totals row renders "0 runs"
          for one frame on every window change. */}
      {status === "error" ? (
        <p className="px-2 py-8 text-center text-sm text-muted-foreground">Couldn’t load workflow runs.</p>
      ) : status === "loading" ? (
        <p className="px-2 py-8 text-center text-sm text-muted-foreground">Loading…</p>
      ) : sorted.length === 0 ? (
        <p className="px-2 py-8 text-center text-sm text-muted-foreground">No workflow runs in this window.</p>
      ) : (
        <>
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
            {sorted.map((r) => {
              const label = r.status ?? r.state;
              return [
                <tr
                  key={r.run_id}
                  onClick={() => toggleOpen(r.run_id)}
                  className="cursor-pointer border-b border-border/50 hover:bg-card-hover"
                >
                  <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{formatWhen(r.started_at)}</td>
                  <td className="px-2 py-1 font-semibold text-foreground">
                    {r.name ?? r.run_id}
                    {!r.schema_ok && (
                      <span className="ml-1.5 rounded-full border border-border bg-chip px-1.5 py-0.5 text-[0.65rem] text-muted-foreground">
                        structure unavailable
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">
                    {r.project} · {r.branch ?? "—"}
                  </td>
                  <td data-status-known={String(statusKnown(label))} className={`px-2 py-1 ${statusClass(label)}`}>
                    {label}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{formatDuration(r.duration_ms)}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{r.agents.length}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-muted-foreground/70">{formatTokens(r.tokens)}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-foreground">{formatUsd(r.costUsd)}</td>
                </tr>,
                open.has(r.run_id) ? (
                  <tr key={`${r.run_id}-detail`} className="border-b border-border/50 bg-card/40">
                    <td colSpan={COLS.length} className="px-3 py-2">
                      {byPhase(r.agents).map((g) => (
                        <div key={g.title} className="mb-2 last:mb-0">
                          <div className="mb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                            {g.title}
                          </div>
                          {g.agents.map((a) => (
                            <div key={a.agent_id} className="flex flex-wrap items-baseline gap-2 py-0.5">
                              <span className="font-semibold text-foreground">{a.label ?? a.agent_id}</span>
                              <span className="text-muted-foreground">{a.model ? prettyModel(a.model) : "—"}</span>
                              <span className="text-muted-foreground">{a.state ?? "—"}</span>
                              <span className="text-muted-foreground/70">attempt {a.attempt ?? 1}</span>
                              <span className="text-muted-foreground/70">{formatDuration(a.duration_ms)}</span>
                              <span className="tabular-nums text-muted-foreground/70">{formatTokens(a.tokens)}</span>
                              <span className="tabular-nums text-foreground">{formatUsd(a.costUsd)}</span>
                              {a.last_tool_summary && (
                                <span className="truncate text-muted-foreground/70">▸ {a.last_tool_summary}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      ))}
                    </td>
                  </tr>
                ) : null,
              ];
            })}
            <tr data-testid="wf-totals" className="border-t border-border font-semibold text-foreground">
              <td className="px-2 py-1" />
              <td className="px-2 py-1">{sorted.length} runs</td>
              <td className="px-2 py-1" />
              <td className="px-2 py-1" />
              <td className="px-2 py-1" />
              <td className="px-2 py-1 text-right tabular-nums">{totals.agents}</td>
              <td className="px-2 py-1 text-right tabular-nums">{formatTokens(totals.tokens)}</td>
              <td className="px-2 py-1 text-right tabular-nums">{formatUsd(totals.cost)}</td>
            </tr>
          </tbody>
        </table>
        {sorted.find((r) => r.cc_version)?.cc_version && (
          <p className="mt-3 px-2 text-2xs text-muted-foreground/70">
            format last verified on {sorted.find((r) => r.cc_version)!.cc_version}
          </p>
        )}
        </>
      )}
    </div>
  );
}
