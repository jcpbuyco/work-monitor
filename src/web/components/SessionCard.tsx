import type { CSSProperties } from "react";
import type { Session, SessionCost } from "../types.ts";
import { ago } from "../time.ts";
import { prettyTool } from "../tools.ts";
import { formatUsd, formatTokens } from "../cost.ts";
import { StatusGlyph, type GlyphKind } from "./StatusGlyph.tsx";
import { ListRow, Rail, Chip } from "./primitives.tsx";

/** Rows in the idle group are drawn in ink-4, not `idle`: the GROUP HEADER
 *  carries the semantic colour once (Lane.tsx), and the rows recede. */
const STATUS: Record<string, { kind: GlyphKind; tone: string; label: string }> = {
  working: { kind: "working", tone: "text-working", label: "Working" },
  needs_you: { kind: "needs_you", tone: "text-attention", label: "Needs you" },
  idle: { kind: "idle", tone: "text-ink-4", label: "Idle" },
  ended: { kind: "ended", tone: "text-ink-4", label: "Ended" },
};

export function SessionCard({
  s,
  latestTool,
  latestDetail,
  cost,
  wf = false,
}: {
  s: Session;
  latestTool?: string;
  latestDetail?: string | null;
  cost?: SessionCost;
  wf?: boolean;
}) {
  const st = STATUS[s.status] ?? STATUS.idle;
  const isWorking = s.status === "working";
  const compact = s.status === "idle" || s.status === "ended";
  const task = s.current_task ?? s.current_intent ?? "—";

  // Stable name so a status change (group move) tweens between positions.
  const style: CSSProperties = {};
  (style as Record<string, string>).viewTransitionName = `vt-s-${s.id}`;

  if (compact) {
    return (
      <ListRow
        data-testid="session-row"
        data-status={s.status}
        className="am-fade-in flex items-center py-1"
        style={style}
      >
        <Rail>
          <StatusGlyph kind={st.kind} animate={false} className={st.tone} />
        </Rail>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="sr-only">{st.label}</span>
          <span className="shrink-0 text-xs text-ink-2">{s.project}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-ink-4">{task}</span>
          {cost && (
            <span className="shrink-0 font-mono text-2xs tabular-nums slashed-zero text-ink-4">
              {formatUsd(cost.costUsd)}
            </span>
          )}
          <span className="w-14 shrink-0 text-right font-mono text-2xs tabular-nums text-ink-4">
            {ago(s.last_activity_at)}
          </span>
        </div>
      </ListRow>
    );
  }

  return (
    <ListRow
      data-testid="session-row"
      data-status={s.status}
      tone={s.status === "needs_you" ? "attention" : "default"}
      className="am-fade-in relative py-1.5"
      style={style}
    >
      <div className="flex items-center">
        <Rail>
          <StatusGlyph kind={st.kind} className={st.tone} />
        </Rail>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {/* removing the visible status label must not remove status from the
              accessibility tree — the glyph is aria-hidden */}
          <span className="sr-only">{st.label}</span>
          <span className="shrink-0 text-sm font-medium text-ink">{s.project}</span>
          {wf && (
            <Chip data-testid="wf-badge" tone="working" title="owns a live workflow run">
              wf
            </Chip>
          )}
          <span className="min-w-0 flex-1 truncate text-sm text-ink-3">{task}</span>
          {s.branch && <span className="shrink-0 font-mono text-2xs text-ink-4">⎇ {s.branch}</span>}
          {cost && (
            <span className="shrink-0 font-mono text-2xs tabular-nums slashed-zero text-ink-4">
              {formatUsd(cost.costUsd)} · {formatTokens(cost.tokens)} tok
            </span>
          )}
          <span className="w-14 shrink-0 text-right font-mono text-2xs tabular-nums text-ink-4">
            {ago(s.last_activity_at)}
          </span>
        </div>
      </div>

      {isWorking && s.active_tool ? (
        <div className="flex min-w-0 items-center gap-1.5 pl-rail font-mono text-2xs text-working">
          <span className="am-spin inline-block" aria-hidden="true">⟳</span>
          <span className="truncate">{prettyTool(s.active_tool)}…</span>
        </div>
      ) : isWorking && latestTool ? (
        <div className="flex min-w-0 items-center gap-1.5 pl-rail font-mono text-2xs text-working/80">
          <span aria-hidden="true">▸</span>
          <span className="truncate">
            {prettyTool(latestTool)}
            {latestDetail ? <span className="text-working/60"> · {latestDetail}</span> : null}
          </span>
        </div>
      ) : null}

      {/* the guard is preserved: a needs-you session with a null reason renders
          no second line rather than a bare ⚠ */}
      {s.attention_reason && s.status === "needs_you" && (
        <div className="truncate pl-rail font-mono text-2xs text-attention">⚠ {s.attention_reason}</div>
      )}

      {/* a 1px underline at the row's bottom edge, rail → right */}
      {isWorking && (
        <span aria-hidden="true" className="am-shimmer absolute bottom-0 left-rail right-0 h-px bg-working/[0.14]" />
      )}
    </ListRow>
  );
}
