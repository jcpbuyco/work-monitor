import type { Session } from "../types.ts";
import { ago } from "../time.ts";
import { prettyTool } from "../tools.ts";

const STATUS: Record<string, { accent: string; label: string; dot: string; pulse?: boolean }> = {
  working: { accent: "var(--working)", label: "Working", dot: "bg-working", pulse: true },
  needs_you: { accent: "var(--attention)", label: "Needs you", dot: "bg-attention" },
  idle: { accent: "var(--idle)", label: "Idle", dot: "bg-idle" },
  ended: { accent: "var(--idle)", label: "Ended", dot: "bg-idle" },
};

export function SessionCard({ s, latestTool }: { s: Session; latestTool?: string }) {
  const st = STATUS[s.status] ?? STATUS.idle;
  const isWorking = s.status === "working";
  return (
    <div
      className="wm-fade-in mb-2 rounded-lg border border-border bg-card p-3 shadow-card transition hover:bg-card-hover hover:shadow-card-hover"
      style={{ borderLeft: `3px solid hsl(${st.accent})` }}
    >
      <div className="font-medium text-foreground">{s.project}</div>
      <div
        className="mt-0.5 inline-flex items-center gap-1.5 text-2xs font-semibold"
        style={{ color: `hsl(${st.accent})` }}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${st.dot}${st.pulse ? " animate-pulse" : ""}`} />
        {st.label}
      </div>
      <div className="mt-1.5 text-xs text-muted-foreground">
        {s.current_task ?? s.current_intent ?? "—"}
      </div>
      {isWorking && latestTool && (
        <div className="mt-1.5 flex items-center gap-1.5 font-mono text-2xs text-working">
          <span aria-hidden="true">▸</span>
          <span className="truncate">{prettyTool(latestTool)}</span>
        </div>
      )}
      {s.attention_reason && s.status === "needs_you" && (
        <div className="mt-2 rounded-md border border-attention/25 bg-attention/10 px-2 py-1.5 text-xs text-attention">
          ⚠ {s.attention_reason}
        </div>
      )}
      {s.branch && <div className="mt-2 text-2xs text-muted-foreground/70">⎇ {s.branch}</div>}
      {isWorking && <div className="wm-shimmer mt-2 h-0.5 w-full rounded-full bg-working/15" />}
      <div className="mt-2 text-2xs text-muted-foreground/70">{ago(s.last_activity_at)}</div>
    </div>
  );
}
