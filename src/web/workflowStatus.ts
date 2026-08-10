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
 *  WF_STATUS_CLASS's keys — the two maps must be edited together, or a run can
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
