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

/** Sessions with no activity for this long while "working" are swept to idle. */
export const STALE_MS = 10 * 60 * 1000;
export const SWEEP_INTERVAL_MS = 60 * 1000;
export const MAX_INTENT_LEN = 140;
