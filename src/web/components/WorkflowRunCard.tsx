import type { LiveWorkflow } from "../types.ts";
import { formatUsd, formatTokens, prettyModel } from "../cost.ts";
import { formatDuration } from "../time.ts";
import { statusClass, statusKnown } from "../workflowStatus.ts";
import { usePersistedToggle } from "../usePersistedToggle.ts";

const AGENT_DOT: Record<string, string> = {
  running: "bg-working animate-pulse",
  done: "bg-idle",
  abandoned: "bg-attention/60",
};

export function WorkflowRunCard({ w }: { w: LiveWorkflow }) {
  const [collapsed, toggleCollapsed] = usePersistedToggle(`am-wf-${w.run_id}`);
  const label = w.status ?? w.state;
  const title = w.name ?? w.run_id;

  return (
    <div className="am-fade-in mb-2 rounded-lg border border-border bg-card p-3 shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          className="inline-flex items-center gap-2 font-medium text-foreground transition hover:text-primary"
        >
          <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
          {title}
        </button>
        <span className="rounded-full border border-border bg-chip px-2 py-0.5 text-2xs text-muted-foreground">
          {w.project} · {w.branch ?? "—"}
        </span>
        <span data-status-known={String(statusKnown(label))} className={`text-2xs font-semibold ${statusClass(label)}`}>
          {label}
        </span>
        {!w.schema_ok && (
          <span className="rounded-full border border-border bg-chip px-2 py-0.5 text-2xs text-muted-foreground">
            structure unavailable
          </span>
        )}
        <span className="ml-auto font-mono text-2xs text-muted-foreground/70">
          {/* Ticks because WorkflowsSection re-renders at 1Hz via useNow(). */}
          {w.started_at != null ? formatDuration(Date.now() - w.started_at) : "—"}
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-2xs">
        <span className="rounded-full border border-border bg-chip px-2 py-0.5 text-muted-foreground">
          {w.phase ? `Phase ${w.phase.index}/${w.phase.total} · ${w.phase.title}` : "phases resolve on completion"}
        </span>
        <span className="text-foreground">{formatUsd(w.costUsd)}</span>
        <span className="text-muted-foreground/70">{formatTokens(w.tokens)} tok</span>
      </div>

      {!collapsed && (
        <div className="mt-2 flex flex-col gap-1">
          {w.agents.map((a) => (
            <div key={a.agent_id} className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-2xs">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${AGENT_DOT[a.state ?? ""] ?? "bg-idle"}`} />
              {/* Labels live only in the manifest, so agentId is the common live case. */}
              <span className="truncate text-foreground">{a.label ?? a.agent_id}</span>
              <span className="text-muted-foreground/70">{a.model ? prettyModel(a.model) : "—"}</span>
              <span className="tabular-nums text-muted-foreground/70">{formatTokens(a.tokens)}</span>
              {a.last_tool && <span className="truncate text-working/80">▸ {a.last_tool}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
