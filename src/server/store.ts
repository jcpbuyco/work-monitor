import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Session, SessionPatch, Todo, TodoStatus, CreateTodoInput, UpdateTodoInput } from "./types.ts";
import type { Tokens } from "./pricing.ts";

const SESSION_COLS =
  "id, project, cwd, transcript_path, status, current_task, current_intent, attention_reason, active_tool, branch, started_at, last_activity_at, ended_at";

const TODO_COLS =
  "id, title, note, for_who, status, origin_session_id, origin_project, branch, links, position, created_at, updated_at";

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
  }): boolean {
    // Stamp the session's then-current project/branch so historical cost can be
    // attributed without a join (and survives the session row being mutated later).
    // Idempotent via the message_uuid key: the stamp is captured at first ingestion.
    const res = this.db
      .query(
        `INSERT OR IGNORE INTO usage
           (message_uuid, session_id, model, input_tokens, output_tokens,
            cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens, cost_usd, project, branch, at)
         VALUES ($u, $s, $m, $in, $out, $cr, $c5, $c1, $cost,
                 (SELECT project FROM sessions WHERE id = $s),
                 (SELECT branch FROM sessions WHERE id = $s), $at)`
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
    const TOKENS =
      "(input_tokens + output_tokens + cache_read_tokens + cache_create_5m_tokens + cache_create_1h_tokens)";

    const per = this.db
      .query(`SELECT session_id, SUM(cost_usd) AS cost, SUM${TOKENS} AS tokens FROM usage GROUP BY session_id`)
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
}
