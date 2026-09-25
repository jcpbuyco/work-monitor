import type { Harness } from "../../shared/harness.ts";

/** §4.2 harness detection, first match wins:
 *   1. payload carries `cursor_version`, or its `transcript_path` sits under
 *      `~/.cursor/` -> cursor (Cursor runs the hooks in `~/.claude/settings.json`
 *      through its Claude-compat layer, so this is how Cursor sessions arrive
 *      at all today).
 *   2. `transcript_path` under `~/.codex/`, or the query string's `harness=codex`
 *      (am-hook.sh's own second argument, set at hook-registration time for
 *      Codex's own hooks.json) -> codex.
 *   3. otherwise claude.
 *
 *  `queryHarness` is the raw `?harness=` query param, untrusted the same way
 *  every other query param is - only the literal value "codex" means anything;
 *  anything else (missing, "claude", a typo) falls through to the payload-shape
 *  checks and finally the claude default. */
export function detectHarness(payload: Record<string, unknown>, queryHarness?: string | null): Harness {
  if ("cursor_version" in payload) return "cursor";
  const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
  if (transcriptPath.includes("/.cursor/")) return "cursor";
  if (transcriptPath.includes("/.codex/")) return "codex";
  if (queryHarness === "codex") return "codex";
  return "claude";
}

/** Matches am-hook.sh's own scratchpad convention:
 *  `/tmp/claude-<uid>/<slugified-parent-cwd>/<parent-session-uuid>/scratchpad[/...]`.
 *  Captures the parent session's uuid. Used as the parent-resolution fallback
 *  (§4.2) when neither `pcc` nor `pcx` is present - e.g. a Codex or Cursor
 *  session invoked from a Claude Code Bash tool call, where the env vars this
 *  spec's hook change carries are only set on the CLAUDE side, but the child's
 *  own cwd still lands inside that scratchpad directory. */
const SCRATCHPAD_CWD_RE = /\/tmp\/claude-[^/]+\/[^/]+\/([0-9a-f-]{8,})\/scratchpad(?:\/|$)/;

export function parentFromScratchpadCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const m = SCRATCHPAD_CWD_RE.exec(cwd);
  return m ? m[1] : null;
}

/** §4.2 parent resolution: the first of `pcc` (am-hook.sh's `$CLAUDE_CODE_SESSION_ID`)
 *  or `pcx` (`$CODEX_THREAD_ID`) that is non-empty and differs from the event's
 *  OWN session id (a top-level session's hook naturally has its own id in
 *  scope too - that must never resolve as "its own parent"), falling back to
 *  the scratchpad cwd pattern. Null when nothing resolves - most sessions have
 *  no parent, and that is not an error. */
export function resolveParentSessionId(args: {
  pcc?: string | null;
  pcx?: string | null;
  cwd?: string | null;
  sessionId: string;
}): string | null {
  for (const candidate of [args.pcc, args.pcx]) {
    if (candidate && candidate !== args.sessionId) return candidate;
  }
  const fromCwd = parentFromScratchpadCwd(args.cwd);
  if (fromCwd && fromCwd !== args.sessionId) return fromCwd;
  return null;
}
