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
export const SWEEP_INTERVAL_MS = 60 * 1000;
export const MAX_INTENT_LEN = 140;

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
