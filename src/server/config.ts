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
