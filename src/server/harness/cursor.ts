import { openSync, readSync, closeSync } from "node:fs";
import { truncate } from "../derive.ts";

/** Bounded read for `cursorIntentFromTranscript` - real transcripts put the
 *  first `role:"user"` line at (or very near) the top of the file, so this
 *  never needs to read a multi-MB transcript to find it. Matches the bounded-
 *  read convention `workflows.ts`'s `readAgentHeader`/`subagents.ts`'s
 *  `subagentStartedAt` already use for the same reason. */
const INTENT_READ_CAP = 65_536;

const USER_QUERY_RE = /<user_query>([\s\S]*?)<\/user_query>/;

/** Cursor's normalized hook envelope fields (§4.3), read straight off the raw
 *  payload with Cursor's own key names - `cwd`/`session_id` fall back to
 *  `workspace_roots[0]`/`conversation_id` when the primary field is empty,
 *  `model`/`cursor_version` map onto the generic `model`/`harness_version`
 *  columns, and `duration` (ms, on `postToolUse`) maps onto `duration_ms` so
 *  the rest of the pipeline never needs to know Cursor's field names. */
export interface CursorNormalized {
  sessionId: string | null;
  cwd: string | null;
  model: string | null;
  harnessVersion: string | null;
  durationMs: number | null;
}

export function normalizeCursorPayload(payload: Record<string, unknown>): CursorNormalized {
  const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [];
  const rootCwd = typeof roots[0] === "string" ? (roots[0] as string) : null;
  const ownCwd = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : null;
  const sessionId =
    typeof payload.session_id === "string" && payload.session_id !== ""
      ? payload.session_id
      : typeof payload.conversation_id === "string" && payload.conversation_id !== ""
        ? payload.conversation_id
        : null;
  return {
    sessionId,
    cwd: ownCwd ?? rootCwd,
    model: typeof payload.model === "string" ? payload.model : null,
    harnessVersion: typeof payload.cursor_version === "string" ? payload.cursor_version : null,
    durationMs: typeof payload.duration === "number" && Number.isFinite(payload.duration) ? payload.duration : null,
  };
}

/** §4.3: Cursor's headless mode fires no prompt event, so a Cursor session's
 *  `current_intent` can only come from its own transcript - the first
 *  `role:"user"` line's text, preferring the text inside `<user_query>…
 *  </user_query>` (present when the CLI wraps the raw prompt) and otherwise
 *  the first text block verbatim. Null on any read/parse failure or when no
 *  user line has a text block within the read window - never throws. */
export function cursorIntentFromTranscript(path: string): string | null {
  let raw: string;
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.allocUnsafe(INTENT_READ_CAP);
      const got = readSync(fd, buf, 0, buf.length, 0);
      raw = got > 0 ? buf.subarray(0, got).toString("utf8") : "";
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // The read cap can cut the last line mid-JSON - skip it, not a crash.
      continue;
    }
    if (parsed?.role !== "user") continue;
    const content = parsed?.message?.content;
    if (!Array.isArray(content)) continue;
    const textBlock = content.find((c: unknown) => c && typeof (c as { text?: unknown }).text === "string");
    if (!textBlock) continue;
    const text = (textBlock as { text: string }).text;
    const m = USER_QUERY_RE.exec(text);
    return truncate((m ? m[1] : text).trim());
  }
  return null;
}
