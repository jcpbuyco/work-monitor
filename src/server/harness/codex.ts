/** §4.3: Codex's per-hook-event payload is Claude-shaped (same field names as
 *  Claude Code's own hooks - `session_id`, `cwd`, `transcript_path`,
 *  `tool_name`, `tool_input`...), carrying `model` on every event except
 *  `SessionEnd` (whose payload the research report confirms drops both
 *  `model` and `permission_mode`). Nothing needs remapping there - the
 *  existing Claude-shaped field reads already work - EXCEPT `PermissionRequest`,
 *  which the setup's Codex hooks.json (§4.6) maps to the generic `notification`
 *  wm_event_type but whose payload carries no human-readable `message` field
 *  the way Claude's own `Notification` hook does. */
export interface CodexNormalized {
  model: string | null;
  /** Synthesized only for a `notification` event with no `message` of its
   *  own - i.e. Codex's `PermissionRequest`. Null otherwise, so a caller never
   *  overwrites a message a future Codex version does send. */
  message: string | null;
}

export function normalizeCodexPayload(wmEventType: string, payload: Record<string, unknown>): CodexNormalized {
  const model = typeof payload.model === "string" ? payload.model : null;
  const hasMessage = typeof payload.message === "string" && payload.message !== "";
  const message = wmEventType === "notification" && !hasMessage ? "Codex is waiting for approval" : null;
  return { model, message };
}
