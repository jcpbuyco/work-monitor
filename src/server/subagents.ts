import { readdirSync, readFileSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.ts";
import { takeUsage } from "./usage.ts";
import { sessionDirFor, readAgentHeader } from "./workflows.ts";
import { CLAUDE_PROJECTS_DIR } from "./config.ts";

/** ENOENT (or any other stat/readdir failure) → empty, never a throw. Matches
 *  workflows.ts's own `readdirSafe`. */
function readdirSafe(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

function readFileSafe(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** The subagent transcript's OWN first-line timestamp -- the moment the Task
 *  tool actually spawned it, not "whenever we happened to discover the file"
 *  (which for the startup backfill is the server's own boot time, identically,
 *  for every historic agent -- misleading for a future "which session spawned
 *  which, when" view). Reads only a bounded prefix, never the whole (up to
 *  6.3MB) file. Falls back to the file's birth time, then its mtime, then
 *  `now` -- in that order -- when the first line is missing or unparseable. */
function subagentStartedAt(path: string, now: number): number {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.allocUnsafe(8192);
      const got = readSync(fd, buf, 0, buf.length, 0);
      if (got > 0) {
        const head = buf.subarray(0, got).toString("utf8");
        const nl = head.indexOf("\n");
        const firstLine = nl >= 0 ? head.slice(0, nl) : head;
        const o = JSON.parse(firstLine);
        const t = typeof o?.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
        if (Number.isFinite(t)) return t;
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    // missing/unreadable/unparseable first line -- fall through to file stat
  }
  try {
    const st = statSync(path);
    const birth = st.birthtimeMs;
    return Math.round(birth > 0 ? birth : st.mtimeMs);
  } catch {
    return now;
  }
}

export interface SubagentMeta {
  agent_type: string | null;
  description: string | null;
  model: string | null;
  parent_agent_id: string | null;
}

/** `agent-<id>.meta.json`: `{agentType, description, model, toolUseId,
 *  parentAgentId, spawnDepth}` (§2.4). `toolUseId`/`spawnDepth` are read
 *  nowhere yet -- nothing in this feature needs them -- and are left for a
 *  later workstream to add without another migration. */
export function parseSubagentMeta(text: string): SubagentMeta {
  let o: any;
  try {
    o = JSON.parse(text);
  } catch {
    return { agent_type: null, description: null, model: null, parent_agent_id: null };
  }
  return {
    agent_type: str(o?.agentType),
    description: str(o?.description),
    model: str(o?.model),
    parent_agent_id: str(o?.parentAgentId),
  };
}

const SUBAGENT_FILE_RE = /^agent-(.+)\.jsonl$/;

/** `agent-<id>.jsonl` files directly under `<sessionDir>/subagents`, excluding
 *  the `workflows/` subdirectory -- workflow agents are ingested separately
 *  (§3), and `workflows` fails the filename regex on its own anyway, so this
 *  is a plain readdir with no special-casing needed. */
export function listSubagentFiles(sessionDir: string): { agentId: string; path: string }[] {
  const dir = join(sessionDir, "subagents");
  const out: { agentId: string; path: string }[] = [];
  for (const name of readdirSafe(dir)) {
    const m = SUBAGENT_FILE_RE.exec(name);
    if (!m) continue;
    out.push({ agentId: m[1], path: join(dir, name) });
  }
  return out;
}

/** Register every subagent file not already known for this session. Existing
 *  rows are left untouched (offset/model enrichment is `tailSubagents`' job)
 *  so a repeated discovery pass can never rewind a tail already in progress. */
export function discoverSubagents(store: Store, sessionId: string, sessionDir: string, now: number): number {
  const known = store.subagentIdsForSession(sessionId);
  let discovered = 0;
  for (const f of listSubagentFiles(sessionDir)) {
    if (known.has(f.agentId)) continue;
    const meta = parseSubagentMeta(readFileSafe(f.path.replace(/\.jsonl$/, ".meta.json")));
    store.upsertSubagent({
      agent_id: f.agentId,
      session_id: sessionId,
      agent_type: meta.agent_type,
      description: meta.description,
      model: meta.model,
      parent_agent_id: meta.parent_agent_id,
      path: f.path,
      started_at: subagentStartedAt(f.path, now),
      last_seen_at: now,
    });
    discovered++;
  }
  return discovered;
}

/** Tail every subagent already registered for a session: price new usage
 *  lines (sidechain, deduped by `message_key` so re-tailing after a restart is
 *  safe -- see takeUsage), persist the offset, and resolve `model` from the
 *  transcript's own `message.model` the first time a tail actually records
 *  something (the meta alias is a fallback only, per §2.4).
 *
 *  Gated on `!row.model_resolved`, NOT on "this is the first tail ever" -- a
 *  subagent's file is often discovered before its first API call lands (the
 *  file starts with just the user prompt line), so the FIRST tail can easily
 *  advance the offset while recording nothing. Gating on offset-was-zero would
 *  then permanently miss the resolution: every later tail has a nonzero
 *  `before` and never gets a header read, leaving the meta alias stuck forever
 *  (repro: tests/subagents.test.ts). Once resolved, `model_resolved` makes
 *  this a bounded, one-time cost per agent regardless of which tail it lands
 *  on -- matching the intent (not the exact mechanism) of scanRun's own
 *  first-header-read-only gate for workflow agent transcripts. */
export function tailSubagents(store: Store, sessionId: string, now: number): boolean {
  let changed = false;
  for (const row of store.subagentsForSession(sessionId)) {
    const before = row.offset;
    const r = takeUsage(store, { path: row.path, offset: before, sessionId, agentId: row.agent_id });
    const resolvedModel = !row.model_resolved && r.recorded ? readAgentHeader(row.path).model : null;
    if (r.offset !== before || resolvedModel) store.setSubagentTail(row.agent_id, r.offset, now, resolvedModel);
    if (r.recorded) changed = true;
  }
  return changed;
}

/** One 60s-sweep pass (§2.4): discover new subagent files for a live session,
 *  then tail everything already known for it. Cheap -- one readdir of a small
 *  dir plus per-agent offset reads, no global glob. */
export function sweepSubagents(store: Store, sessionId: string, sessionDir: string, now: number): boolean {
  discoverSubagents(store, sessionId, sessionDir, now);
  return tailSubagents(store, sessionId, now);
}

/** One-time startup pass (§2.4): every session already known to the store
 *  (including ended ones -- Task subagents can keep writing after their
 *  parent session goes idle) PLUS a global glob for subagent files whose
 *  session has no row at all yet (a fresh DB meeting weeks of historical
 *  transcripts, the same rationale as `backfillWorkflows`'s one-time glob). */
export function backfillSubagents(
  store: Store,
  now: number,
  root: string = CLAUDE_PROJECTS_DIR
): { discovered: number; recorded: number } {
  const seen = new Set<string>();
  let discovered = 0;
  let recorded = 0;

  for (const s of store.listSessions({ includeEnded: true })) {
    if (!s.transcript_path) continue;
    seen.add(s.id);
    discovered += discoverSubagents(store, s.id, sessionDirFor(s.transcript_path), now);
    if (tailSubagents(store, s.id, now)) recorded++;
  }

  for (const slug of readdirSafe(root)) {
    for (const sessionId of readdirSafe(join(root, slug))) {
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
      const sessionDir = join(root, slug, sessionId);
      discovered += discoverSubagents(store, sessionId, sessionDir, now);
      if (tailSubagents(store, sessionId, now)) recorded++;
    }
  }

  return { discovered, recorded };
}
