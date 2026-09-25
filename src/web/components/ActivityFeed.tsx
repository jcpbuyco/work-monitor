import { useState } from "react";
import type { Activity, Session } from "../types.ts";
import { ago } from "../time.ts";
import { prettyTool, toolDot, formatDur } from "../tools.ts";
import { useFeedLimit } from "../useFeedLimit.ts";
import { HarnessMark } from "./HarnessMark.tsx";
import { SectionHeader, Rail, ROW_BASE, ROW_TONE } from "./primitives.tsx";

/** Bottom fade so the feed ends instead of being guillotined. React does not
 *  auto-prefix maskImage, so BOTH properties are set to the SAME value. rem,
 *  not px, so the fade scales with the text-size ladder. */
const FADE = "linear-gradient(to bottom,#000 calc(100% - 1.5rem),transparent)";

const CARET =
  "M2.5 4.5 6 8l3.5-3.5";

function DownCaret() {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" className="pointer-events-none absolute right-2 h-2.5 w-2.5 text-ink-4">
      <path d={CARET} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ActivityFeed({ activity, sessions }: { activity: Activity[]; sessions: Session[] }) {
  const { limit, setLimit, options } = useFeedLimit();
  const [sessionFilter, setSessionFilter] = useState<string>("all");
  const projectFor = (id: string) => sessions.find((s) => s.id === id)?.project ?? "—";
  const labelFor = (a: Activity) => a.session_label ?? projectFor(a.session_id);

  // §5.2: distinct sessions actually present in the feed, for the filter
  // select - built from `activity` itself (not `sessions`) so a session that
  // has since ended but still has recent rows stays selectable.
  const sessionOptions = new Map<string, string>();
  for (const a of activity) if (!sessionOptions.has(a.session_id)) sessionOptions.set(a.session_id, labelFor(a));
  // §5.2 finding fix: a session actively FILTERED ON can roll out of the feed
  // entirely (its own rows aged past `limit`, or the filter narrowed to a
  // session with none), which used to both hide the select (stranding the
  // user mid-filter, `activity.filter` still applying with no visible way to
  // reset it) and point its `value` at a missing `<option>`. Keeping the
  // selected id in the option list even with zero current rows fixes both.
  if (sessionFilter !== "all" && !sessionOptions.has(sessionFilter)) {
    sessionOptions.set(sessionFilter, sessions.find((s) => s.id === sessionFilter)?.project ?? sessionFilter);
  }

  const filtered = sessionFilter === "all" ? activity : activity.filter((a) => a.session_id === sessionFilter);
  const rows = filtered.slice(0, limit);

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
          <div className="flex items-center gap-1.5">
            {/* §5.2 finding fix: stays visible while a filter is actively
                applied, even once the feed narrows to one session (or the
                filtered session has no current rows at all) - otherwise the
                control that clears the filter disappears while the filter
                still applies. */}
            {(sessionOptions.size > 1 || sessionFilter !== "all") && (
              <div className="group relative inline-flex items-center">
                <select
                  value={sessionFilter}
                  onChange={(e) => setSessionFilter(e.target.value)}
                  aria-label="Filter activity by session"
                  className="h-6 max-w-[9rem] cursor-pointer appearance-none rounded-md border-hairline border-border bg-transparent pl-2 pr-6 text-2xs text-ink-3 transition-colors duration-quick ease-quad hover:text-ink"
                >
                  <option value="all">all sessions</option>
                  {[...sessionOptions.entries()].map(([id, label]) => (
                    <option key={id} value={id}>{label}</option>
                  ))}
                </select>
                <DownCaret />
              </div>
            )}
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
              <DownCaret />
            </div>
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
                    {/* §5.2: harness mark + session label + agent label, replacing
                        the bare project - the thing that used to make every row
                        under a workflow read as the same undifferentiated
                        "agent-monitor". Finding fix: the session label and agent
                        label used to share ONE truncating span, so a session
                        label anywhere near its own 60-char cap (a project name
                        plus intent) silently ate the ENTIRE budget and the agent
                        label - the one thing that actually tells sibling
                        workflow-agent rows apart - never rendered at all. The
                        agent label now has its own `shrink-0` span so it always
                        shows in full; only the session label truncates. */}
                    <span
                      className="flex min-w-0 max-w-[14rem] shrink items-center gap-1 text-ink-4"
                      title={labelFor(a) + (a.label ? ` · ${a.label}` : "")}
                    >
                      <HarnessMark harness={a.harness ?? "claude"} />
                      <span className="min-w-0 flex-1 truncate">{labelFor(a)}</span>
                      {a.label && <span className="shrink-0 whitespace-nowrap text-ink-3">· {a.label}</span>}
                    </span>
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
