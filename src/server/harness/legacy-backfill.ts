import type { Store } from "../store.ts";
import type { SessionPatch } from "../types.ts";
import { resolveRepoInfo } from "../resolve-project.ts";
import { parentFromScratchpadCwd } from "./detect.ts";

export const HARNESS_BACKFILL_MARKER = "harness_backfill_v1";

interface LegacyCursorSession {
  sessionId: string;
  model: string | null;
  cwd: string | null;
  cursorVersion: string | null;
}

/** Every session with at least one Cursor-shaped event on record (a payload
 *  containing `"cursor_version"`), read from its MOST RECENT such event -
 *  matching `events-migrate.ts`'s own "any row -> the whole session" rule
 *  (§1.2's own finding: real Cursor payloads put `cursor_version` near the
 *  END, so an early truncated row can miss it even though a later one in the
 *  same session doesn't). `model`/`cwd` come from that latest event since a
 *  session's own model/workspace can only be read from what it actually
 *  reported, and the newest report is the most trustworthy. */
function findLegacyCursorSessions(store: Store): LegacyCursorSession[] {
  const rows = store.db
    .query(
      `SELECT session_id, payload FROM events
       WHERE id IN (SELECT MAX(id) FROM events WHERE payload LIKE '%"cursor_version"%' GROUP BY session_id)`
    )
    .all() as { session_id: string; payload: string | null }[];
  const out: LegacyCursorSession[] = [];
  for (const r of rows) {
    let model: string | null = null;
    let cwd: string | null = null;
    let cursorVersion: string | null = null;
    try {
      const p = r.payload ? JSON.parse(r.payload) : {};
      model = typeof p.model === "string" ? p.model : null;
      cursorVersion = typeof p.cursor_version === "string" ? p.cursor_version : null;
      const roots = Array.isArray(p.workspace_roots) ? p.workspace_roots : [];
      const ownCwd = typeof p.cwd === "string" && p.cwd !== "" ? p.cwd : null;
      cwd = ownCwd ?? (typeof roots[0] === "string" ? roots[0] : null);
    } catch {
      // unparseable payload -- the session is still marked cursor below, just
      // with no model/cwd/version recompute from it.
    }
    out.push({ sessionId: r.session_id, model, cwd, cursorVersion });
  }
  return out;
}

export interface LegacyBackfillResult {
  cursorSessions: number;
  usageReattributed: number;
}

/** One-time (§4.5, `app_meta` key `harness_backfill_v1`): fix up sessions and
 *  usage rows recorded before multi-harness ingestion existed.
 *
 *  1. Every session with a Cursor-shaped event becomes `harness='cursor'`,
 *     with `model`/`harness_version` from that event and, ONLY when the
 *     stored `project` is still the generic `'unknown'` (a session
 *     multi-harness never got to resolve at ingest time), `cwd`/`project`/
 *     `branch` recomputed from `workspace_roots[0]` via the SAME git
 *     resolution live ingestion itself uses (`resolveRepoInfo` - a worktree
 *     directory like `.../main` must resolve to its repo name, not the
 *     branch-directory basename `projectFromCwd` would give; falls back to
 *     the basename when the path isn't a repo, exactly like live ingestion's
 *     own "never resolved yet" case). `parent_session_id` is derived from the
 *     (possibly just-recomputed) cwd's scratchpad pattern.
 *  2. Usage rows still bucketed under the legacy placeholder project `'main'`
 *     are re-resolved from their session's cwd via git (this DOES want the
 *     real repo name, unlike step 1 - the session itself may have a perfectly
 *     good git-resolved `project` already; only its USAGE rows are stuck on
 *     the placeholder) and updated only when git ACTUALLY resolves a
 *     different project (`fromGit`) - a failed resolution must leave the
 *     placeholder alone rather than overwrite it with a basename guess. */
export async function backfillLegacyHarness(store: Store, now: number): Promise<LegacyBackfillResult> {
  if (store.getMeta(HARNESS_BACKFILL_MARKER)) return { cursorSessions: 0, usageReattributed: 0 };

  let cursorSessions = 0;
  for (const info of findLegacyCursorSessions(store)) {
    const existing = store.getSession(info.sessionId);
    if (!existing) continue; // an event with no surviving session row (pruned/never inserted)
    const patch: SessionPatch = { harness: "cursor" };
    if (info.model) patch.model = info.model;
    if (info.cursorVersion) patch.harness_version = info.cursorVersion;
    let cwdForParent = existing.cwd;
    if (existing.project === "unknown" && info.cwd) {
      const repo = await resolveRepoInfo(info.cwd);
      patch.cwd = info.cwd;
      patch.project = repo.project;
      patch.branch = repo.branch;
      cwdForParent = info.cwd;
    }
    const parent = parentFromScratchpadCwd(cwdForParent);
    if (parent) patch.parent_session_id = parent;
    store.applyEvent(info.sessionId, patch, now);
    cursorSessions++;
  }

  let usageReattributed = 0;
  const mainRows = store.db.query(`SELECT DISTINCT session_id FROM usage WHERE project = 'main'`).all() as {
    session_id: string;
  }[];
  for (const { session_id } of mainRows) {
    const session = store.getSession(session_id);
    if (!session || !session.cwd) continue;
    const info = await resolveRepoInfo(session.cwd);
    if (info.fromGit && info.project !== "main") {
      const res = store.db
        .query(`UPDATE usage SET project = $p WHERE session_id = $s AND project = 'main'`)
        .run({ $p: info.project, $s: session_id });
      if (res.changes > 0) {
        usageReattributed += res.changes;
        store.bumpUsageVersion();
      }
    }
  }

  store.setMeta(HARNESS_BACKFILL_MARKER, String(now));
  return { cursorSessions, usageReattributed };
}
