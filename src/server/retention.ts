import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Store } from "./store.ts";

export const BACKUP_MARKER = "backup_multiharness_done";
export const EVENTS_PRUNED_ONCE_MARKER = "events_pruned_once";
export const EVENTS_VACUUM_MARKER = "events_vacuum_v1";

function yyyymmdd(now: number): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/** One-time safety net before the FIRST destructive migration in the
 *  multi-harness spec runs (events retention pruning here; usage dedupe in
 *  §2.2 later) - snapshot the live DB with `VACUUM INTO` before anything
 *  deletes a row nobody can get back. Guarded by `backup_multiharness_done`
 *  so every destructive migration can call this and only the first one to
 *  ever run actually pays for it. Uses the CONFIGURED db path's directory,
 *  not the cwd. A no-op for an in-memory DB (tests - nothing to back up, and
 *  `VACUUM INTO` has no directory to write into). Returns the backup path,
 *  or null when skipped. */
export function ensureMultiharnessBackup(store: Store, dbPath: string, now: number): string | null {
  if (dbPath === ":memory:") return null;
  if (store.getMeta(BACKUP_MARKER)) return null;
  const dir = dirname(dbPath);
  const backupPath = join(dir, `am-pre-multiharness-${yyyymmdd(now)}.sqlite`);
  if (existsSync(backupPath)) {
    // `VACUUM INTO` refuses to overwrite an existing file and throws. A file
    // at today's backup path can already exist (restored alongside the DB, or
    // left over from a run that got this far before crashing on something
    // else) without the marker having been set -- without this check, every
    // hourly retention sweep would retry the same throwing VACUUM INTO
    // forever. Treat its mere presence as "backup done" instead.
    store.setMeta(BACKUP_MARKER, String(now));
    console.log(`[backup] snapshot already present, marking done: ${backupPath}`);
    return backupPath;
  }
  store.db.query("VACUUM INTO $path").run({ $path: backupPath });
  store.setMeta(BACKUP_MARKER, String(now));
  console.log(`[backup] snapshot before multi-harness migrations: ${backupPath}`);
  return backupPath;
}

/** Hourly retention sweep (§1.4): back up once (see above), then delete
 *  `events` rows older than `retentionMs` (all types - `tool_stats` keeps the
 *  running aggregate, so historical tool-usage totals are unaffected). Marks
 *  that a prune has actually reclaimed something at least once, which
 *  `runPendingVacuum` below checks at the next startup -- a sweep that deletes
 *  nothing (a fresh DB, or one already fully pruned) leaves the marker unset,
 *  so a startup with nothing to reclaim never pays for a full-file VACUUM.
 *  Returns the number of rows deleted. */
export function retentionSweep(store: Store, dbPath: string, now: number, retentionMs: number): number {
  ensureMultiharnessBackup(store, dbPath, now);
  const deleted = store.pruneOldEvents(now - retentionMs);
  if (deleted > 0 && !store.getMeta(EVENTS_PRUNED_ONCE_MARKER)) store.setMeta(EVENTS_PRUNED_ONCE_MARKER, String(now));
  return deleted;
}

/** Runs the one-time `VACUUM` that reclaims the space freed by the first
 *  retention prune (§1.4). Deliberately called only at STARTUP, never from
 *  inside the hourly sweep interval itself: `VACUUM` rewrites the whole
 *  database file and would otherwise block that timer (and, transitively, the
 *  event loop) for as long as it takes on a large DB. Guarded by
 *  `events_vacuum_v1`; a no-op until at least one prune has happened. Returns
 *  whether it actually ran. */
export function runPendingVacuum(store: Store): boolean {
  if (!store.getMeta(EVENTS_PRUNED_ONCE_MARKER)) return false;
  if (store.getMeta(EVENTS_VACUUM_MARKER)) return false;
  store.db.exec("VACUUM;");
  store.setMeta(EVENTS_VACUUM_MARKER, String(Date.now()));
  return true;
}
