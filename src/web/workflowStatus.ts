import type { GlyphKind } from "./components/StatusGlyph.tsx";

// Known statuses get a colour; anything else renders grey rather than being
// rejected. Claude Code's vocabulary has already grown once ("failed"), so this
// map is a display hint, never a validator.
const WF_STATUS_CLASS: Record<string, string> = {
  completed: "text-done", // completed is not running
  running: "text-working",
  failed: "text-danger", // attention means YOU are needed; danger means it broke
  killed: "text-danger",
  orphaned: "text-ink-4",
  settled: "text-ink-4",
};

/** The glyph half of the same display hint. Its keys are EXACTLY
 *  WF_STATUS_CLASS's keys - the two maps must be edited together, or a run can
 *  get a text-danger label under an idle ring. `w.state` is server-derived and
 *  only ever running/settled/orphaned; `w.status` is Claude Code's own
 *  unvalidated vocabulary, which is what the ?? fallback is for. */
const WF_STATUS_GLYPH: Record<string, GlyphKind> = {
  running: "working",
  completed: "ended",
  failed: "danger",
  killed: "danger",
  orphaned: "idle",
  settled: "idle",
};

export function statusKnown(label: string): boolean {
  return Object.prototype.hasOwnProperty.call(WF_STATUS_CLASS, label);
}

export function statusClass(label: string): string {
  return WF_STATUS_CLASS[label] ?? "text-ink-4";
}

export function statusGlyphKind(label: string): GlyphKind {
  return WF_STATUS_GLYPH[label] ?? "idle"; // unknown → hollow ring, never a throw
}

// §5.3 / ui.md P1-8: a per-agent state's OWN colour -- distinct from a run's
// WF_STATUS_CLASS above (a run is completed/running/failed/killed/orphaned/
// settled; an agent is done/running/progress/error/abandoned/killed). Before
// this map existed, `error` and `progress` (a live agent mid-turn, seen on
// warm-restart re-attach) rendered with no colour at all, indistinguishable
// from a run that had never started.
const AGENT_STATE_TEXT: Record<string, string> = {
  done: "text-done",
  running: "text-working",
  progress: "text-working",
  error: "text-danger",
  killed: "text-danger",
  abandoned: "text-ink-4",
};

const AGENT_STATE_DOT: Record<string, string> = {
  done: "bg-idle",
  running: "bg-working am-pulse",
  progress: "bg-working am-pulse",
  error: "bg-danger",
  killed: "bg-danger",
  abandoned: "bg-attention/60",
};

/** Text colour for one agent row's state label. Unknown/null states read
 *  neutral rather than throwing -- an agent's own state vocabulary is just as
 *  liable to grow as a run's (see the WF_STATUS_CLASS comment above).
 *
 *  `live` (default true, so every OTHER caller is unaffected) gates
 *  running/progress the same way `RunDetailBody` already gates the
 *  last-tool-summary chip (§5.3, "no live-blue styling on settled runs"): an
 *  agent left behind mid-turn by an orphaned or otherwise-settled run reads
 *  neutral, not working-blue, since the run itself is no longer making
 *  progress even if this one row's raw state was never updated to say so. */
export function agentStateClass(state: string | null, live: boolean = true): string {
  if (!live && (state === "running" || state === "progress")) return "text-ink-4";
  return AGENT_STATE_TEXT[state ?? ""] ?? "text-ink-4";
}

/** Background colour for one agent row's status dot (WorkflowRunCard's live
 *  agent list). Same vocabulary and same neutral fallback as `agentStateClass`. */
export function agentStateDotClass(state: string | null): string {
  return AGENT_STATE_DOT[state ?? ""] ?? "bg-idle";
}

/** True while a run is still live -- gates "no live-blue styling on settled
 *  runs" (§5.3): a `last_tool`/`last_tool_summary` chip is only ever styled as
 *  in-progress while the OWNING RUN is running, never once it has settled or
 *  orphaned, even if the agent's own raw state still says "running" (a run
 *  killed mid-flight normalizes its agents to "killed" at read time, but a
 *  merely-quiet orphaned run does not touch agent state at all). */
export function isRunLive(runState: string): boolean {
  return runState === "running";
}
