import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Session, SessionPatch, Todo, TodoStatus, CreateTodoInput, UpdateTodoInput } from "./types.ts";
import type { Tokens } from "./pricing.ts";
import { deriveRunState } from "./workflows.ts";
import { WF_QUIET_MS, WF_RECHECK_MS } from "./config.ts";

const SESSION_COLS =
  "id, project, cwd, transcript_path, status, current_task, current_intent, attention_reason, active_tool, branch, started_at, last_activity_at, ended_at";

const TODO_COLS =
  "id, title, note, for_who, status, origin_session_id, origin_project, branch, links, position, created_at, updated_at";

/** SQL expression summing every token type on a `usage` row. */
const TOKEN_SUM =
  "(input_tokens + output_tokens + cache_read_tokens + cache_create_5m_tokens + cache_create_1h_tokens)";

/** Build an optional `usage.at` time filter: `since` inclusive, `until` exclusive. */
function rangeClause(range: { since?: number; until?: number }): { where: string; params: Record<string, number> } {
  const conds: string[] = [];
  const params: Record<string, number> = {};
  if (range.since !== undefined) {
    conds.push("at >= $since");
    params.$since = range.since;
  }
  if (range.until !== undefined) {
    conds.push("at < $until");
    params.$until = range.until;
  }
  return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
}

function rowToTodo(row: Record<string, unknown>): Todo {
  return {
    ...(row as unknown as Todo),
    links: row.links ? (JSON.parse(row.links as string) as string[]) : null,
  };
}

