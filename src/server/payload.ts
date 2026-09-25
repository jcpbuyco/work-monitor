import { summarizeTool } from "./store.ts";

/** Fields that are either huge (full tool output, file contents, transcript
 *  text) or fully redundant with what the typed columns already carry. Never
 *  stored, regardless of size. */
const DROPPED_KEYS = new Set([
  "tool_response",
  "tool_output",
  "output",
  "content", // Cursor's beforeReadFile payload
  "last_assistant_message",
  "edits",
]);

const MAX_STRING_LEN = 2000;
const MAX_PAYLOAD_LEN = 8000;
/** Recursion guard for truncateStrings - real hook payloads are a handful of
 *  levels deep at most; this only exists so a pathological payload can't blow
 *  the stack. */
const MAX_DEPTH = 12;

function truncateStrings(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING_LEN ? value.slice(0, MAX_STRING_LEN) + "…" : value;
  }
  if (Array.isArray(value)) return value.map((v) => truncateStrings(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = truncateStrings(v, depth + 1);
    return out;
  }
  return value;
}

/** A short one-line summary of `tool_input` for the last-resort fallback
 *  below, when there isn't room for the full compacted object. Reuses the
 *  same redaction `summarizeTool` already applies to the activity feed, so a
 *  fallback row and a normal row read consistently. */
function summaryString(toolName: unknown, toolInput: unknown): string {
  const s = summarizeTool(typeof toolName === "string" ? toolName : null, toolInput);
  if (s) return s;
  if (toolInput === undefined || toolInput === null) return "";
  try {
    const j = JSON.stringify(toolInput);
    return j.length > 200 ? j.slice(0, 199) + "…" : j;
  } catch {
    return "";
  }
}

/** Compact a hook payload for storage. Never slices raw JSON text (that can
 *  cut a multi-byte string mid-codepoint or leave a dangling quote and store
 *  invalid JSON) - instead: drop known-huge/redundant fields, truncate every
 *  remaining string value (recursively, depth-limited) with a trailing "…",
 *  then stringify. If the result is still too large (many long-ish fields
 *  rather than one huge one), fall back to a minimal, guaranteed-small
 *  summary object. The result is always valid JSON. */
export function compactPayload(payload: Record<string, unknown>): string {
  const compact: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (DROPPED_KEYS.has(k)) continue;
    compact[k] = v;
  }
  const truncated = truncateStrings(compact, 0);
  const json = JSON.stringify(truncated);
  if (json.length <= MAX_PAYLOAD_LEN) return json;

  const fallback = {
    session_id: payload.session_id ?? null,
    cwd: payload.cwd ?? null,
    tool_name: payload.tool_name ?? null,
    tool_input: summaryString(payload.tool_name, payload.tool_input),
    hook_event_name: (payload as { hook_event_name?: unknown }).hook_event_name ?? null,
  };
  return JSON.stringify(fallback);
}

export interface EventColumns {
  toolName: string | null;
  durationMs: number | null;
  agentId: string | null;
  harness: string;
}

/** Pull the typed `events` columns straight out of the parsed (pre-compaction)
 *  hook payload, so ingestion never has to re-parse the stored JSON later. */
export function extractEventColumns(payload: Record<string, unknown>): EventColumns {
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : null;
  const durationMs =
    typeof payload.duration_ms === "number" && Number.isFinite(payload.duration_ms) ? payload.duration_ms : null;
  const agentId = typeof payload.agent_id === "string" ? payload.agent_id : null;
  return { toolName, durationMs, agentId, harness: detectHarness(payload) };
}

/** Minimal harness classification for §1.2's own needs (typed `harness`
 *  column + its historic backfill). This is deliberately NOT the full
 *  multi-harness detection in the spec's §4.2 (transcript-path roots, the
 *  `harness=` query param, Codex detection) - that lands with workstream B1.
 *  Every event on this machine today is Claude Code unless it visibly carries
 *  Cursor's `cursor_version` field (Cursor's Claude-compat hook layer already
 *  delivers events this way). */
export function detectHarness(payload: Record<string, unknown>): string {
  return "cursor_version" in payload ? "cursor" : "claude";
}
