import type { LiveWorkflow } from "../types.ts";
import { formatUsd, formatTokens, prettyModel } from "../cost.ts";
import { formatDuration } from "../time.ts";
import { statusClass, statusKnown, statusGlyphKind, agentStateDotClass } from "../workflowStatus.ts";
import { usePersistedToggle } from "../usePersistedToggle.ts";
import { StatusGlyph } from "./StatusGlyph.tsx";
import { ListRow, Rail, Chip, Chevron } from "./primitives.tsx";

export function WorkflowRunCard({ w }: { w: LiveWorkflow }) {
  const [collapsed, toggleCollapsed] = usePersistedToggle(`am-wf-${w.run_id}`);
  const label = w.status ?? w.state;
  const title = w.name ?? w.run_id;
  const pct = w.phase ? Math.round((w.phase.index / w.phase.total) * 100) : 0;

  return (
    <ListRow data-testid="wf-run-row" className="am-fade-in py-1.5">
      <div className="flex items-center">
        <Rail>
          {/* colour comes from statusClass, so glyph and label always agree */}
          <StatusGlyph kind={statusGlyphKind(label)} className={statusClass(label)} />
        </Rail>
        {/* §5.2 phone fix: `flex-wrap` plus a `min-w-0 truncate` project/branch
            span (was `shrink-0`, so it never gave an inch and pushed the row
            past 390px in real data - "mediva-import · feat/single-repo-nextjs"
            alone is wider than the viewport). Everything else keeps its full
            text and simply drops to its own line if the row runs out of
            room, so nothing is ever clipped mid-word. */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-ink transition-colors duration-quick ease-quad hover:text-accent"
          >
            <Chevron open={!collapsed} />
            {title}
          </button>
          <span
            className="min-w-0 max-w-full flex-1 truncate font-mono text-2xs text-ink-4"
            title={`${w.project} · ${w.branch ?? "-"}`}
          >
            {w.project} · {w.branch ?? "-"}
          </span>
          <span
            data-status-known={String(statusKnown(label))}
            className={`shrink-0 text-2xs font-medium ${statusClass(label)}`}
          >
            {label}
          </span>
          {!w.schema_ok && <Chip>structure unavailable</Chip>}
          <span className="ml-auto shrink-0 font-mono text-2xs tabular-nums text-ink-3">
            {/* Ticks because WorkflowsSection re-renders at 1Hz via useNow(). */}
            {w.started_at != null ? formatDuration(Date.now() - w.started_at) : "-"}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pl-rail font-mono text-2xs">
        <span className="text-ink-4">
          {w.phase ? `Phase ${w.phase.index}/${w.phase.total} · ${w.phase.title}` : "phases resolve on completion"}
        </span>
        <span className="text-ink">{formatUsd(w.costUsd)}</span>
        <span className="text-ink-4">{formatTokens(w.tokens)} tok</span>
      </div>

      {w.phase && (
        <div className="pl-rail">
          <div className="h-0.5 rounded bg-surface-3">
            {/* NO transition: this is fed by the 5s workflows channel and must
                not animate layout (§5.5 rule 1). */}
            <div data-phase-bar="true" className="h-full rounded bg-working/50" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {!collapsed && (
        <div className="mt-1 flex flex-col">
          {w.agents.map((a) => (
            <div key={a.agent_id} className="flex h-6 min-w-0 items-center gap-2 pl-10 font-mono text-2xs">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${agentStateDotClass(a.state)}`} />
              {/* Labels live only in the manifest, so agentId is the common live case. */}
              <span className="truncate text-ink-2">{a.label ?? a.agent_id}</span>
              <span className="shrink-0 text-ink-4">{a.model ? prettyModel(a.model) : "-"}</span>
              <span className="w-14 shrink-0 text-right tabular-nums text-ink-4">{formatTokens(a.tokens)}</span>
              {a.last_tool && <span className="truncate text-working/70">▸ {a.last_tool}</span>}
            </div>
          ))}
        </div>
      )}
    </ListRow>
  );
}
