import type { Activity, Session } from "../types.ts";
import { ago } from "../time.ts";
import { prettyTool, toolDot, formatDur } from "../tools.ts";
import { useFeedLimit } from "../useFeedLimit.ts";

export function ActivityFeed({ activity, sessions }: { activity: Activity[]; sessions: Session[] }) {
  const { limit, setLimit, options } = useFeedLimit();
  const projectFor = (id: string) => sessions.find((s) => s.id === id)?.project ?? "—";
  const rows = activity.slice(0, limit);

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
        <div className="group relative inline-flex items-center">
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            aria-label="Number of tool calls to show"
            className="cursor-pointer appearance-none rounded-full border border-border bg-chip py-1 pl-3 pr-7 text-2xs text-muted-foreground transition hover:text-foreground"
          >
            {options.map((n) => (
              <option key={n} value={n}>last {n}</option>
            ))}
          </select>
          <svg
            aria-hidden="true"
            viewBox="0 0 12 12"
            className="pointer-events-none absolute right-2.5 h-2.5 w-2.5 text-muted-foreground/70 transition group-hover:text-foreground"
          >
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>

      <div className="max-h-[calc(100vh-8rem)] overflow-y-auto pr-0.5">
        {rows.length === 0 ? (
          <div className="rounded-xl border border-border bg-card/50 px-3 py-6 text-center text-2xs text-muted-foreground">
            Waiting for tool activity…
          </div>
        ) : (
          <ul className="space-y-2">
            {rows.map((a, i) => {
              // animationDelay → staggered cascade on load; viewTransitionName →
              // existing rows slide down when a newer call is inserted on top.
              const liStyle: Record<string, string> = {
                animationDelay: `${Math.min(i, 10) * 30}ms`,
                viewTransitionName: `vt-a-${a.id}`,
              };
              return (
              <li
                key={a.id}
                style={liStyle}
                className="am-row-in rounded-lg border border-border bg-card/60 px-3 py-2 font-mono text-2xs shadow-card transition hover:bg-card-hover"
              >
                <div className="flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${toolDot(a.tool)}`} />
                  <span className="shrink-0 font-semibold text-foreground">{prettyTool(a.tool)}</span>
                  {a.dur != null && (
                    <span className="shrink-0 tabular-nums text-muted-foreground/45">{formatDur(a.dur)}</span>
                  )}
                  <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/55">{ago(a.at)}</span>
                </div>
                <div className="mt-0.5 flex items-baseline gap-2 pl-3.5">
                  <span className="min-w-0 flex-1 truncate text-muted-foreground/80">{a.detail ?? ""}</span>
                  <span className="shrink-0 text-muted-foreground/45">{projectFor(a.session_id)}</span>
                </div>
              </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
