import type { Session } from "./types.ts";

export interface SessionNode {
  session: Session;
  children: SessionNode[];
  /** Set only for an "orphan": a session with `parent_session_id` set whose
   *  parent is NOT part of `columnSessions` (filtered out by the harness
   *  filter, sitting in a different status column, or already ended/gone) -    *  the parent's project, for the row's "spawned by <project>" hint. Null
   *  for a true top-level session, and for a nested child (whose parent IS in
   *  this column, so it renders nested instead). */
  spawnedByProject: string | null;
}

/** §5.1: nests child sessions under their parent WITHIN one status column -  *  the board's kanban layout has three separate lists (needs_you/working/
 *  idle) with no way to draw a connector across them, so nesting only ever
 *  happens between sessions the caller put in the SAME `columnSessions` list.
 *  A child whose parent isn't there (a different column, filtered out by the
 *  harness Segmented, or the parent has ended/gone) still renders - top-level,
 *  in its own column - with an orphan hint instead of vanishing or crashing.
 *
 *  `allSessions` is the full, harness-UNfiltered session list, consulted only
 *  to resolve an orphan's parent PROJECT for that hint; it never changes which
 *  sessions get nested (that's `columnSessions` alone). */
export function buildSessionTree(columnSessions: Session[], allSessions: Session[]): SessionNode[] {
  const byId = new Map(allSessions.map((s) => [s.id, s]));
  const columnIds = new Set(columnSessions.map((s) => s.id));
  const childrenOf = new Map<string, Session[]>();
  const roots: Session[] = [];

  for (const s of columnSessions) {
    if (s.parent_session_id && columnIds.has(s.parent_session_id)) {
      const list = childrenOf.get(s.parent_session_id);
      if (list) list.push(s);
      else childrenOf.set(s.parent_session_id, [s]);
    } else {
      roots.push(s);
    }
  }

  const toNode = (s: Session): SessionNode => ({
    session: s,
    children: (childrenOf.get(s.id) ?? []).map(toNode),
    spawnedByProject:
      s.parent_session_id && !columnIds.has(s.parent_session_id) ? (byId.get(s.parent_session_id)?.project ?? null) : null,
  });

  return roots.map(toNode);
}