function baseName(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

/** A short, human-friendly one-liner for a tool call, derived from its input.
 *  Returns null when there's nothing concise to show. Capped in length and
 *  reduced to basenames / descriptions so we never ship file contents, full
 *  diffs, or long raw commands to the dashboard. */
export function summarizeTool(tool: string | null, input: unknown): string | null {
  if (!tool || !input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  let s: string | null = null;
  if (tool === "Bash") s = (i.description as string) || (i.command as string) || null;
  else if (/^(Read|Edit|Write|MultiEdit|NotebookEdit)$/.test(tool) && typeof i.file_path === "string")
    s = baseName(i.file_path);
  else if ((tool === "Grep" || tool === "Glob") && (i.pattern || i.glob)) s = String(i.pattern ?? i.glob);
  else if ((tool === "Task" || tool === "Agent") && typeof i.description === "string") s = i.description;
  else if (typeof i.url === "string") s = i.url;
  else if (typeof i.query === "string") s = i.query;
  if (!s) return null;
  s = s.replace(/\s+/g, " ").trim();
  return s.length > 100 ? s.slice(0, 99) + "…" : s;
}

export interface WorkflowRunUpsert {
  run_id: string;
  session_id: string;
  dir: string;
  name?: string | null;
  summary?: string | null;
  status?: string | null;
  error?: string | null;
  started_at?: number | null;
  ended_at?: number | null;
  duration_ms?: number | null;
  agent_count?: number | null;
  phases?: string | null;
  cc_version?: string | null;
  manifest_seen?: boolean;
  /** The manifest file's mtime as of the parse that produced this upsert. A
   *  rewritten manifest (C6) advances it without touching the run dir, which is
   *  how scanRun knows to re-parse (§1.4). */
  manifest_mtime?: number | null;
  last_seen_at?: number | null;
  schema_ok?: boolean;
  total_tokens_reported?: number | null;
}

export interface WorkflowAgentUpsert {
  run_id: string;
  agent_id: string;
  label?: string | null;
  phase_index?: number | null;
  phase_title?: string | null;
  idx?: number | null;
  model?: string | null;
  state?: string | null;
  attempt?: number | null;
  journal_key?: string | null;
  last_tool?: string | null;
  last_tool_summary?: string | null;
  prompt_preview?: string | null;
  started_at?: number | null;
  ended_at?: number | null;
  duration_ms?: number | null;
  tool_calls?: number | null;
}

export interface WorkflowRunScanRow {
  run_id: string;
  session_id: string;
  dir: string;
  manifest_seen: number;
  manifest_mtime: number | null;
  status: string | null;
  last_seen_at: number | null;
  session_status: string;
}

export interface WorkflowAgentView {
  agent_id: string;
  label: string | null;
  phase_index: number | null;
  phase_title: string | null;
  idx: number | null;
  model: string | null;
  state: string | null;
  attempt: number | null;
  last_tool: string | null;
  last_tool_summary: string | null;
  prompt_preview: string | null;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  tool_calls: number | null;
  tokens: number;
  costUsd: number;
}

export interface WorkflowRun {
  run_id: string;
  session_id: string;
  project: string;
  branch: string | null;
  name: string | null;
  summary: string | null;
  status: string | null;
  state: string;
  error: string | null;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  agent_count: number | null;
  phases: { title: string; detail: string | null }[];
  cc_version: string | null;
  schema_ok: boolean;
  total_tokens_reported: number | null;
  costUsd: number;
  tokens: number;
  agents: WorkflowAgentView[];
}

export interface LiveWorkflow {
  run_id: string;
  session_id: string;
  project: string;
  branch: string | null;
  name: string | null;
  status: string | null;
  state: string;
  started_at: number | null;
  /** 1-based verbatim, so a pill reads `Phase ${index}/${total}` with no arithmetic. */
  phase: { index: number; total: number; title: string } | null;
  schema_ok: boolean;
  costUsd: number;
  tokens: number;
  agents: WorkflowAgentView[];
}

export class Store {
  constructor(public db: Database) {}

  applyEvent(sessionId: string, patch: SessionPatch, now: number): Session {
    const existing = this.getSession(sessionId);
    if (!existing) {
      this.db
        .query(
          `INSERT INTO sessions (id, project, cwd, transcript_path, status, current_task, current_intent, attention_reason, active_tool, branch, started_at, last_activity_at, ended_at)
           VALUES ($id, $project, $cwd, $transcript_path, $status, $current_task, $current_intent, $attention_reason, $active_tool, $branch, $started_at, $last_activity_at, $ended_at)`
        )
        .run({
          $id: sessionId,
          $project: patch.project ?? "unknown",
          $cwd: patch.cwd ?? "",
          $transcript_path: patch.transcript_path ?? null,
          $status: patch.status ?? "working",
          $current_task: patch.current_task ?? null,
          $current_intent: patch.current_intent ?? null,
          $attention_reason: patch.attention_reason ?? null,
          $active_tool: patch.active_tool ?? null,
          $branch: patch.branch ?? null,
          $started_at: now,
          $last_activity_at: patch.last_activity_at ?? now,
          $ended_at: patch.ended_at ?? null,
        });
      return this.getSession(sessionId)!;
    }

    const fields: string[] = [];
    const params: Record<string, unknown> = { $id: sessionId };
    for (const key of [
      "project",
      "cwd",
      "transcript_path",
      "status",
      "current_task",
      "current_intent",
      "attention_reason",
      "active_tool",
      "branch",
      "last_activity_at",
      "ended_at",
    ] as const) {
      if (key in patch) {
        fields.push(`${key} = $${key}`);
        params[`$${key}`] = (patch as Record<string, unknown>)[key] ?? null;
      }
    }
    if (fields.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.db.query(`UPDATE sessions SET ${fields.join(", ")} WHERE id = $id`).run(params as any);
    }
    return this.getSession(sessionId)!;
  }

  getSession(id: string): Session | null {
    const row = this.db.query(`SELECT ${SESSION_COLS} FROM sessions WHERE id = $id`).get({ $id: id });
    return (row as Session) ?? null;
  }

  listSessions(opts: { includeEnded?: boolean } = {}): Session[] {
    const where = opts.includeEnded ? "" : "WHERE status != 'ended'";
    return this.db
      .query(`SELECT ${SESSION_COLS} FROM sessions ${where} ORDER BY last_activity_at DESC`)
      .all() as Session[];
  }

  /** Most recent tool-call activity across all sessions, newest first.
   *  Parses `tool_name` out of stored `activity` event payloads. */
  recentActivity(
    limit: number
  ): { id: number; session_id: string; tool: string; detail: string | null; dur: number | null; at: number }[] {
    const rows = this.db
      .query(
        `SELECT id, session_id, payload, at FROM events WHERE type = 'activity' ORDER BY at DESC LIMIT $limit`
      )
      .all({ $limit: limit }) as { id: number; session_id: string; payload: string | null; at: number }[];
    const out: { id: number; session_id: string; tool: string; detail: string | null; dur: number | null; at: number }[] =
      [];
    for (const r of rows) {
      let tool: string | null = null;
      let detail: string | null = null;
      let dur: number | null = null;
      try {
        if (r.payload) {
          const p = JSON.parse(r.payload) as { tool_name?: string; tool_input?: unknown; duration_ms?: unknown };
          tool = p.tool_name ?? null;
          detail = summarizeTool(tool, p.tool_input);
          dur = typeof p.duration_ms === "number" ? p.duration_ms : null;
        }
      } catch {}
      if (tool) out.push({ id: r.id, session_id: r.session_id, tool, detail, dur, at: r.at });
    }
    return out;
  }

  /** Per-tool usage aggregated across all stored tool calls, busiest first.
   *  The inner query filters with json_valid first because some payloads were
   *  truncated to invalid JSON at ingestion (>8000 chars); json_extract would
   *  otherwise throw on the first malformed row and abort the whole GROUP BY.
   *  Wrapped in try/catch so stats can never break the rest of /api/state. */
  toolStats(): { tool: string; calls: number; totalMs: number; avgMs: number | null }[] {
    try {
      const rows = this.db
        .query(
          `SELECT tool,
                  COUNT(*) AS calls,
                  COALESCE(SUM(dur), 0) AS total_ms,
                  SUM(CASE WHEN dur IS NOT NULL THEN 1 ELSE 0 END) AS timed
           FROM (
             SELECT json_extract(payload, '$.tool_name') AS tool,
                    json_extract(payload, '$.duration_ms') AS dur
             FROM events
             WHERE type = 'activity' AND json_valid(payload)
           )
           WHERE tool IS NOT NULL
           GROUP BY tool
           ORDER BY calls DESC`
        )
        .all() as { tool: string; calls: number; total_ms: number; timed: number }[];
      return rows.map((r) => ({
        tool: r.tool,
        calls: r.calls,
        totalMs: r.total_ms,
        avgMs: r.timed > 0 ? Math.round(r.total_ms / r.timed) : null,
      }));
    } catch {
      return [];
    }
  }

  /** Two-tier staleness sweep. Returns ids whose status changed.
   *  - A *working* session quiet for `staleMs` is marked `idle` (still on the board).
   *  - ANY non-ended session silent for the longer `deadMs` is retired to `ended`
   *    (hidden from the board) — a session emits no events while waiting, so this
   *    prolonged silence is the only signal that a terminal was closed or crashed. */
  sweepStale(now: number, staleMs: number, deadMs: number): string[] {
    const affected: string[] = [];

    // Retire long-silent sessions first so a working session past `deadMs` goes
    // straight to ended rather than being relabeled idle below.
    const dead = this.db
      .query(`SELECT id FROM sessions WHERE status != 'ended' AND last_activity_at < $cutoff`)
      .all({ $cutoff: now - deadMs }) as { id: string }[];
    for (const { id } of dead) {
      this.db
        .query(`UPDATE sessions SET status = 'ended', ended_at = $now WHERE id = $id`)
        .run({ $now: now, $id: id });
      affected.push(id);
    }

    // Mark still-living but quiet working sessions idle.
    const idle = this.db
      .query(`SELECT id FROM sessions WHERE status = 'working' AND last_activity_at < $cutoff`)
      .all({ $cutoff: now - staleMs }) as { id: string }[];
    for (const { id } of idle) {
      this.db.query(`UPDATE sessions SET status = 'idle' WHERE id = $id`).run({ $id: id });
      affected.push(id);
    }

    return affected;
  }

  recordUsage(u: {
    uuid: string;
    sessionId: string;
    model: string;
    tokens: Tokens;
    at: number;
    cost: number;
    runId?: string;
    agentId?: string;
  }): boolean {
    // Stamp the session's then-current project/branch so historical cost can be
    // attributed without a join (and survives the session row being mutated later).
    // Idempotent via the message_uuid key: the stamp is captured at first ingestion.
    const res = this.db
      .query(
        `INSERT OR IGNORE INTO usage
           (message_uuid, session_id, model, input_tokens, output_tokens,
            cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens, cost_usd, project, branch, at,
            run_id, agent_id)
         VALUES ($u, $s, $m, $in, $out, $cr, $c5, $c1, $cost,
                 (SELECT project FROM sessions WHERE id = $s),
                 (SELECT branch FROM sessions WHERE id = $s), $at,
                 $run, $agent)`
      )
      .run({
        $u: u.uuid,
        $s: u.sessionId,
        $m: u.model,
        $in: u.tokens.input,
        $out: u.tokens.output,
        $cr: u.tokens.cache_read,
        $c5: u.tokens.cache_create_5m,
        $c1: u.tokens.cache_create_1h,
        $cost: u.cost,
        $at: u.at,
        $run: u.runId ?? null,
        $agent: u.agentId ?? null,
      });
    return res.changes > 0;
  }

  setUsageOffset(id: string, offset: number): void {
    this.db.query(`UPDATE sessions SET usage_offset = $o WHERE id = $id`).run({ $o: offset, $id: id });
  }

  getTailInfo(id: string): { transcript_path: string | null; usage_offset: number } | null {
    const row = this.db
      .query(`SELECT transcript_path, usage_offset FROM sessions WHERE id = $id`)
      .get({ $id: id });
    return (row as { transcript_path: string | null; usage_offset: number }) ?? null;
  }

  /** Process-independent key/value marker store. Used by one-shot maintenance
   *  routines (e.g. repricing) so a restart cannot re-run them. */
  getMeta(key: string): string | null {
    const row = this.db.query(`SELECT value FROM app_meta WHERE key = $k`).get({ $k: key }) as
      | { value: string | null }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .query(`INSERT INTO app_meta (key, value) VALUES ($k, $v) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run({ $k: key, $v: value });
  }

  sessionsToTail(): { id: string; transcript_path: string | null; usage_offset: number }[] {
    return this.db
      .query(
        `SELECT id, transcript_path, usage_offset FROM sessions
         WHERE status != 'ended' AND transcript_path IS NOT NULL`
      )
      .all() as { id: string; transcript_path: string | null; usage_offset: number }[];
  }

  costSummary(midnightMs: number): {
    perSession: Record<string, { costUsd: number; tokens: number }>;
    liveTotalUsd: number;
    todayUsd: number;
    byModelToday: { model: string; costUsd: number }[];
  } {
    const per = this.db
      .query(`SELECT session_id, SUM(cost_usd) AS cost, SUM${TOKEN_SUM} AS tokens FROM usage GROUP BY session_id`)
      .all() as { session_id: string; cost: number; tokens: number }[];
    const perSession: Record<string, { costUsd: number; tokens: number }> = {};
    for (const r of per) perSession[r.session_id] = { costUsd: r.cost, tokens: r.tokens };

    const live = this.db
      .query(
        `SELECT COALESCE(SUM(u.cost_usd), 0) AS c FROM usage u
         JOIN sessions s ON s.id = u.session_id WHERE s.status != 'ended'`
      )
      .get() as { c: number };

    const today = this.db
      .query(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM usage WHERE at >= $m`)
      .get({ $m: midnightMs }) as { c: number };

    const byModel = this.db
      .query(
        `SELECT model, SUM(cost_usd) AS c FROM usage WHERE at >= $m
         GROUP BY model HAVING c > 0 ORDER BY c DESC`
      )
      .all({ $m: midnightMs }) as { model: string; c: number }[];

    return {
      perSession,
      liveTotalUsd: live.c,
      todayUsd: today.c,
      byModelToday: byModel.map((r) => ({ model: r.model, costUsd: r.c })),
    };
  }

  /** Lifetime (or ranged) cost + tokens grouped by project, highest spend first.
   *  Usage with no resolvable project (e.g. pre-attribution rows) buckets under
   *  'unknown'. `range` filters on the message timestamp (since inclusive, until
   *  exclusive); omit it for all-time. */
  costByProject(range: { since?: number; until?: number } = {}): { project: string; costUsd: number; tokens: number }[] {
    const { where, params } = rangeClause(range);
    const rows = this.db
      .query(
        `SELECT COALESCE(usage.project, 'unknown') AS project, SUM(cost_usd) AS cost, SUM${TOKEN_SUM} AS tokens
         FROM usage ${where} GROUP BY usage.project ORDER BY cost DESC, usage.project`
      )
      .all(params) as { project: string; cost: number; tokens: number }[];
    return rows.map((r) => ({ project: r.project, costUsd: r.cost, tokens: r.tokens }));
  }

  /** Lifetime (or ranged) cost + tokens grouped by (project, branch), highest
   *  spend first. Grouping by project too keeps same-named branches (e.g. `main`)
   *  from merging across repos; `branch` stays null when the session had none. */
  costByBranch(
    range: { since?: number; until?: number } = {}
  ): { project: string; branch: string | null; costUsd: number; tokens: number }[] {
    const { where, params } = rangeClause(range);
    const rows = this.db
      .query(
        `SELECT COALESCE(usage.project, 'unknown') AS project, usage.branch AS branch,
                SUM(cost_usd) AS cost, SUM${TOKEN_SUM} AS tokens
         FROM usage ${where} GROUP BY usage.project, usage.branch ORDER BY cost DESC, usage.project, usage.branch`
      )
      .all(params) as { project: string; branch: string | null; cost: number; tokens: number }[];
    return rows.map((r) => ({ project: r.project, branch: r.branch, costUsd: r.cost, tokens: r.tokens }));
  }

  /** Cost + tokens grouped by (project, branch, local day "YYYY-MM-DD"), newest
   *  day first. `range` filters on the message timestamp (since inclusive, until
   *  exclusive); omit for all-time. Unattributed usage buckets under 'unknown';
   *  branch stays null when absent. Client re-sorts as needed — this order is a
   *  stable baseline. */
  costDaily(
    range: { since?: number; until?: number } = {}
  ): { project: string; branch: string | null; day: string; costUsd: number; tokens: number }[] {
    const { where, params } = rangeClause(range);
    const rows = this.db
      .query(
        `SELECT COALESCE(usage.project, 'unknown') AS project, usage.branch AS branch,
                strftime('%Y-%m-%d', at / 1000, 'unixepoch', 'localtime') AS day,
                SUM(cost_usd) AS cost, SUM${TOKEN_SUM} AS tokens
         FROM usage ${where} GROUP BY usage.project, usage.branch, day ORDER BY day DESC, cost DESC`
      )
      .all(params) as { project: string; branch: string | null; day: string; cost: number; tokens: number }[];
    return rows.map((r) => ({ project: r.project, branch: r.branch, day: r.day, costUsd: r.cost, tokens: r.tokens }));
  }

  createTodo(input: CreateTodoInput, now: number): Todo {
    const id = randomUUID();
    const nextPos =
      (this.db.query(`SELECT COALESCE(MAX(position), -1) AS m FROM todos WHERE status = 'todo'`).get() as { m: number }).m + 1;
    this.db
      .query(
        `INSERT INTO todos (${TODO_COLS}) VALUES ($id, $title, $note, $for_who, 'todo', $origin_session_id, $origin_project, $branch, $links, $position, $created_at, $updated_at)`
      )
      .run({
        $id: id,
        $title: input.title,
        $note: input.note ?? "",
        $for_who: input.for_who ?? null,
        $origin_session_id: input.origin_session_id ?? null,
        $origin_project: input.origin_project ?? null,
        $branch: input.branch ?? null,
        $links: input.links ? JSON.stringify(input.links) : null,
        $position: nextPos,
        $created_at: now,
        $updated_at: now,
      });
    return this.getTodo(id)!;
  }

  getTodo(id: string): Todo | null {
    const row = this.db.query(`SELECT ${TODO_COLS} FROM todos WHERE id = $id`).get({ $id: id });
    return row ? rowToTodo(row as Record<string, unknown>) : null;
  }

  listTodos(status?: TodoStatus): Todo[] {
    const where = status ? "WHERE status = $status" : "";
    const rows = this.db
      .query(`SELECT ${TODO_COLS} FROM todos ${where} ORDER BY status, position ASC`)
      .all(status ? { $status: status } : {}) as Record<string, unknown>[];
    return rows.map(rowToTodo);
  }

  updateTodo(id: string, patch: UpdateTodoInput, now: number): Todo | null {
    if (!this.getTodo(id)) return null;
    const fields: string[] = ["updated_at = $updated_at"];
    const params: Record<string, unknown> = { $id: id, $updated_at: now };
    for (const key of ["title", "note", "for_who", "status", "branch", "position"] as const) {
      if (key in patch) {
        fields.push(`${key} = $${key}`);
        const val = (patch as Record<string, unknown>)[key];
        params[`$${key}`] = key === "note" ? (val ?? "") : (val ?? null);
      }
    }
    if ("links" in patch) {
      fields.push("links = $links");
      params.$links = patch.links ? JSON.stringify(patch.links) : null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.db.query(`UPDATE todos SET ${fields.join(", ")} WHERE id = $id`).run(params as any);
    return this.getTodo(id);
  }

  deleteTodo(id: string): boolean {
    const res = this.db.query(`DELETE FROM todos WHERE id = $id`).run({ $id: id });
    return res.changes > 0;
  }

  // --- workflows ---------------------------------------------------------

  /** Insert-or-enrich a run row. `project`/`branch` are stamped from the owning
   *  session at FIRST sight only (matching recordUsage's convention) and never
   *  re-stamped. Every other column takes the new value when it is non-null and
   *  keeps the stored one otherwise, so a tick that knows less (no manifest yet)
   *  cannot blank what an earlier tick learned. */
  upsertWorkflowRun(r: WorkflowRunUpsert): void {
    this.db
      .query(
        `INSERT INTO workflow_runs
           (run_id, session_id, project, branch, name, summary, status, error, started_at, ended_at,
            duration_ms, agent_count, phases, cc_version, manifest_seen, manifest_mtime, last_seen_at,
            dir, schema_ok, total_tokens_reported)
         VALUES ($run, $sess,
                 (SELECT project FROM sessions WHERE id = $sess),
                 (SELECT branch FROM sessions WHERE id = $sess),
                 $name, $summary, $status, $error, $started, $ended, $dur, $count, $phases, $ver,
                 $manifest, $mmtime, $seen, $dir, $ok, $reported)
         ON CONFLICT(run_id) DO UPDATE SET
           name = COALESCE(excluded.name, workflow_runs.name),
           summary = COALESCE(excluded.summary, workflow_runs.summary),
           status = COALESCE(excluded.status, workflow_runs.status),
           error = excluded.error,
           started_at = COALESCE(excluded.started_at, workflow_runs.started_at),
           ended_at = COALESCE(excluded.ended_at, workflow_runs.ended_at),
           duration_ms = COALESCE(excluded.duration_ms, workflow_runs.duration_ms),
           agent_count = COALESCE(excluded.agent_count, workflow_runs.agent_count),
           phases = COALESCE(excluded.phases, workflow_runs.phases),
           cc_version = COALESCE(excluded.cc_version, workflow_runs.cc_version),
           manifest_seen = MAX(excluded.manifest_seen, workflow_runs.manifest_seen),
           manifest_mtime = COALESCE(excluded.manifest_mtime, workflow_runs.manifest_mtime),
           last_seen_at = COALESCE(excluded.last_seen_at, workflow_runs.last_seen_at),
           dir = excluded.dir,
           schema_ok = excluded.schema_ok,
           total_tokens_reported = COALESCE(excluded.total_tokens_reported, workflow_runs.total_tokens_reported)`
      )
      .run({
        $run: r.run_id,
        $sess: r.session_id,
        $name: r.name ?? null,
        $summary: r.summary ?? null,
        $status: r.status ?? null,
        $error: r.error ?? null,
        $started: r.started_at ?? null,
        $ended: r.ended_at ?? null,
        $dur: r.duration_ms ?? null,
        $count: r.agent_count ?? null,
        $phases: r.phases ?? null,
        $ver: r.cc_version ?? null,
        $manifest: r.manifest_seen ? 1 : 0,
        // Only a pass that actually stat'd the manifest passes this; a plain
        // re-stat tick leaves it null and COALESCE keeps the stored value.
        $mmtime: r.manifest_mtime ?? null,
        $seen: r.last_seen_at ?? null,
        $dir: r.dir,
        $ok: r.schema_ok === false ? 0 : 1,
        $reported: r.total_tokens_reported ?? null,
      });
  }

  /** Insert-or-enrich an agent row. `offset` is deliberately absent from this
   *  method — it is owned by setWorkflowAgentOffset so enrichment can never
   *  rewind the tail position. */
  upsertWorkflowAgent(a: WorkflowAgentUpsert): void {
    this.db
      .query(
        `INSERT INTO workflow_agents
           (run_id, agent_id, label, phase_index, phase_title, idx, model, state, attempt, journal_key,
            last_tool, last_tool_summary, prompt_preview, started_at, ended_at, duration_ms, tool_calls, offset)
         VALUES ($run, $agent, $label, $pidx, $ptitle, $idx, $model, $state, $attempt, $key,
                 $tool, $tsum, $prompt, $started, $ended, $dur, $calls, 0)
         ON CONFLICT(run_id, agent_id) DO UPDATE SET
           label = COALESCE(excluded.label, workflow_agents.label),
           phase_index = COALESCE(excluded.phase_index, workflow_agents.phase_index),
           phase_title = COALESCE(excluded.phase_title, workflow_agents.phase_title),
           idx = COALESCE(excluded.idx, workflow_agents.idx),
           model = COALESCE(excluded.model, workflow_agents.model),
           state = COALESCE(excluded.state, workflow_agents.state),
           attempt = COALESCE(excluded.attempt, workflow_agents.attempt),
           journal_key = COALESCE(excluded.journal_key, workflow_agents.journal_key),
           last_tool = COALESCE(excluded.last_tool, workflow_agents.last_tool),
           last_tool_summary = COALESCE(excluded.last_tool_summary, workflow_agents.last_tool_summary),
           prompt_preview = COALESCE(excluded.prompt_preview, workflow_agents.prompt_preview),
           started_at = COALESCE(excluded.started_at, workflow_agents.started_at),
           ended_at = COALESCE(excluded.ended_at, workflow_agents.ended_at),
           duration_ms = COALESCE(excluded.duration_ms, workflow_agents.duration_ms),
           tool_calls = COALESCE(excluded.tool_calls, workflow_agents.tool_calls)`
      )
      .run({
        $run: a.run_id,
        $agent: a.agent_id,
        $label: a.label ?? null,
        $pidx: a.phase_index ?? null,
        $ptitle: a.phase_title ?? null,
        $idx: a.idx ?? null,
        $model: a.model ?? null,
        $state: a.state ?? null,
        $attempt: a.attempt ?? null,
        $key: a.journal_key ?? null,
        $tool: a.last_tool ?? null,
        $tsum: a.last_tool_summary ?? null,
        $prompt: a.prompt_preview ?? null,
        $started: a.started_at ?? null,
        $ended: a.ended_at ?? null,
        $dur: a.duration_ms ?? null,
        $calls: a.tool_calls ?? null,
      });
  }

  private static readonly WF_SCAN_COLS = `r.run_id, r.session_id, r.dir, r.manifest_seen,
    r.manifest_mtime, r.status, r.last_seen_at, COALESCE(s.status, 'ended') AS session_status`;

  getWorkflowRun(runId: string): WorkflowRunScanRow | null {
    const row = this.db
      .query(
        `SELECT ${Store.WF_SCAN_COLS} FROM workflow_runs r
         LEFT JOIN sessions s ON s.id = r.session_id WHERE r.run_id = $run`
      )
      .get({ $run: runId });
    return (row as WorkflowRunScanRow) ?? null;
  }

  /** Runs worth touching this tick: never-seen ones plus anything whose dir moved
   *  after `cutoff` (= now - WF_RECHECK_MS). Beyond that window a run is final,
   *  which bounds the re-stat cost regardless of how much history accumulates.
   *  A purged owning session reads as 'ended' so deriveRunState calls it orphaned. */
  workflowRunsToScan(cutoff: number): WorkflowRunScanRow[] {
    return this.db
      .query(
        `SELECT ${Store.WF_SCAN_COLS} FROM workflow_runs r
         LEFT JOIN sessions s ON s.id = r.session_id
         WHERE r.last_seen_at IS NULL OR r.last_seen_at > $cutoff`
      )
      .all({ $cutoff: cutoff }) as WorkflowRunScanRow[];
  }

  workflowAgentOffsets(runId: string): { agent_id: string; offset: number }[] {
    return this.db
      .query(`SELECT agent_id, offset FROM workflow_agents WHERE run_id = $run ORDER BY agent_id`)
      .all({ $run: runId }) as { agent_id: string; offset: number }[];
  }

  setWorkflowAgentOffset(runId: string, agentId: string, offset: number): void {
    this.db
      .query(`UPDATE workflow_agents SET offset = $o WHERE run_id = $run AND agent_id = $agent`)
      .run({ $o: offset, $run: runId, $agent: agentId });
  }

  /** Turn raw workflow_runs rows into API views: parse `phases` back from JSON,
   *  derive the liveness state, and join the per-agent usage rollup. Per-agent
   *  tokens and cost are NOT stored — they are derived from `usage`, so there is
   *  one priced source of truth and it works live, before any manifest exists. */
  private hydrateWorkflowRuns(rows: Record<string, any>[], now: number): WorkflowRun[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.run_id as string);
    const ph = ids.map((_, i) => `$r${i}`).join(", ");
    const params: Record<string, string> = {};
    ids.forEach((id, i) => (params[`$r${i}`] = id));

    const rollup = this.db
      .query(
        `SELECT run_id, agent_id, SUM(cost_usd) AS cost, SUM${TOKEN_SUM} AS tokens
         FROM usage WHERE run_id IN (${ph}) GROUP BY run_id, agent_id`
      )
      .all(params) as { run_id: string; agent_id: string | null; cost: number; tokens: number }[];
    const byAgent = new Map<string, { cost: number; tokens: number }>();
    const byRun = new Map<string, { cost: number; tokens: number }>();
    for (const r of rollup) {
      byAgent.set(`${r.run_id} ${r.agent_id ?? ""}`, { cost: r.cost, tokens: r.tokens });
      const t = byRun.get(r.run_id) ?? { cost: 0, tokens: 0 };
      byRun.set(r.run_id, { cost: t.cost + r.cost, tokens: t.tokens + r.tokens });
    }

    const agentRows = this.db
      .query(`SELECT * FROM workflow_agents WHERE run_id IN (${ph}) ORDER BY run_id, idx, agent_id`)
      .all(params) as Record<string, any>[];
    const agentsByRun = new Map<string, WorkflowAgentView[]>();
    for (const a of agentRows) {
      const roll = byAgent.get(`${a.run_id} ${a.agent_id}`) ?? { cost: 0, tokens: 0 };
      const list = agentsByRun.get(a.run_id) ?? [];
      list.push({
        agent_id: a.agent_id,
        label: a.label,
        phase_index: a.phase_index,
        phase_title: a.phase_title,
        idx: a.idx,
        model: a.model,
        state: a.state,
        attempt: a.attempt,
        last_tool: a.last_tool,
        last_tool_summary: a.last_tool_summary,
        prompt_preview: a.prompt_preview,
        started_at: a.started_at,
        ended_at: a.ended_at,
        duration_ms: a.duration_ms,
        tool_calls: a.tool_calls,
        costUsd: roll.cost,
        tokens: roll.tokens,
      });
      agentsByRun.set(a.run_id, list);
    }

    const sessionStatus = new Map(
      (this.db.query(`SELECT id, status FROM sessions`).all() as { id: string; status: string }[]).map((s) => [
        s.id,
        s.status,
      ])
    );

    return rows.map((r) => {
      let phases: { title: string; detail: string | null }[] = [];
      try {
        if (r.phases) phases = JSON.parse(r.phases as string);
      } catch {
        phases = [];
      }
      const roll = byRun.get(r.run_id) ?? { cost: 0, tokens: 0 };
      return {
        run_id: r.run_id,
        session_id: r.session_id,
        project: r.project ?? "unknown", // matches costByProject's bucket
        branch: r.branch ?? null,
        name: r.name,
        summary: r.summary,
        status: r.status,
        state: deriveRunState(
          {
            manifest_seen: r.manifest_seen === 1,
            status: r.status,
            last_seen_at: r.last_seen_at,
            session_status: sessionStatus.get(r.session_id) ?? "ended",
          },
          now
        ),
        error: r.error,
        started_at: r.started_at,
        ended_at: r.ended_at,
        duration_ms: r.duration_ms,
        agent_count: r.agent_count,
        phases,
        cc_version: r.cc_version,
        schema_ok: r.schema_ok === 1,
        total_tokens_reported: r.total_tokens_reported,
        costUsd: roll.cost,
        tokens: roll.tokens,
        agents: agentsByRun.get(r.run_id) ?? [],
      };
    });
  }

  /** Completed + in-flight runs for the history page, newest first. `since`/`until`
   *  filter on `started_at` (since inclusive, until exclusive), matching
   *  rangeClause()'s convention; runs with a NULL start drop out whenever either
   *  bound is given. `limit` caps RUNS, not agents, and is clamped to 1..500.
   *  Agents are embedded: one endpoint, one round trip, no per-row expand fetch. */
  workflowHistory(
    opts: { since?: number; until?: number; limit?: number } = {},
    now: number = Date.now()
  ): WorkflowRun[] {
    const conds: string[] = [];
    const params: Record<string, number> = {};
    if (opts.since !== undefined) {
      conds.push("started_at >= $since");
      params.$since = opts.since;
    }
    if (opts.until !== undefined) {
      conds.push("started_at < $until");
      params.$until = opts.until;
    }
    const limit = Math.min(500, Math.max(1, Math.round(opts.limit ?? 100)));
    const rows = this.db
      .query(
        `SELECT * FROM workflow_runs ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}
         ORDER BY started_at DESC LIMIT ${limit}`
      )
      .all(params) as Record<string, any>[];
    return this.hydrateWorkflowRuns(rows, now);
  }

  /** Runs to show on the board strip: everything unsettled within the 24h recheck
   *  window. Orphaned runs stay visible deliberately — the state is self-healing,
   *  so a run whose files move again flips back to running.
   *
   *  This is the ONLY payload the 5s tick broadcasts. It must never grow into a
   *  buildState()-sized query — which is why the settled predicate is applied
   *  HERE, in SQL, rather than left to the `.filter()` below: a heavy workflow
   *  day can leave many settled runs inside the 24h window, and hydrating all
   *  of them (per-agent usage rollup, workflow_agents fetch, sessions scan)
   *  just to throw the results away is exactly the buildState()-sized cost
   *  this method must never grow into. The condition mirrors deriveRunState's
   *  "settled" branch exactly (manifest_seen && quiet); the `.filter()` stays
   *  as a defensive backstop, not the primary mechanism. */
  liveWorkflows(now: number = Date.now()): LiveWorkflow[] {
    const rows = this.db
      .query(
        `SELECT * FROM workflow_runs
         WHERE (last_seen_at IS NULL OR last_seen_at > $cutoff)
           AND NOT (manifest_seen = 1 AND (last_seen_at IS NULL OR last_seen_at < $quiet))
         ORDER BY started_at DESC`
      )
      .all({ $cutoff: now - WF_RECHECK_MS, $quiet: now - WF_QUIET_MS }) as Record<string, any>[];

    return this.hydrateWorkflowRuns(rows, now)
      .filter((r) => r.state !== "settled")
      .map((r) => {
        // Current phase = the highest 1-based phase_index any agent carries.
        // Titles come from the manifest/script skeleton; without either there is
        // genuinely no label -> null, and the card says so in words (§4.1).
        const index = r.agents.reduce((m, a) => (a.phase_index != null && a.phase_index > m ? a.phase_index : m), 0);
        const total = r.phases.length;
        const title = index > 0 ? (r.phases[index - 1]?.title ?? r.agents.find((a) => a.phase_index === index)?.phase_title ?? "") : "";
        return {
          run_id: r.run_id,
          session_id: r.session_id,
          project: r.project,
          branch: r.branch,
          name: r.name,
          status: r.status,
          state: r.state,
          started_at: r.started_at,
          phase: index > 0 && total > 0 ? { index, total, title } : null,
          schema_ok: r.schema_ok,
          costUsd: r.costUsd,
          tokens: r.tokens,
          agents: r.agents,
        };
      });
  }
}
