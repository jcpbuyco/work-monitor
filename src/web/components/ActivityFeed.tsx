import type { Activity, Session } from "../types.ts";
import { ago } from "../time.ts";
import { prettyTool, toolDot } from "../tools.ts";

const MAX_ROWS = 24;

export function ActivityFeed({ activity, sessions }: { activity: Activity[]; sessions: Session[] }) {
  const projectFor = (id: string) => sessions.find((s) => s.id === id)?.project ?? "—";
  const rows = activity.slice(0, MAX_ROWS);

  return (
    <section className="mt-7">
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <span className="inline-flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          <span className="relative flex h-2 w-2" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
          ⚡ Live activity
        </span>
        <span className="rounded-full border border-border bg-chip px-2 py-0.5 text-2xs text-muted-foreground">
          tool calls · newest first
        </span>
      </div>

      <div className="max-h-[calc(100vh-8rem)] overflow-y-auto rounded-xl border border-border bg-card/50">
        {rows.length === 0 ? (
          <div className="px-3 py-6 text-center text-2xs text-muted-foreground">Waiting for tool activity…</div>
        ) : (
          <ul className="divide-y divide-border/60">
            {rows.map((a) => (
              <li key={a.id} className="wm-row-in flex items-center gap-3 px-3 py-2 font-mono text-2xs">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${toolDot(a.tool)}`} />
                <span className="shrink-0 font-semibold text-foreground">{prettyTool(a.tool)}</span>
                <span className="truncate text-muted-foreground/70">{projectFor(a.session_id)}</span>
                <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/60">{ago(a.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
