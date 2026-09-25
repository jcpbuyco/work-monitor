import { useState, type CSSProperties } from "react";
import type { Session, SessionCost, SubagentView } from "../types.ts";
import { ago } from "../time.ts";
import { prettyTool } from "../tools.ts";
import { formatUsd, formatTokens, prettyModel } from "../cost.ts";
import { StatusGlyph, type GlyphKind } from "./StatusGlyph.tsx";
import { HarnessMark } from "./HarnessMark.tsx";
import { ListRow, Rail, Chip } from "./primitives.tsx";

/** Rows in the idle group are drawn in ink-4, not `idle`: the GROUP HEADER
 *  carries the semantic colour once (Lane.tsx), and the rows recede. */
const STATUS: Record<string, { kind: GlyphKind; tone: string; label: string }> = {
  working: { kind: "working", tone: "text-working", label: "Working" },
  needs_you: { kind: "needs_you", tone: "text-attention", label: "Needs you" },
  idle: { kind: "idle", tone: "text-ink-4", label: "Idle" },
  ended: { kind: "ended", tone: "text-ink-4", label: "Ended" },
};

/** A single-unit duration, deliberately coarser than `formatDuration` (no
 *  "12m 34s" two-part form - too wide for a fixed-width compact row) and
 *  deliberately never switching to an absolute date the way `ago()` does past
 *  7 days: `idleReasonText` below only ever calls this for an `idle` session,
 *  which is swept to `ended` (and drops off the board) well within an hour of
 *  silence (§1.6), so a bare seconds/minutes count is always enough. */
function shortQuietDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 1) return "<1s";
  if (s < 60) return `${s}s`;
  return `${Math.round(s / 60)}m`;
}

/** §5.1: "stopped 3m ago" (a Stop hook fired) vs "quiet 12m" (swept for
 *  silence) - an idle row's ONLY hint at which of those two very different
 *  things happened, since both collapse to the same status. Meaningless (and
 *  not necessarily cleared) once the session leaves `idle`, so callers only
 *  ever invoke this while `s.status === "idle"`. */
function idleReasonText(s: Session): string | null {
  if (s.idle_reason === "stopped") return `stopped ${ago(s.last_activity_at)}`;
  // §5.1 finding fix: was `ago(...).replace(/ ago$/, "")` - `ago()` switches
  // to an absolute date past 7 days (no " ago" suffix left to strip), so a
  // long-quiet session used to read "quiet Sep 3" with no hint it's even a
  // duration.
  if (s.idle_reason === "quiet") return `quiet ${shortQuietDuration(Date.now() - s.last_activity_at)}`;
  return null;
}

/** §5.1: the cost cell's four states - priced / partial / unpriced / n-a.
 *  Cursor never records token usage locally; only runs wrapped by am-cursor
 *  report it, so a cursor session without usage reads n/a rather than $0.
 *  Returns null only for "nothing to show yet" (no usage rows, non-cursor) -  *  the existing "omit the cost line entirely" behaviour. */
function costCell(s: Session, cost?: SessionCost): { text: string; title?: string } | null {
  // Only am-cursor-wrapped headless runs report usage; a Cursor session
  // without any reads n/a. Captured usage is priced like every other harness.
  if (s.harness === "cursor" && (!cost || cost.tokens === 0)) {
    return { text: "n/a", title: "Cursor records no usage locally; run headless sessions through am-cursor to capture tokens" };
  }
  if (!cost) return null;
  if (cost.costUsd == null) return { text: formatUsd(null) }; // "unpriced" - fully unpriced usage
  if ((cost.unpricedTokens ?? 0) > 0) {
    return { text: `${formatUsd(cost.costUsd)}+`, title: "some usage from unpriced models" };
  }
  return { text: formatUsd(cost.costUsd) };
}

/** §5.1: the "N agents" chip that expands the row into a second line listing
 *  the live subagents. Renders only the toggle button - `SubagentsList` below
 *  draws the actual list, as a sibling elsewhere in the row, not a child of
 *  this button.
 *
 *  Finding fix: this used to be an absolutely-positioned popover local to the
 *  chip. Every row has its own stacking context (the view-transition-name
 *  SessionCard sets for the tween on a status change), so that popover's
 *  `z-10` was only ever local to ITS OWN row - the next row's chips and text
 *  painted right over it and intercepted its clicks. Expanding the row inline
 *  instead - the same idiom WorkflowRunCard's own agent list already uses -
 *  sidesteps the whole stacking-context problem, and works identically on a
 *  phone (a floating popover positioned off a chip does not). */
function SubagentsChip({ open, onToggle, count }: { open: boolean; onToggle: () => void; count: number }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-surface-3 px-1 font-mono text-3xs text-ink-3 transition-colors duration-quick ease-quad hover:text-ink"
    >
      {count} agent{count === 1 ? "" : "s"}
    </button>
  );
}

