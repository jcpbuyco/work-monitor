import type { Harness } from "../../shared/harness.ts";
import { detectHarness } from "./detect.ts";
import { normalizeCursorPayload } from "./cursor.ts";
import { normalizeCodexPayload } from "./codex.ts";
import { normalizeClaudePayload } from "./claude.ts";

export { detectHarness, resolveParentSessionId, parentFromScratchpadCwd } from "./detect.ts";
export { cursorIntentFromTranscript, normalizeCursorPayload } from "./cursor.ts";
export { normalizeCodexPayload } from "./codex.ts";
export { normalizeClaudePayload } from "./claude.ts";

export interface NormalizedIncomingEvent {
  harness: Harness;
  /** `rawPayload` with harness-specific field aliases folded onto the generic
   *  names the rest of the ingestion pipeline (`reduceEvent`,
   *  `extractEventColumns`) already reads - `session_id`, `cwd`,
   *  `duration_ms`, `message`. Every other field is passed through untouched,
   *  so a harness-specific field the rest of the pipeline never reads (e.g.
   *  Cursor's `tool_output`) still round-trips into `compactPayload`. */
  payload: Record<string, unknown>;
  /** The harness's own reported model for this event, or null when this event
   *  carries none (e.g. Codex's `SessionEnd`). Display only. */
  model: string | null;
  /** Claude's `session_title`, or null for every other harness/event. */
  title: string | null;
  /** The harness's own CLI/build version, when this event carries one
   *  (Cursor's `cursor_version`; Codex's is read from the rollout at tail
   *  time instead, per §4.4, so this is always null for codex here). */
  harnessVersion: string | null;
}

/** §4.3: one entry point that detects the harness and applies its
 *  normalizer, so `http.ts`'s `/events` handler never has to know any
 *  harness's own field names directly. */
export function normalizeIncomingEvent(
  wmEventType: string,
  rawPayload: Record<string, unknown>,
  queryHarness?: string | null
): NormalizedIncomingEvent {
  const harness = detectHarness(rawPayload, queryHarness);
  const payload: Record<string, unknown> = { ...rawPayload };
  let model: string | null = null;
  let title: string | null = null;
  let harnessVersion: string | null = null;

  if (harness === "cursor") {
    const n = normalizeCursorPayload(rawPayload);
    if (n.sessionId) payload.session_id = n.sessionId;
    if (n.cwd) payload.cwd = n.cwd;
    if (n.durationMs != null) payload.duration_ms = n.durationMs;
    model = n.model;
    harnessVersion = n.harnessVersion;
  } else if (harness === "codex") {
    const n = normalizeCodexPayload(wmEventType, rawPayload);
    if (n.message) payload.message = n.message;
    model = n.model;
  } else {
    const n = normalizeClaudePayload(rawPayload);
    model = n.model;
    title = n.title;
  }

  return { harness, payload, model, title, harnessVersion };
}
