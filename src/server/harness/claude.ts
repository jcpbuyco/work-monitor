/** §4.3: Claude Code's own `session_start` hook carries `model` (e.g.
 *  `claude-opus-5-5[1m]`) and `session_title`, neither persisted before this
 *  workstream. Later hook events (2.1.265+) carry `model` too - persist it
 *  whenever seen, not only at session_start, so a mid-session model switch
 *  still updates the displayed pill. `session_title` only ever appears on
 *  `session_start` in the real payloads surveyed, so reading it unconditionally
 *  is equivalent to gating on the event type and simpler. */
export interface ClaudeNormalized {
  model: string | null;
  title: string | null;
}

export function normalizeClaudePayload(payload: Record<string, unknown>): ClaudeNormalized {
  return {
    model: typeof payload.model === "string" ? payload.model : null,
    title: typeof payload.session_title === "string" ? payload.session_title : null,
  };
}