function SubagentsList({ subagents }: { subagents: SubagentView[] }) {
  return (
    <div data-testid="subagents-list" className="flex flex-col gap-0.5 pl-rail pt-0.5">
      {subagents.map((a) => (
        <div key={a.agent_id} className="flex min-w-0 items-center gap-1.5 font-mono text-2xs">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${a.kind === "workflow" ? "bg-attention/60" : "bg-primary"}`} />
          <span className="min-w-0 flex-1 truncate text-ink-2">{a.label ?? a.agent_type ?? a.agent_id}</span>
          {a.model && <span className="shrink-0 text-ink-4">{prettyModel(a.model)}</span>}
          {a.last_tool && <span className="shrink-0 truncate text-working/70">▸ {prettyTool(a.last_tool)}</span>}
        </div>
      ))}
    </div>
  );
}

export function SessionCard({
  s,
  latestTool,
  latestDetail,
  cost,
  /** §5.1: the run this session owns a live workflow run for, if any - the
   *  chip becomes a deep link to `#/workflows?run=<run_id>` instead of a dead
   *  badge. Renamed from the old boolean `wf` prop (a deliberate spec change). */
  wfRunId = null,
  /** §5.1: set only for an "orphan" - a child whose parent isn't in the
   *  currently listed sessions (filtered out, or in a different status
   *  column) - the project of that parent, for the "spawned by <project>"
   *  hint. Nesting itself (indent + connector) is drawn by the caller
   *  (Board.tsx), which is the one that knows the full session tree. */
  spawnedByProject = null,
}: {
  s: Session;
  latestTool?: string;
  latestDetail?: string | null;
  cost?: SessionCost;
  wfRunId?: string | null;
  spawnedByProject?: string | null;
}) {
  const st = STATUS[s.status] ?? STATUS.idle;
  const isWorking = s.status === "working";
  const compact = s.status === "idle" || s.status === "ended";
  const task = s.current_task ?? s.current_intent ?? "-";
  const harness = s.harness ?? "claude";
  const cell = costCell(s, cost);
  const subagents = s.subagents ?? [];
  // Lifted out of SubagentsChip (finding fix): the expanded list now renders
  // as a sibling further down the row, not a child of the chip's own button.
  const [subagentsOpen, setSubagentsOpen] = useState(false);

  // Stable name so a status change (group move) tweens between positions.
  const style: CSSProperties = {};
  (style as Record<string, string>).viewTransitionName = `vt-s-${s.id}`;

  const wfBadge = wfRunId != null && (
    <a
      data-testid="wf-badge"
      href={`#/workflows?run=${encodeURIComponent(wfRunId)}`}
      title="owns a live workflow run"
      className="inline-flex shrink-0 items-center rounded-sm bg-working/[0.12] px-1 font-mono text-3xs text-working transition-colors duration-quick ease-quad hover:bg-working/[0.2]"
    >
      wf
    </a>
  );

  if (compact) {
    const trailing = s.status === "idle" ? (idleReasonText(s) ?? ago(s.last_activity_at)) : ago(s.last_activity_at);
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
          <HarnessMark harness={harness} version={s.harness_version} className="text-ink-4" />
          <span className="shrink-0 text-xs text-ink-2">{s.project}</span>
          {/* §5.1 finding fix: every session row shows a model pill - this
              compact branch used to drop it entirely once a session went
              idle/ended, so the pill (and the model it names) vanished the
              moment a row most needed to stay identifiable at a glance. */}
          {s.model && (
            <Chip title={s.model} className="shrink-0">
              {prettyModel(s.model)}
            </Chip>
          )}
          {spawnedByProject && (
            <span className="shrink-0 truncate text-2xs text-ink-4">spawned by {spawnedByProject}</span>
          )}
          <span className="min-w-0 flex-1 truncate text-xs text-ink-4" title={task}>
            {task}
          </span>
          {cell && (
            <span title={cell.title} className="shrink-0 font-mono text-2xs tabular-nums slashed-zero text-ink-4">
              {cell.text}
            </span>
          )}
          <span className="shrink-0 whitespace-nowrap text-right font-mono text-2xs tabular-nums text-ink-4">
            {trailing}
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
        {/* §5.2 phone fix: `flex-wrap` plus a forced line-break (the
            `basis-full` spacer below) stacks the row onto two lines below
            `sm` - identity (mark/project/pills/age) on line 1, task/branch/
            cost on line 2 - instead of cramming everything onto one line and
            pushing the fixed-width timestamp past the viewport (measured
            scrollWidth 407-466 at 390px with real session rows). `sm:flex-nowrap`
            restores the original single-line desktop layout untouched. */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 sm:flex-nowrap">
          {/* removing the visible status label must not remove status from the
              accessibility tree - the glyph is aria-hidden */}
          <span className="sr-only">{st.label}</span>
          <HarnessMark harness={harness} version={s.harness_version} className="text-ink-4" />
          <span className="shrink-0 text-sm font-medium text-ink">{s.project}</span>
          {s.model && (
            <Chip title={s.model} className="shrink-0">
              {prettyModel(s.model)}
            </Chip>
          )}
          {wfBadge}
          {subagents.length > 0 && (
            <SubagentsChip
              open={subagentsOpen}
              onToggle={() => setSubagentsOpen((v) => !v)}
              count={subagents.length}
            />
          )}
          {spawnedByProject && (
            <span className="shrink-0 truncate text-2xs text-ink-4">spawned by {spawnedByProject}</span>
          )}
          {/* On the desktop single line this reorders to the end (its
              original position, after branch/cost); on the mobile two-line
              stack it stays in DOM order, on line 1 with the rest of the
              row's identity - the `basis-full` spacer right after it is what
              actually forces line 2 to start. */}
          <span className="w-14 shrink-0 text-right font-mono text-2xs tabular-nums text-ink-4 sm:order-last">
            {ago(s.last_activity_at)}
          </span>
          <span aria-hidden="true" className="basis-full sm:hidden" />
          {/* §5.1, A+ truncation order (P2-6 finding fix): branch and cost now
              give way FIRST, not the task text. A `flex-1`/flex-basis:0% item
              (the task) gets a flex-shrink WEIGHT of shrink-factor × basis,
              which is 0 for a zero basis - so it takes none of a tight row's
              shrinkage and only ever drops to its `min-w` floor as an
              absolute last resort. Branch/cost, given `min-w-0` (so their own
              automatic minimum size is 0, not their content width) and a much
              heavier `shrink-[6]` weight than the task's default `shrink`,
              now absorb that deficit long before the task loses anything. */}
          <span className="min-w-[6rem] flex-1 truncate text-sm text-ink-3" title={task}>
            {task}
          </span>
          {s.branch && (
            <span
              className="min-w-0 max-w-[9rem] shrink-[6] truncate font-mono text-2xs text-ink-4"
              title={`⎇ ${s.branch}`}
            >
              ⎇ {s.branch}
            </span>
          )}
          {cell && (
            <span
              data-testid="cost-cell"
              title={cell.title}
              // `overflow-hidden` + a `min-w` floor: without them, an
              // extreme squeeze (a very long project name at max text size)
              // could shrink this box past its shrink-0 word child's own
              // width, and that child - never shrinking - would spill out of
              // a near-zero-width box and visually overlap the timestamp
              // that follows it. The floor is sized for the longest realistic
              // word ("unpriced", "$999.99+"); overflow-hidden is the safety
              // net for anything even longer than that.
              className="flex min-w-[3.5rem] max-w-[11rem] shrink-[6] items-center overflow-hidden font-mono text-2xs tabular-nums slashed-zero text-ink-4"
            >
              {/* the priced/partial/unpriced/n-a WORD never truncates into a
                  meaningless fragment ("unpric…") - only the token-count
                  suffix gives way, and disappears first. */}
              <span className="shrink-0 whitespace-nowrap">{cell.text}</span>
              {cost && (
                <>
                  {/* finding fix: the separator used to be a leading space
                      inside the truncating span below - a flex item is its
                      own block container, so a browser trims a leading (and
                      trailing) space at the START of its content exactly
                      like `<p> text</p>` trims its own - the cell rendered
                      "$176.21· 660.9M tok" with no visible gap. Its own
                      shrink-0 span carries a real margin instead, which a
                      browser never trims regardless of the text inside it. */}
                  <span className="mx-1 shrink-0 text-ink-4/70"> · </span>
                  <span className="min-w-0 truncate text-ink-4/70">{formatTokens(cost.tokens)} tok</span>
                </>
              )}
            </span>
          )}
        </div>
      </div>

      {subagentsOpen && subagents.length > 0 && <SubagentsList subagents={subagents} />}

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
          no second line rather than a bare ⚠. §5.1 wants "attention text and
          age" - age is the row's own top-right timestamp (still `ago()`,
          unchanged), so this line stays exactly the attention text. */}
      {s.attention_reason && s.status === "needs_you" && (
        <div className="truncate pl-rail font-mono text-2xs text-attention" title={s.attention_reason}>
          ⚠ {s.attention_reason}
        </div>
      )}

      {/* a 1px underline at the row's bottom edge, rail → right */}
      {isWorking && (
        <span aria-hidden="true" className="am-shimmer absolute bottom-0 left-rail right-0 h-px bg-working/[0.14]" />
      )}
    </ListRow>
  );
}
