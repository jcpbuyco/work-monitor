import { homedir } from "node:os";
import { join } from "node:path";

export const PORT = Number(process.env.AM_PORT ?? 4317);
export const HOST = "127.0.0.1";

export function defaultDbPath(): string {
  const base =
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(base, "agent-monitor", "agent-monitor.sqlite");
}

export const DB_PATH = process.env.AM_DB_PATH ?? defaultDbPath();

/** A "working" session with no activity for this long is swept to idle (still shown). */
export const STALE_MS = 10 * 60 * 1000;
/** Any session silent this long is retired to "ended" and hidden — a closed
 *  terminal or crash emits no session_end, so prolonged silence is the only tell. */
export const DEAD_MS = 30 * 60 * 1000;
/** `needs_you` sessions are exempt from DEAD_MS: the whole point of the status is
 *  that a human hasn't looked yet, so the routine dead sweep must not hide the
 *  request before anyone sees it. It only retires after this much longer silence. */
export const NEEDS_YOU_DEAD_MS = 24 * 60 * 60 * 1000;
export const SWEEP_INTERVAL_MS = 60 * 1000;
export const MAX_INTENT_LEN = 140;

/** Trailing-edge throttle window for SSE "state" broadcasts (§1.1). A single
 *  event still feels instant (fires on the next macrotask when idle); a burst
 *  of hook traffic collapses into one broadcast per window. */
export const STATE_THROTTLE_MS = 1000;

/** `events` rows older than this are pruned by the hourly retention sweep (§1.4).
 *  `tool_stats` keeps the aggregate, so historical tool-usage totals survive. */
export const EVENTS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Workflow scan cadence. A live run must feel live; 60s freezes the card. */
export const WF_TICK_MS = 5 * 1000;
/** Run dir mtime unchanged this long ⇒ stop tailing (ACTIVE → SETTLED). The same
 *  window, combined with a missing manifest, is what reads as `orphaned` — a
 *  display state only, never persisted. */
export const WF_QUIET_MS = 10 * 60 * 1000;
/** Settled runs younger than this are re-stat'd to catch resumed appends (C6). */
export const WF_RECHECK_MS = 24 * 60 * 60 * 1000;
/** Kill switch. AM_WORKFLOWS=0 disables the scanner entirely. */
export const WORKFLOWS_ENABLED = process.env.AM_WORKFLOWS !== "0";
/** Root of Claude Code's per-project transcript tree. Only the one-time startup
 *  backfill globs this; the steady-state scan walks session transcript paths. */
export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
