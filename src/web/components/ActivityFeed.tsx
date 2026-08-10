import type { Activity, Session } from "../types.ts";
import { ago } from "../time.ts";
import { prettyTool, toolDot, formatDur } from "../tools.ts";
import { useFeedLimit } from "../useFeedLimit.ts";
import { SectionHeader, Rail, ROW_BASE, ROW_TONE } from "./primitives.tsx";

/** Bottom fade so the feed ends instead of being guillotined. React does not
 *  auto-prefix maskImage, so BOTH properties are set to the SAME value. rem,
 *  not px, so the fade scales with the text-size ladder. */
const FADE = "linear-gradient(to bottom,#000 calc(100% - 1.5rem),transparent)";

export function ActivityFeed({ activity, sessions }: { activity: Activity[]; sessions: Session[] }) {
  const { limit, setLimit, options } = useFeedLimit();
  const projectFor = (id: string) => sessions.find((s) => s.id === id)?.project ?? "—";
  const rows = activity.slice(0, limit);

  return (
    <section className="mt-6">
      <SectionHeader
        label="⚡ Live activity"
        leading={
          <span className="relative flex h-2 w-2" aria-hidden="true">
            <span className="am-ping absolute inline-flex h-full w-full rounded-full bg-accent/60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
          </span>
        }
        right={
          <div className="group relative inline-flex items-center">
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              aria-label="Number of tool calls to show"
              className="h-6 cursor-pointer appearance-none rounded-md border-hairline border-border bg-transparent pl-2 pr-6 text-2xs text-ink-3 transition-colors duration-quick ease-quad hover:text-ink"
            >
              {options.map((n) => (
                <option key={n} value={n}>last {n}</option>
              ))}
            </select>
            <svg
              aria-hidden="true"
              viewBox="0 0 12 12"
              className="pointer-events-none absolute right-2 h-2.5 w-2.5 text-ink-4"
            >
              <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        }
      />

      <div
        className="max-h-[calc(100vh-8rem)] overflow-y-auto -mx-1.5 px-1.5"
        style={{ WebkitMaskImage: FADE, maskImage: FADE }}
      >
        {rows.length === 0 ? (
          <div className="py-6 text-center text-2xs text-ink-4">Waiting for tool activity…</div>
        ) : (
          <ul>
            {rows.map((a, i) => {
              // animationDelay → staggered cascade on load; viewTransitionName →
              // existing rows slide down when a newer call is inserted on top.
              const liStyle: Record<string, string> = {
                animationDelay: `${Math.min(i, 6) * 16}ms`,
                viewTransitionName: `vt-a-${a.id}`,
              };
              return (
                <li key={a.id} style={liStyle} className={`am-row-in py-1 font-mono text-2xs ${ROW_BASE} ${ROW_TONE.default}`}>
                  <div className="flex items-center">
                    <Rail>
                      <span className={`h-1.5 w-1.5 rounded-full ${toolDot(a.tool)}`} />
                    </Rail>
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="shrink-0 font-medium text-ink">{prettyTool(a.tool)}</span>
                      {a.dur != null && <span className="shrink-0 tabular-nums text-ink-4">{formatDur(a.dur)}</span>}
                      <span className="ml-auto shrink-0 tabular-nums text-ink-4">{ago(a.at)}</span>
                    </div>
                  </div>
                  <div className="flex items-baseline gap-2 pl-rail">
                    <span className="min-w-0 flex-1 truncate text-ink-3">{a.detail ?? ""}</span>
                    <span className="shrink-0 text-ink-4">{projectFor(a.session_id)}</span>
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
