import type { InsightsResponse } from "../../../shared/insights.ts";
import { formatUsdWhole, formatDay } from "../../cost.ts";
import { ymd } from "../../insights.ts";

function RecordTile({
  label,
  value,
  context,
  onHover,
  onClick,
}: {
  label: string;
  value: string;
  context?: string;
  onHover?: (on: boolean) => void;
  onClick?: () => void;
}) {
  const interactive = !!onHover || !!onClick;
  return (
    <div
      className={`rounded-lg border-hairline border-border bg-surface-1 p-3 last:col-span-2 sm:last:col-span-1 ${interactive ? "cursor-pointer transition-colors duration-quick ease-quad hover:bg-surface-2" : ""}`}
      tabIndex={interactive ? 0 : undefined}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      onFocus={() => onHover?.(true)}
      onBlur={() => onHover?.(false)}
      onClick={onClick}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && onClick) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {/* truncate + title, not free wrapping: a label that wraps to 2 lines
         ("Priciest workflow run") pushed its own value a full line lower than
         every other tile's in the same row, so the row's figures stopped
         sharing a baseline (reviewer finding, A16). Widened breakpoints below
         (grid-cols-2/3/5, not a flat 2/5) give this label enough room that it
         rarely needs the truncation at all -- see the grid below. */}
      <div className="truncate text-2xs text-ink-3" title={label}>
        {label}
      </div>
      {/* Proportional figures, not tabular-nums: §5 reserves tabular-nums for
         axis ticks and table cells, and a record value is a large standalone
         number like the hero figure (reviewer finding). NOT `whitespace-nowrap`
         -- forcing a single line let a wide value ("29.0 h active", "$416 ·
         8.3x list"-scale text) run straight past the tile's own border and
         force the whole PAGE to scroll sideways, the exact "text outside its
         box" class of bug the user originally reported (reviewer finding,
         R1). Wrapping to a second line inside the tile is always preferable
         to bleeding past it. */}
      <div className="mt-1 text-lg font-semibold text-ink">{value}</div>
      {context && <p className="mt-0.5 text-2xs text-ink-4">{context}</p>}
    </div>
  );
}

// "29.0h", not "29.0 h" -- the space was the one duration on the page not
// matching B17's "no space between a number and its compact unit" convention
// (WorkflowRunCosts' own `fmtDuration` already reads "1.5h"/"45m", reviewer
// finding, O7).
function hMinutes(ms: number): string {
  const h = ms / 3_600_000;
  return `${h.toFixed(1)}h`;
}

/** C2: five record tiles (biggest day, longest streak, peak parallel agents,
 *  priciest workflow run, longest session). Hovering a record with a date
 *  rings the matching C9 calendar cell; clicking scrolls it into view. */
export function RecordsStrip({
  data,
  onHoverDay,
  onGoToCalendar,
}: {
  data: InsightsResponse;
  onHoverDay: (day: string | null) => void;
  onGoToCalendar: () => void;
}) {
  const r = data.records;
  return (
    // grid-cols-2/3/5, not a flat 2 -> 5 jump at `sm` (640px): 5 columns
    // packed a wide value ("29.0 h active") into a ~105-160px tile at every
    // width from 640 up, overflowing the tile (and, at large text sizes,
    // forcing the whole PAGE to scroll sideways) -- the `lg` step gives each
    // tile real room before jumping to 5-across (reviewer finding, R1).
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      <RecordTile
        label="Biggest day"
        value={r.biggestDay ? formatUsdWhole(r.biggestDay.costUsd) : "-"}
        context={r.biggestDay ? `${formatDay(r.biggestDay.day)} · ${r.biggestDay.messages.toLocaleString()} messages` : undefined}
        onHover={r.biggestDay ? (on) => onHoverDay(on ? r.biggestDay!.day : null) : undefined}
        onClick={r.biggestDay ? onGoToCalendar : undefined}
      />
      <RecordTile
        label="Longest streak"
        value={r.longestStreak ? `${r.longestStreak.days} days` : "-"}
        context={
          r.longestStreak
            ? `${formatDay(r.longestStreak.from)} to ${formatDay(r.longestStreak.to)} · current streak ${r.currentStreakDays} days`
            : undefined
        }
        onHover={r.longestStreak ? (on) => onHoverDay(on ? r.longestStreak!.to : null) : undefined}
        onClick={r.longestStreak ? onGoToCalendar : undefined}
      />
      <RecordTile
        label="Peak parallel agents"
        value={r.peakAgents ? `${r.peakAgents.agents} agents` : "-"}
        context={
          r.peakAgents
            ? // Spec example: "Mon 7 Sep 15:15" -- the bare weekday+time this
              // used to show ("Mon 03:15 PM") carried no date at all
              // (reviewer finding).
              `${new Date(r.peakAgents.at).toLocaleString("en-US", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })}${
                r.peakAgents.runName ? ` · ${r.peakAgents.runName}` : ""
              }`
            : undefined
        }
        onHover={r.peakAgents ? (on) => onHoverDay(on ? ymd(new Date(r.peakAgents!.at)) : null) : undefined}
        onClick={r.peakAgents ? onGoToCalendar : undefined}
      />
      <RecordTile
        label="Priciest workflow run"
        value={r.priciestRun ? formatUsdWhole(r.priciestRun.costUsd) : "-"}
        context={
          r.priciestRun
            ? `${r.priciestRun.name ?? r.priciestRun.runId} · ${r.priciestRun.agentCount ?? "?"} agents`
            : undefined
        }
        onClick={r.priciestRun ? () => { window.location.hash = `#/workflows?run=${encodeURIComponent(r.priciestRun!.runId)}`; } : undefined}
      />
      <RecordTile
        label="Longest session"
        value={r.longestSession ? `${hMinutes(r.longestSession.activeMs)} active` : "-"}
        context={
          r.longestSession
            ? // `ymd` (local calendar day) here, not `toISOString().slice(0,10)`
              // (the UTC day) -- a session that started between local
              // midnight and 01:00-02:00 (ahead of UTC) used to date itself
              // to the WRONG, previous day (reviewer finding).
              `over ${hMinutes(r.longestSession.wallMs)} wall · ${r.longestSession.project ?? "(no project)"} · from ${formatDay(
                ymd(new Date(r.longestSession.startedAt))
              )}`
            : undefined
        }
        onHover={r.longestSession ? (on) => onHoverDay(on ? ymd(new Date(r.longestSession!.startedAt)) : null) : undefined}
        onClick={r.longestSession ? onGoToCalendar : undefined}
      />
    </div>
  );
}
