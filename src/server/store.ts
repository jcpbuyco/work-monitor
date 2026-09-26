import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Session, SessionPatch, Todo, TodoStatus, CreateTodoInput, UpdateTodoInput } from "./types.ts";
import type { Tokens } from "./pricing.ts";
import { deriveRunState } from "./workflows.ts";
import { WF_QUIET_MS, WF_RECHECK_MS } from "./config.ts";
import { truncate } from "./derive.ts";
import { computeInsights } from "./insights.ts";
import type { InsightsResponse } from "../shared/insights.ts";

const SESSION_COLS =
  "id, project, cwd, transcript_path, status, current_task, current_intent, attention_reason, active_tool, branch, idle_reason, harness, model, title, parent_session_id, harness_version, started_at, last_activity_at, ended_at";

const TODO_COLS =
  "id, title, note, for_who, status, origin_session_id, origin_project, branch, links, position, created_at, updated_at";

/** SQL expression summing every token type on a `usage` row. */
const TOKEN_SUM =
  "(input_tokens + output_tokens + cache_read_tokens + cache_create_5m_tokens + cache_create_1h_tokens)";

/** SQL aggregate: the token total of only the rows in the group with no price
 *  (`cost_usd IS NULL`) -- an unknown model, or a row awaiting the next
 *  generic reprice pass. Every grouped cost aggregate below carries this
 *  alongside its `SUM(cost_usd)` (§2.3): a group whose usage is entirely
 *  unpriced returns `costUsd: null` with a nonzero `unpricedTokens`, and a
 *  group that mixes priced and unpriced usage returns the PARTIAL priced sum
 *  plus the unpriced remainder as a separate, visible number -- never a
 *  partial sum silently presented as the whole truth. */
const UNPRICED_TOKEN_SUM = `SUM(CASE WHEN cost_usd IS NULL THEN ${TOKEN_SUM} ELSE 0 END)`;

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

/** `liveSubagents`' fallback for an agent_id not yet in `subagents` or
 *  `workflow_agents`: every Task/workflow-agent hook event carries its own
 *  `agent_type` in the raw payload, so this is read straight from it instead
 *  of leaving the row labelless until the next discovery sweep. Never throws
 *  on a null/unparseable payload. */
function agentTypeFromPayload(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { agent_type?: unknown };
    return typeof p.agent_type === "string" ? p.agent_type : null;
  } catch {
    return null;
  }
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
  /** §3: the manifest's own `defaultModel` / `totalToolCalls` -- display only. */
  default_model?: string | null;
  total_tool_calls?: number | null;
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
  /** §3: manifest per-agent `error`/`lastAttemptReason` (already merged by the
   *  caller) and `fallbackModel` -- both display only. */
  error?: string | null;
  fallback_model?: string | null;
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
  /** null when every usage row for this agent is unpriced (§2.3) -- see
   *  `unpricedTokens`, never a fabricated $0.00. */
  costUsd: number | null;
  unpricedTokens: number;
  /** §3: the manifest's per-agent `error`/`lastAttemptReason`. */
  error: string | null;
  fallback_model: string | null;
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
  /** §3: display only, from the manifest's own `defaultModel`/`totalToolCalls`. */
  default_model: string | null;
  total_tool_calls: number | null;
  /** null only when the run has usage rows and every one of them is unpriced;
   *  0 with no usage rows at all (§2.3). See `unpricedTokens`. */
  costUsd: number | null;
  tokens: number;
  unpricedTokens: number;
  agents: WorkflowAgentView[];
}

/** §3: per-agent `state` counts for one run, rolled up from `workflow_agents`
 *  with the SAME read-time killed-normalisation `hydrateWorkflowRuns` applies
 *  to the full agent view (a `progress`/`running` agent left behind by a
 *  settled `killed`/`failed` run reads as killed here too) -- the list
 *  endpoint just does it via a cheap join instead of hydrating every agent
 *  row. `killed` is not one of the spec's named buckets, but is needed so
 *  `total` always equals the sum of every bucket. */
export interface AgentCounts {
  total: number;
  done: number;
  error: number;
  running: number;
  abandoned: number;
  killed: number;
}

/** §3: everything `WorkflowRun` carries except the per-agent array, for the
 *  `/api/workflows` list -- swaps the (expensive, per-agent) `agents` for a
 *  cheap `agent_counts` rollup so listing many runs never pays for per-agent
 *  hydration + usage joins the list view never renders. */
export type WorkflowRunSummary = Omit<WorkflowRun, "agents"> & { agent_counts: AgentCounts };

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
  costUsd: number | null;
  tokens: number;
  unpricedTokens: number;
  agents: WorkflowAgentView[];
}

/** §5.1: one live subagent (a Task subagent or a workflow agent) active in
 *  the last 2 minutes, for a session row's "N agents" chip. */
export interface SubagentView {
  agent_id: string;
  session_id: string;
  kind: "task" | "workflow";
  label: string | null;
  agent_type: string | null;
  model: string | null;
  last_tool: string | null;
  last_at: number;
}

/** §3: the board's "last run" line for when nothing is live. */
export interface LastSettledRun {
  run_id: string;
  name: string | null;
  status: string | null;
  ended_at: number | null;
  costUsd: number | null;
}

export class Store {
  constructor(public db: Database) {}

  // --- cost-aggregate caching (§1.3) --------------------------------------
  // Bumped by every write to `usage` (recordUsage today; the future generic
  // reprice/dedupe migrations in §2.2/§2.3 must bump it too). All-time cost
  // aggregates memoize on this counter so a burst of hook traffic that writes
  // no new usage (the common case) recomputes nothing on repeat buildState()
  // calls. In-memory only - a restart naturally invalidates everything.
  private usageVersion = 0;
  private perSessionCostCache: {
    version: number;
    value: Record<string, { costUsd: number | null; tokens: number; unpricedTokens: number }>;
  } | null = null;
  private todayCostCache: {
    version: number;
    midnight: number;
    value: { todayUsd: number | null; byModelToday: { model: string; costUsd: number | null }[] };
  } | null = null;
  private costByProjectCache: {
    version: number;
    rows: { project: string; costUsd: number | null; tokens: number; unpricedTokens: number }[];
  } | null = null;
  /** Insights payload cache (§7 of the Insights spec). Keyed on a string
   *  combining `usageVersion` with the workflow-runs fingerprint (count +
   *  MAX(last_seen_at), a sub-millisecond query) -- either changing means new
   *  data exists. `localDayKey` is tracked separately because a day rollover
   *  must recompute unconditionally, bypassing the 60s floor below.
   *  `computedAtMs` anchors that floor: within 60s of the last real compute, a
   *  changed key is served as the SAME cached object with `meta.stale = true`
   *  rather than recomputed, so a burst of agent traffic can only trigger the
   *  ~150ms computation about once a minute (per viewer of the page). */
  private insightsCache: {
    key: string;
    localDayKey: string;
    computedAtMs: number;
    value: InsightsResponse;
  } | null = null;
  private costByBranchCache: {
    version: number;
    rows: { project: string; branch: string | null; costUsd: number | null; tokens: number; unpricedTokens: number }[];
  } | null = null;
  private unpricedCache: {
    version: number;
    value: { unpricedTokens: number; unpricedModels: { model: string; tokens: number }[] };
  } | null = null;

  applyEvent(sessionId: string, patch: SessionPatch, now: number): Session {
    const existing = this.getSession(sessionId);
    if (!existing) {
      this.db
        .query(
          `INSERT INTO sessions (id, project, cwd, transcript_path, status, current_task, current_intent, attention_reason, active_tool, branch, idle_reason, harness, model, title, parent_session_id, harness_version, started_at, last_activity_at, ended_at)
           VALUES ($id, $project, $cwd, $transcript_path, $status, $current_task, $current_intent, $attention_reason, $active_tool, $branch, $idle_reason, $harness, $model, $title, $parent_session_id, $harness_version, $started_at, $last_activity_at, $ended_at)`
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
          $idle_reason: patch.idle_reason ?? null,
          $harness: patch.harness ?? "claude",
          $model: patch.model ?? null,
          $title: patch.title ?? null,
          $parent_session_id: patch.parent_session_id ?? null,
          $harness_version: patch.harness_version ?? null,
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
      "idle_reason",
      "harness",
      "model",
      "title",
      "harness_version",
      "last_activity_at",
      "ended_at",
    ] as const) {
      if (key in patch) {
        fields.push(`${key} = $${key}`);
        params[`$${key}`] = (patch as Record<string, unknown>)[key] ?? null;
      }
    }
    // §4.2: parent is set once and never overwritten - a plain overwrite (like
    // every other field above) would let a later event with a different or
    // absent parent guess clobber the first one this session ever recorded.
    if ("parent_session_id" in patch) {
      fields.push("parent_session_id = COALESCE(parent_session_id, $parent_session_id)");
      params.$parent_session_id = patch.parent_session_id ?? null;
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

  /** Insert one raw event row plus, for `activity` rows with a known tool, the
   *  matching `tool_stats` upsert -- in the SAME transaction, so the running
   *  aggregate can never drift from the events it was built from (§1.2).
   *  Columns are pre-extracted and the payload pre-compacted by the caller
   *  (`payload.ts`); this method only owns the write. */
  recordEvent(e: {
    sessionId: string;
    type: string;
    payload: string;
    at: number;
    toolName: string | null;
    durationMs: number | null;
    agentId: string | null;
    harness: string;
    /** §3: live workflow-agent motion. Omit for callers that never carry a
     *  tool summary (harmless -- the workflow_agents update simply no-ops for
     *  `agentId`s that never got a summary, same as a null tool name). */
    toolSummary?: string | null;
  }): void {
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO events (session_id, type, payload, at, tool_name, duration_ms, agent_id, harness)
           VALUES ($s, $t, $p, $a, $tool, $dur, $agent, $harness)`
        )
        .run({
          $s: e.sessionId,
          $t: e.type,
          $p: e.payload,
          $a: e.at,
          $tool: e.toolName,
          $dur: e.durationMs,
          $agent: e.agentId,
          $harness: e.harness,
        });
      if (e.type === "activity" && e.toolName) {
        this.db
          .query(
            `INSERT INTO tool_stats (harness, tool, calls, timed, total_ms)
             VALUES ($h, $tool, 1, $timed, $ms)
             ON CONFLICT(harness, tool) DO UPDATE SET
               calls = calls + 1,
               timed = timed + $timed,
               total_ms = total_ms + $ms`
          )
          .run({ $h: e.harness, $tool: e.toolName, $timed: e.durationMs != null ? 1 : 0, $ms: e.durationMs ?? 0 });
      }
      // §3: live agent activity. A hook event carrying `agent_id` for an
      // already-known workflow agent updates its `last_tool`/
      // `last_tool_summary`/`tool_calls`/`started_at` so a live card shows
      // real motion before the manifest lands -- matched by agent_id alone
      // (workflow_agents' PK is (run_id, agent_id), but ids are content
      // hashes and `recentActivity`'s own join already matches this way).
      // A no-op (0 rows affected) for any agent_id that isn't a workflow
      // agent yet (a Task subagent, or one the 5s scan hasn't discovered).
      if (e.type === "activity" && e.agentId) {
        this.db
          .query(
            `UPDATE workflow_agents
             SET last_tool = $tool,
                 last_tool_summary = $summary,
                 tool_calls = COALESCE(tool_calls, 0) + 1,
                 started_at = COALESCE(started_at, $at)
             WHERE agent_id = $agent`
          )
          .run({ $tool: e.toolName, $summary: e.toolSummary ?? null, $at: e.at, $agent: e.agentId });
      }
    })();
  }

  /** Delete `events` rows older than `cutoff` (all types) - the hourly
   *  retention sweep (§1.4). `tool_stats` is a separate accumulating table,
   *  so historical tool-usage totals survive the prune. Returns rows deleted. */
  pruneOldEvents(cutoff: number): number {
    return this.db.query(`DELETE FROM events WHERE at < $cutoff`).run({ $cutoff: cutoff }).changes;
  }

  /** Most recent tool-call activity across all sessions, newest first. Reads
   *  `tool_name`/`duration_ms`/`agent_id`/`harness` straight from their
   *  columns (§1.2) - payload is parsed only for the one-line detail summary,
   *  and a row whose payload fails to parse still appears (detail stays
   *  null; the tool itself came from the column, not the payload). When
   *  `agent_id` matches a known workflow agent, its label is attached too;
   *  Task-subagent labels land with the `subagents` table (§2.4). §4.1: also
   *  carries `session_label` (the owning session's project plus a short
   *  intent) so the Live Activity feed can read `<harness> <session label> ·
   *  <agent label>` (§5.2) without a second round trip per row. */
  recentActivity(limit: number): {
    id: number;
    session_id: string;
    tool: string;
    detail: string | null;
    dur: number | null;
    at: number;
    agent_id: string | null;
    harness: string;
    label: string | null;
    session_label: string;
  }[] {
    const rows = this.db
      .query(
        `SELECT e.id, e.session_id, e.payload, e.at, e.tool_name, e.duration_ms, e.agent_id, e.harness,
                wa.label AS agent_label, s.project AS session_project, s.current_intent AS session_intent
         FROM events e
         LEFT JOIN workflow_agents wa ON wa.agent_id = e.agent_id
         LEFT JOIN sessions s ON s.id = e.session_id
         WHERE e.type = 'activity'
         ORDER BY e.id DESC LIMIT $limit`
      )
      .all({ $limit: limit }) as {
      id: number;
      session_id: string;
      payload: string | null;
      at: number;
      tool_name: string | null;
      duration_ms: number | null;
      agent_id: string | null;
      harness: string | null;
      agent_label: string | null;
      session_project: string | null;
      session_intent: string | null;
    }[];
    const out: {
      id: number;
      session_id: string;
      tool: string;
      detail: string | null;
      dur: number | null;
      at: number;
      agent_id: string | null;
      harness: string;
      label: string | null;
      session_label: string;
    }[] = [];
    for (const r of rows) {
      if (!r.tool_name) continue; // matches historic behaviour: an untagged row is excluded
      let detail: string | null = null;
      try {
        if (r.payload) {
          const p = JSON.parse(r.payload) as { tool_input?: unknown };
          detail = summarizeTool(r.tool_name, p.tool_input);
        }
      } catch {
        // payload failed to parse -- the row still appears (tool from the column); no detail.
      }
      const project = r.session_project ?? "unknown";
      // §5.2 spec-gap fix: `session_label` feeds Live Activity's "project plus a
      // SHORT intent" - the spec names no length, but 60 chars (this table's
      // general-purpose MAX_INTENT_LEN) plus a project name routinely landed
      // around 80 chars in practice, nowhere close to "short" for a sidebar
      // row. 24 chars is enough to identify the intent at a glance without
      // dominating the row.
      const sessionLabel = r.session_intent ? `${project} - ${truncate(r.session_intent, 24)}` : project;
      out.push({
        id: r.id,
        session_id: r.session_id,
        tool: r.tool_name,
        detail,
        dur: r.duration_ms,
        at: r.at,
        agent_id: r.agent_id,
        harness: r.harness ?? "claude",
        label: r.agent_label,
        session_label: sessionLabel,
      });
    }
    return out;
  }

  /** §5.1: agents (Task subagents or workflow agents) with a hook event in the
   *  last `windowMs` (default 2 minutes), grouped by session, for a session
   *  row's "N agents" chip. `tool_name`/`MAX(at)` come from the SAME row for
   *  each group via SQLite's documented "bare column follows the min/max"
   *  behaviour (exactly one MAX() in this query) - no second query needed for
   *  the group's own latest tool. `payload` rides along the same bare-column
   *  trick, so an agent seen by neither `subagents` nor `workflow_agents` yet
   *  (freshly spawned since the last discovery sweep, or any Codex sub-agent,
   *  which is never discovered into either table) still gets its own
   *  `agent_type` from its latest hook event instead of showing up labelless.
   *  Reads `idx_events_agent_at` (a partial index over just the agent-tagged
   *  rows) so this stays a cheap range scan over the last `windowMs`
   *  regardless of total event-table size, rather than the full-table SCAN a
   *  plain `agent_id IS NOT NULL` predicate would otherwise fall back to. */
  liveSubagents(now: number, windowMs: number = 2 * 60 * 1000): Map<string, SubagentView[]> {
    const cutoff = now - windowMs;
    const rows = this.db
      .query(
        `SELECT session_id, agent_id, tool_name AS last_tool, payload AS last_payload, MAX(at) AS last_at
         FROM events WHERE agent_id IS NOT NULL AND at >= $cutoff
         GROUP BY session_id, agent_id`
      )
      .all({ $cutoff: cutoff }) as {
      session_id: string;
      agent_id: string;
      last_tool: string | null;
      last_payload: string | null;
      last_at: number;
    }[];
    const out = new Map<string, SubagentView[]>();
    if (rows.length === 0) return out;

    const ids = [...new Set(rows.map((r) => r.agent_id))];
    const ph = ids.map((_, i) => `$a${i}`).join(", ");
    const params: Record<string, string> = {};
    ids.forEach((id, i) => (params[`$a${i}`] = id));

    const subagentRows = this.db
      .query(`SELECT agent_id, agent_type, description, model FROM subagents WHERE agent_id IN (${ph})`)
      .all(params) as { agent_id: string; agent_type: string | null; description: string | null; model: string | null }[];
    const subagentById = new Map(subagentRows.map((r) => [r.agent_id, r]));

    const wfRows = this.db
      .query(`SELECT agent_id, label, model FROM workflow_agents WHERE agent_id IN (${ph})`)
      .all(params) as { agent_id: string; label: string | null; model: string | null }[];
    const wfById = new Map(wfRows.map((r) => [r.agent_id, r]));

    for (const r of rows) {
      const wf = wfById.get(r.agent_id);
      const sub = subagentById.get(r.agent_id);
      const kind: "task" | "workflow" = wf ? "workflow" : "task";
      // Neither table has this agent_id yet -- read `agent_type` straight off
      // its own latest hook payload (every Task/workflow-agent event carries
      // it) rather than showing up labelless until the next discovery sweep.
      const agentType = sub ? sub.agent_type : agentTypeFromPayload(r.last_payload);
      const view: SubagentView = {
        agent_id: r.agent_id,
        session_id: r.session_id,
        kind,
        label: wf?.label ?? sub?.description ?? agentType ?? null,
        agent_type: agentType,
        model: wf?.model ?? sub?.model ?? null,
        last_tool: r.last_tool,
        last_at: r.last_at,
      };
      const list = out.get(r.session_id) ?? [];
      list.push(view);
      out.set(r.session_id, list);
    }
    return out;
  }

  /** Per-tool usage, busiest first, summed across harnesses plus a
   *  per-harness breakdown -- read straight from the incrementally-maintained
   *  `tool_stats` table (§1.2), so this is an O(distinct tools) GROUP BY over
   *  a tiny table instead of a full scan of `events`. Wrapped in try/catch so
   *  stats can never break the rest of /api/state. */
  toolStats(): {
    tool: string;
    calls: number;
    totalMs: number;
    avgMs: number | null;
    byHarness: { harness: string; calls: number; totalMs: number; avgMs: number | null }[];
  }[] {
    try {
      const rows = this.db
        .query(
          `SELECT tool, harness, calls, timed, total_ms
           FROM tool_stats
           ORDER BY tool`
        )
        .all() as { tool: string; harness: string; calls: number; timed: number; total_ms: number }[];
      const byTool = new Map<
        string,
        { calls: number; timed: number; totalMs: number; byHarness: { harness: string; calls: number; totalMs: number; avgMs: number | null }[] }
      >();
      for (const r of rows) {
        const entry = byTool.get(r.tool) ?? { calls: 0, timed: 0, totalMs: 0, byHarness: [] };
        entry.calls += r.calls;
        entry.timed += r.timed;
        entry.totalMs += r.total_ms;
        entry.byHarness.push({
          harness: r.harness,
          calls: r.calls,
          totalMs: r.total_ms,
          avgMs: r.timed > 0 ? Math.round(r.total_ms / r.timed) : null,
        });
        byTool.set(r.tool, entry);
      }
      return [...byTool.entries()]
        .map(([tool, e]) => ({
          tool,
          calls: e.calls,
          totalMs: e.totalMs,
          avgMs: e.timed > 0 ? Math.round(e.totalMs / e.timed) : null,
          byHarness: e.byHarness,
        }))
        .sort((a, b) => b.calls - a.calls);
    } catch {
      return [];
    }
  }

  /** Two-tier staleness sweep. Returns ids whose status changed.
   *  - A *working* session quiet for `staleMs` is marked `idle` (`idle_reason:
   *    "quiet"`), still on the board.
   *  - A non-ended, non-`needs_you` session silent for the longer `deadMs` is
   *    retired to `ended` (hidden from the board) - a session emits no events
   *    while waiting, so this prolonged silence is the only signal that a
   *    terminal was closed or crashed.
   *  - `needs_you` sessions are exempt from `deadMs`: a human hasn't looked
   *    yet, so the routine dead sweep must not hide the request before anyone
   *    sees it. They only retire after `needsYouDeadMs` (§1.6). */
  sweepStale(now: number, staleMs: number, deadMs: number, needsYouDeadMs: number): string[] {
    const affected: string[] = [];

    // Retire long-silent sessions first so a working session past `deadMs` goes
    // straight to ended rather than being relabeled idle below.
    const dead = this.db
      .query(
        `SELECT id FROM sessions WHERE status NOT IN ('ended', 'needs_you') AND last_activity_at < $cutoff
         UNION
         SELECT id FROM sessions WHERE status = 'needs_you' AND last_activity_at < $nyCutoff`
      )
      .all({ $cutoff: now - deadMs, $nyCutoff: now - needsYouDeadMs }) as { id: string }[];
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
      this.db.query(`UPDATE sessions SET status = 'idle', idle_reason = 'quiet' WHERE id = $id`).run({ $id: id });
      affected.push(id);
    }

    return affected;
  }

  /** Insert one priced usage row, or -- when `messageKey` is given and already
   *  belongs to another row -- merge into that row instead (§2.2). Claude Code
   *  writes one JSONL line per content block (thinking/text/tool_use) and
   *  repeats `message.usage` on every one of them, with a FRESH `message_uuid`
   *  each time; a plain per-uuid INSERT OR IGNORE therefore stores one priced
   *  row per line instead of per API message. `message_key` (`message.id +
   *  ":" + requestId`) ties those lines back together.
   *
   *  A merge keeps the FIRST row's `message_uuid`, `at`, and attribution
   *  (session/project/branch/run/agent) untouched, and only replaces
   *  `output_tokens`/`cost_usd` -- and only when the incoming line reports a
   *  STRICTLY larger `output_tokens` (real data: input/cache fields are
   *  identical across a message's lines, output starts as a partial streaming
   *  count and grows to the final total, so the largest-output line is always
   *  the correct final one, cost included). The `WHERE` clause on the upsert's
   *  `DO UPDATE` is load-bearing, not cosmetic: without it, a later line that
   *  repeats the SAME (already-maximal) output would still count as a SQLite
   *  "change" on every re-observation, spuriously bumping `usageVersion` and
   *  defeating §1.3's memoization on exactly the hot path this exists for.
   *  Lines with no `message.id` (messageKey null) skip this entirely and keep
   *  the old per-uuid-only dedup -- two NULLs never conflict on the partial
   *  unique index. */
  recordUsage(u: {
    uuid: string;
    sessionId: string;
    model: string;
    tokens: Tokens;
    at: number;
    cost: number | null;
    runId?: string;
    agentId?: string;
    messageKey?: string | null;
    /** §4.1: which harness produced this usage row. Omitted (undefined) keeps
     *  the column NULL, the same "NULL means claude" convention pre-existing
     *  rows already use - callers that know their harness (every §4.4/§4.3
     *  caller added in this workstream) should always pass it explicitly. */
    harness?: string;
  }): boolean {
    // Stamp the session's then-current project/branch so historical cost can be
    // attributed without a join (and survives the session row being mutated later).
    // Idempotent via the message_uuid key: the stamp is captured at first ingestion.
    const res = this.db
      .query(
        `INSERT INTO usage
           (message_uuid, message_key, session_id, model, input_tokens, output_tokens,
            cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens, cost_usd, project, branch, at,
            run_id, agent_id, harness)
         VALUES ($u, $key, $s, $m, $in, $out, $cr, $c5, $c1, $cost,
                 (SELECT project FROM sessions WHERE id = $s),
                 (SELECT branch FROM sessions WHERE id = $s), $at,
                 $run, $agent, $harness)
         ON CONFLICT(message_uuid) DO NOTHING
         ON CONFLICT(message_key) WHERE message_key IS NOT NULL DO UPDATE SET
           output_tokens = excluded.output_tokens,
           cost_usd = excluded.cost_usd
         WHERE excluded.output_tokens > usage.output_tokens`
      )
      .run({
        $u: u.uuid,
        $key: u.messageKey ?? null,
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
        $harness: u.harness ?? null,
      });
    const inserted = res.changes > 0;
    // A no-op (DO NOTHING on a dupe uuid, or a merge that changed nothing new)
    // changes nothing usage-derived, so it must not invalidate the cost caches
    // -- that would defeat §1.3 on exactly the hot path (repeated tailing of an
    // already-recorded message).
    if (inserted) this.usageVersion++;
    // Claude sends `model` only on SessionStart, so a session already running
    // when the server starts would never get one. The main agent's own usage
    // (no agent/run id) is the authoritative running model.
    if (inserted && !u.agentId && !u.runId) {
      this.db
        .query(`UPDATE sessions SET model = $m WHERE id = $s AND model IS NOT $m`)
        .run({ $m: u.model, $s: u.sessionId });
    }
    return inserted;
  }

  /** Bump the usage-cache generation without writing a `usage` row. Any code
   *  path that mutates `usage` OUTSIDE of `recordUsage` (today: reprice.ts's
   *  delete-and-re-tail; the future §2.2 dedupe and §2.3 generic-reprice
   *  migrations) must call this, or the memoized cost aggregates in §1.3
   *  (perSessionCost/todayCost/costByProject/costByBranch) can keep serving a
   *  value computed before that write. `usageVersion` is private for exactly
   *  this reason -- every writer goes through a method that knows to bump it. */
  bumpUsageVersion(): void {
    this.usageVersion++;
  }

  setUsageOffset(id: string, offset: number): void {
    this.db.query(`UPDATE sessions SET usage_offset = $o WHERE id = $id`).run({ $o: offset, $id: id });
  }

  getTailInfo(id: string): { transcript_path: string | null; usage_offset: number; harness: string; model: string | null } | null {
    const row = this.db
      .query(`SELECT transcript_path, usage_offset, harness, model FROM sessions WHERE id = $id`)
      .get({ $id: id });
    return (row as { transcript_path: string | null; usage_offset: number; harness: string; model: string | null }) ?? null;
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

  sessionsToTail(): { id: string; transcript_path: string | null; usage_offset: number; harness: string; model: string | null }[] {
    return this.db
      .query(
        `SELECT id, transcript_path, usage_offset, harness, model FROM sessions
         WHERE status != 'ended' AND transcript_path IS NOT NULL`
      )
      .all() as { id: string; transcript_path: string | null; usage_offset: number; harness: string; model: string | null }[];
  }

  /** Lifetime cost + tokens per session. Memoized on `usageVersion` (§1.3):
   *  this is a full-table GROUP BY, and `costSummary()` calls it on every
   *  `buildState()`. Carries `unpricedTokens` alongside `costUsd`/`tokens`,
   *  same as every other grouped cost aggregate (§2.3, `UNPRICED_TOKEN_SUM`):
   *  the session row's cost cell (§5.1) needs it to tell "fully priced" from
   *  "some usage from unpriced models" (`$x.xx+`) instead of collapsing both
   *  into the same plain dollar figure. */
  private perSessionCost(): Record<string, { costUsd: number | null; tokens: number; unpricedTokens: number }> {
    if (this.perSessionCostCache?.version === this.usageVersion) return this.perSessionCostCache.value;
    const per = this.db
      .query(
        `SELECT session_id, SUM(cost_usd) AS cost, SUM${TOKEN_SUM} AS tokens, ${UNPRICED_TOKEN_SUM} AS unpriced
         FROM usage GROUP BY session_id`
      )
      .all() as { session_id: string; cost: number | null; tokens: number; unpriced: number }[];
    const value: Record<string, { costUsd: number | null; tokens: number; unpricedTokens: number }> = {};
    for (const r of per) value[r.session_id] = { costUsd: r.cost, tokens: r.tokens, unpricedTokens: r.unpriced };
    this.perSessionCostCache = { version: this.usageVersion, value };
    return value;
  }

  /** Today's total + per-model breakdown. Memoized on `(usageVersion,
   *  midnightMs)` (§1.3) - the day boundary is part of the cache key so a
   *  fresh calendar day recomputes exactly once, on its first call.
   *
   *  `todayUsd` is NOT coalesced to 0 (§2.3, finding): `SUM(cost_usd)` already
   *  returns NULL when every row seen today is unpriced, and forcing that to a
   *  fabricated $0.00 is exactly the thing goal 2 forbids. A caller wanting a
   *  never-null display value combines this with `unpricedTokens` below to
   *  show the truth ("$4.12 + 900 unpriced tokens") instead of a wrong total. */
  private todayCost(midnightMs: number): { todayUsd: number | null; byModelToday: { model: string; costUsd: number | null }[] } {
    if (this.todayCostCache?.version === this.usageVersion && this.todayCostCache.midnight === midnightMs) {
      return this.todayCostCache.value;
    }
    const today = this.db
      .query(`SELECT SUM(cost_usd) AS c FROM usage WHERE at >= $m`)
      .get({ $m: midnightMs }) as { c: number | null };
    // §2.3: no HAVING here any more -- a model with only unpriced usage today
    // must still appear (with `costUsd: null`, from SUM over an all-NULL
    // group), not silently vanish the way a `HAVING c > 0` filter would.
    const byModel = this.db
      .query(`SELECT model, SUM(cost_usd) AS c FROM usage WHERE at >= $m GROUP BY model ORDER BY c DESC`)
      .all({ $m: midnightMs }) as { model: string; c: number | null }[];
    const value = { todayUsd: today.c, byModelToday: byModel.map((r) => ({ model: r.model, costUsd: r.c })) };
    this.todayCostCache = { version: this.usageVersion, midnight: midnightMs, value };
    return value;
  }

  /** All-time unpriced usage (§2.3): the token total, and a per-model
   *  breakdown, of every row whose `cost_usd` is NULL -- an unknown model that
   *  slipped past `costOf`, or a row awaiting the next generic reprice pass.
   *  Memoized on `usageVersion` like the other all-time aggregates. */
  private unpricedUsage(): { unpricedTokens: number; unpricedModels: { model: string; tokens: number }[] } {
    if (this.unpricedCache?.version === this.usageVersion) return this.unpricedCache.value;
    const rows = this.db
      .query(`SELECT model, SUM${TOKEN_SUM} AS tokens FROM usage WHERE cost_usd IS NULL GROUP BY model ORDER BY tokens DESC`)
      .all() as { model: string; tokens: number }[];
    const value = {
      unpricedTokens: rows.reduce((sum, r) => sum + r.tokens, 0),
      unpricedModels: rows.map((r) => ({ model: r.model, tokens: r.tokens })),
    };
    this.unpricedCache = { version: this.usageVersion, value };
    return value;
  }

  costSummary(midnightMs: number): {
    perSession: Record<string, { costUsd: number | null; tokens: number; unpricedTokens: number }>;
    liveTotalUsd: number;
    todayUsd: number | null;
    byModelToday: { model: string; costUsd: number | null }[];
    unpricedTokens: number;
    unpricedModels: { model: string; tokens: number }[];
  } {
    const perSession = this.perSessionCost();
    const { todayUsd, byModelToday } = this.todayCost(midnightMs);
    const { unpricedTokens, unpricedModels } = this.unpricedUsage();

    // Deliberately NOT memoized: this depends on `sessions.status`, which
    // changes on its own (sweeps, stop/session_end) without any usage write
    // ever happening - caching it on usageVersion would let an ended
    // session's spend linger in "live" indefinitely.
    //
    // Written as `session_id IN (subquery)` rather than a JOIN so the query
    // planner drives off the small non-ended-sessions set and index-probes
    // into `usage` per id (idx_usage_session) instead of scanning the whole
    // usage table: on a 123k-row usage table this is the difference between
    // ~0.1ms and ~15ms (a JOIN's planner picks `SCAN usage` here because
    // nothing indexes `usage.session_id -> sessions.status`).
    const live = this.db
      .query(
        `SELECT COALESCE(SUM(cost_usd), 0) AS c FROM usage
         WHERE session_id IN (SELECT id FROM sessions WHERE status != 'ended')`
      )
      .get() as { c: number };

    return { perSession, liveTotalUsd: live.c, todayUsd, byModelToday, unpricedTokens, unpricedModels };
  }

  /** Lifetime (or ranged) cost + tokens grouped by project, highest spend first.
   *  Usage with no resolvable project (e.g. pre-attribution rows) buckets under
   *  'unknown'. `range` filters on the message timestamp (since inclusive, until
   *  exclusive); omit it for all-time. */
  costByProject(
    range: { since?: number; until?: number } = {}
  ): { project: string; costUsd: number | null; tokens: number; unpricedTokens: number }[] {
    // Only the unbounded (all-time) call is memoized (§1.3): it's the one
    // buildState() hits on every request, and the only shape whose cache key
    // (usageVersion alone) is exact. A ranged call is rare (cost-page drill-
    // downs, tests) and always computed fresh.
    const unranged = range.since === undefined && range.until === undefined;
    if (unranged && this.costByProjectCache?.version === this.usageVersion) return this.costByProjectCache.rows;
    const { where, params } = rangeClause(range);
    const rows = this.db
      .query(
        `SELECT COALESCE(usage.project, 'unknown') AS project, SUM(cost_usd) AS cost, SUM${TOKEN_SUM} AS tokens,
                ${UNPRICED_TOKEN_SUM} AS unpriced
         FROM usage ${where} GROUP BY usage.project ORDER BY cost DESC, usage.project`
      )
      .all(params) as { project: string; cost: number | null; tokens: number; unpriced: number }[];
    const result = rows.map((r) => ({ project: r.project, costUsd: r.cost, tokens: r.tokens, unpricedTokens: r.unpriced }));
    if (unranged) this.costByProjectCache = { version: this.usageVersion, rows: result };
    return result;
  }

  /** Lifetime (or ranged) cost + tokens grouped by (project, branch), highest
   *  spend first. Grouping by project too keeps same-named branches (e.g. `main`)
   *  from merging across repos; `branch` stays null when the session had none. */
  costByBranch(
    range: { since?: number; until?: number } = {}
  ): { project: string; branch: string | null; costUsd: number | null; tokens: number; unpricedTokens: number }[] {
    // See costByProject: only the unbounded call is cached (§1.3).
    const unranged = range.since === undefined && range.until === undefined;
    if (unranged && this.costByBranchCache?.version === this.usageVersion) return this.costByBranchCache.rows;
    const { where, params } = rangeClause(range);
    const rows = this.db
      .query(
        `SELECT COALESCE(usage.project, 'unknown') AS project, usage.branch AS branch,
                SUM(cost_usd) AS cost, SUM${TOKEN_SUM} AS tokens, ${UNPRICED_TOKEN_SUM} AS unpriced
         FROM usage ${where} GROUP BY usage.project, usage.branch ORDER BY cost DESC, usage.project, usage.branch`
      )
      .all(params) as { project: string; branch: string | null; cost: number | null; tokens: number; unpriced: number }[];
    const result = rows.map((r) => ({
      project: r.project,
      branch: r.branch,
      costUsd: r.cost,
      tokens: r.tokens,
      unpricedTokens: r.unpriced,
    }));
    if (unranged) this.costByBranchCache = { version: this.usageVersion, rows: result };
    return result;
  }

  /** Cost + tokens grouped by (project, branch, harness, local day "YYYY-MM-DD"),
   *  newest day first. `range` filters on the message timestamp (since
   *  inclusive, until exclusive); omit for all-time. `harness` filters to
   *  exactly that harness (§5.3's Cost-page harness filter); omit for every
   *  harness. Unattributed usage buckets under 'unknown'; branch stays null
   *  when absent; a NULL `usage.harness` (pre-B1 rows) reads as 'claude', the
   *  same convention every other harness-aware read uses. Client re-sorts as
   *  needed - this order is a stable baseline. */
  costDaily(
    range: { since?: number; until?: number; harness?: string } = {}
  ): {
    project: string;
    branch: string | null;
    day: string;
    harness: string;
    costUsd: number | null;
    tokens: number;
    unpricedTokens: number;
  }[] {
    const { where, params: rangeParams } = rangeClause(range);
    const params: Record<string, number | string> = { ...rangeParams };
    let sql = `SELECT COALESCE(usage.project, 'unknown') AS project, usage.branch AS branch,
                strftime('%Y-%m-%d', at / 1000, 'unixepoch', 'localtime') AS day,
                COALESCE(usage.harness, 'claude') AS harness,
                SUM(cost_usd) AS cost, SUM${TOKEN_SUM} AS tokens, ${UNPRICED_TOKEN_SUM} AS unpriced
         FROM usage ${where}`;
    if (range.harness) {
      sql += where ? " AND " : " WHERE ";
      sql += "COALESCE(usage.harness, 'claude') = $harness";
      params.$harness = range.harness;
    }
    // GROUP BY the COALESCE expression itself, not the bare `harness` alias:
    // SQLite resolves a GROUP BY identifier to an input column (usage.harness)
    // before it considers a result-set alias of the same name, so a bare
    // `harness` here would split a day's NULL-harness rows (pre-B1) and its
    // 'claude' rows into two groups that both DISPLAY as 'claude' -- verified
    // against a real SQLite database; see the regression test below.
    sql += " GROUP BY usage.project, usage.branch, day, COALESCE(usage.harness, 'claude') ORDER BY day DESC, cost DESC";
    const rows = this.db.query(sql).all(params) as {
      project: string;
      branch: string | null;
      day: string;
      harness: string;
      cost: number | null;
      tokens: number;
      unpriced: number;
    }[];
    return rows.map((r) => ({
      project: r.project,
      branch: r.branch,
      day: r.day,
      harness: r.harness,
      costUsd: r.cost,
      tokens: r.tokens,
      unpricedTokens: r.unpriced,
    }));
  }

  /** The `/api/insights` payload (Insights spec §7), memoized per the rules
   *  above: an unchanged key returns the SAME cached object (reference
   *  equality, so a caller can tell nothing changed); a key that changed
   *  within 60s of the last real compute returns the cached object with
   *  `meta.stale` flipped on instead of recomputing; a local day rollover
   *  always recomputes regardless of the floor. */
  insights(now: number = Date.now()): InsightsResponse {
    const dayKey = (() => {
      const d = new Date(now);
      const p2 = (n: number) => (n < 10 ? `0${n}` : String(n));
      return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    })();
    const wf = this.db.query(`SELECT COUNT(*) AS c, MAX(last_seen_at) AS m FROM workflow_runs`).get() as {
      c: number;
      m: number | null;
    };
    const key = `${this.usageVersion}|${wf.c}|${wf.m ?? 0}`;

    const cache = this.insightsCache;
    if (cache) {
      const sameDay = cache.localDayKey === dayKey;
      if (sameDay && cache.key === key) return cache.value;
      if (sameDay && now - cache.computedAtMs < 60_000) {
        if (!cache.value.meta.stale) {
          cache.value = { ...cache.value, meta: { ...cache.value.meta, stale: true } };
        }
        return cache.value;
      }
    }

    const t0 = performance.now();
    const value = computeInsights(this.db, now);
    value.meta.computeMs = performance.now() - t0;
    this.insightsCache = { key, localDayKey: dayKey, computedAtMs: now, value };
    return value;
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

  // --- Task subagents (§2.4, non-workflow) --------------------------------

  /** Register one newly-discovered `agent-<id>.jsonl` file. A no-op if the
   *  agent id is already known -- enrichment (tail offset, resolved model)
   *  happens through `setSubagentTail`, never here, so a later discovery pass
   *  can never rewind an already-advancing tail. */
  upsertSubagent(a: {
    agent_id: string;
    session_id: string;
    agent_type: string | null;
    description: string | null;
    model: string | null;
    parent_agent_id: string | null;
    path: string;
    started_at: number | null;
    last_seen_at: number | null;
  }): void {
    this.db
      .query(
        `INSERT INTO subagents
           (agent_id, session_id, agent_type, description, model, parent_agent_id, path, offset, started_at, last_seen_at)
         VALUES ($id, $sess, $type, $desc, $model, $parent, $path, 0, $started, $seen)
         ON CONFLICT(agent_id) DO NOTHING`
      )
      .run({
        $id: a.agent_id,
        $sess: a.session_id,
        $type: a.agent_type,
        $desc: a.description,
        $model: a.model,
        $parent: a.parent_agent_id,
        $path: a.path,
        $started: a.started_at,
        $seen: a.last_seen_at,
      });
  }

  /** Agent ids already known for a session, so the discovery pass can tell a
   *  brand-new `agent-*.jsonl` file from one it has already registered. */
  subagentIdsForSession(sessionId: string): Set<string> {
    const rows = this.db.query(`SELECT agent_id FROM subagents WHERE session_id = $s`).all({ $s: sessionId }) as {
      agent_id: string;
    }[];
    return new Set(rows.map((r) => r.agent_id));
  }

  subagentsForSession(
    sessionId: string
  ): { agent_id: string; path: string; offset: number; model: string | null; model_resolved: boolean }[] {
    const rows = this.db
      .query(`SELECT agent_id, path, offset, model, model_resolved FROM subagents WHERE session_id = $s`)
      .all({ $s: sessionId }) as { agent_id: string; path: string; offset: number; model: string | null; model_resolved: number }[];
    return rows.map((r) => ({ ...r, model_resolved: r.model_resolved === 1 }));
  }

  /** Persist a subagent's tail progress. `model`, when given, OVERWRITES the
   *  stored value and marks it resolved -- the resolved `message.model` from
   *  the transcript always wins over the meta file's alias (§2.4), and once
   *  resolved a later tail never reads the header again (`model_resolved`,
   *  not "was this the very first tail" -- a subagent's first API call can
   *  land outside the sweep window that first discovers its file, so the
   *  caller must be able to try resolving on ANY tail that records usage
   *  until it succeeds). Omit `model` (null) to leave the stored value and
   *  its resolved flag alone. */
  setSubagentTail(agentId: string, offset: number, lastSeenAt: number, model: string | null): void {
    this.db
      .query(
        `UPDATE subagents SET offset = $o, last_seen_at = $t, model = COALESCE($m, model),
           model_resolved = CASE WHEN $m IS NOT NULL THEN 1 ELSE model_resolved END
         WHERE agent_id = $id`
      )
      .run({ $o: offset, $t: lastSeenAt, $m: model, $id: agentId });
  }

  // --- workflows ---------------------------------------------------------

  /** Insert-or-enrich a run row. `project`/`branch` are stamped from the owning
   *  session at FIRST sight only (matching recordUsage's convention) and never
   *  re-stamped. Every other column takes the new value when it is non-null and
   *  keeps the stored one otherwise, so a tick that knows less (no manifest yet)
   *  cannot blank what an earlier tick learned.
   *
   *  `error` is the one exception to "non-null wins, else keep stored": it must
   *  be CLEARABLE (a manifest that used to fail JSON.parse, or used to carry
   *  its own `error`, can legitimately go back to null once fixed or rewritten
   *  in place), so a plain COALESCE would be wrong. But `r.error === undefined`
   *  (never `null`) means this pass has NO OPINION at all -- specifically a
   *  manifest-read error, which "leaves structure exactly as it was" (scanRun's
   *  own rule) and must not wipe a real error a previous, successful parse
   *  already stored. `$errset` carries that distinction into SQL, since a bound
   *  parameter can't otherwise tell "explicitly null" from "omitted". */
  upsertWorkflowRun(r: WorkflowRunUpsert): void {
    const errorGiven = r.error !== undefined;
    this.db
      .query(
        `INSERT INTO workflow_runs
           (run_id, session_id, project, branch, name, summary, status, error, started_at, ended_at,
            duration_ms, agent_count, phases, cc_version, manifest_seen, manifest_mtime, last_seen_at,
            dir, schema_ok, total_tokens_reported, default_model, total_tool_calls)
         VALUES ($run, $sess,
                 (SELECT project FROM sessions WHERE id = $sess),
                 (SELECT branch FROM sessions WHERE id = $sess),
                 $name, $summary, $status, $error, $started, $ended, $dur, $count, $phases, $ver,
                 $manifest, $mmtime, $seen, $dir, $ok, $reported, $defmodel, $ttc)
         ON CONFLICT(run_id) DO UPDATE SET
           name = COALESCE(excluded.name, workflow_runs.name),
           summary = COALESCE(excluded.summary, workflow_runs.summary),
           status = COALESCE(excluded.status, workflow_runs.status),
           error = CASE WHEN $errset = 1 THEN excluded.error ELSE workflow_runs.error END,
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
           total_tokens_reported = COALESCE(excluded.total_tokens_reported, workflow_runs.total_tokens_reported),
           default_model = COALESCE(excluded.default_model, workflow_runs.default_model),
           total_tool_calls = COALESCE(excluded.total_tool_calls, workflow_runs.total_tool_calls)`
      )
      .run({
        $run: r.run_id,
        $sess: r.session_id,
        $name: r.name ?? null,
        $summary: r.summary ?? null,
        $status: r.status ?? null,
        $error: r.error === undefined ? null : r.error, // ignored by the CASE above when $errset = 0
        $errset: errorGiven ? 1 : 0,
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
        $defmodel: r.default_model ?? null,
        $ttc: r.total_tool_calls ?? null,
      });
  }

  /** §3: record that `cause` degraded `run`'s data, once, surviving restarts
   *  (see `bumpRunDegraded` in workflows.ts for the full rationale). Upserts
   *  the row from just `run_id`/`session_id`/`dir` when it doesn't exist yet
   *  -- the fuller `upsertWorkflowRun` call later in the same scan pass then
   *  hits the `ON CONFLICT` branch, which never touches `degraded`. Stamps
   *  `project`/`branch` from the owning session here too, with the SAME
   *  subquery `upsertWorkflowRun`'s own INSERT uses: that method's `ON
   *  CONFLICT` branch never sets those columns (by design -- they're stamped
   *  at first sight only, §1.5/C3's convention), so if THIS insert is the one
   *  that actually creates the row, it must stamp them itself or a run whose
   *  first-ever write is a degraded cause would carry NULL project/branch
   *  forever. Returns true only when `cause` was newly recorded. */
  recordRunDegraded(run: { run_id: string; session_id: string; dir: string }, cause: string, at: number): boolean {
    this.db
      .query(
        `INSERT INTO workflow_runs (run_id, session_id, project, branch, dir)
         VALUES ($run, $sess, (SELECT project FROM sessions WHERE id = $sess), (SELECT branch FROM sessions WHERE id = $sess), $dir)
         ON CONFLICT(run_id) DO NOTHING`
      )
      .run({ $run: run.run_id, $sess: run.session_id, $dir: run.dir });
    const row = this.db.query(`SELECT degraded FROM workflow_runs WHERE run_id = $run`).get({ $run: run.run_id }) as
      | { degraded: string | null }
      | undefined;
    let causes: Record<string, number> = {};
    if (row?.degraded) {
      try {
        causes = JSON.parse(row.degraded);
      } catch {
        causes = {};
      }
    }
    if (causes[cause] != null) return false; // already recorded -- a restart must not re-bump
    causes[cause] = at;
    this.db
      .query(`UPDATE workflow_runs SET degraded = $d WHERE run_id = $run`)
      .run({ $d: JSON.stringify(causes), $run: run.run_id });
    return true;
  }

  /** §3: the banner's counter -- the number of runs with at least one degraded
   *  cause first recorded within the last `windowMs` (default 24h). A cause's
   *  timestamp never moves once recorded, so a run simply ages out of the
   *  count as its causes get older; nothing is ever deleted. */
  degradedRunCount(now: number, windowMs: number = 24 * 60 * 60 * 1000): number {
    const rows = this.db.query(`SELECT degraded FROM workflow_runs WHERE degraded IS NOT NULL`).all() as {
      degraded: string;
    }[];
    const cutoff = now - windowMs;
    let n = 0;
    for (const r of rows) {
      try {
        const causes = JSON.parse(r.degraded) as Record<string, number>;
        if (Object.values(causes).some((t) => t >= cutoff)) n++;
      } catch {
        // A malformed value can't tell us anything; skip rather than crash.
      }
    }
    return n;
  }

  /** §5.2: the single most-recently-degraded run within `windowMs` (default
   *  24h), for the board banner's "names the most recent run" requirement --
   *  `degradedRunCount` above is just the count. Ranked by each run's OWN most
   *  recent cause timestamp, not insertion order, so a run degraded again
   *  after another run's more recent (but since-aged) cause still wins. */
  mostRecentDegradedRun(now: number, windowMs: number = 24 * 60 * 60 * 1000): { run_id: string; name: string | null } | null {
    const rows = this.db.query(`SELECT run_id, name, degraded FROM workflow_runs WHERE degraded IS NOT NULL`).all() as {
      run_id: string;
      name: string | null;
      degraded: string;
    }[];
    const cutoff = now - windowMs;
    let best: { run_id: string; name: string | null; at: number } | null = null;
    for (const r of rows) {
      try {
        const causes = JSON.parse(r.degraded) as Record<string, number>;
        const latest = Math.max(...Object.values(causes));
        if (latest >= cutoff && (!best || latest > best.at)) best = { run_id: r.run_id, name: r.name, at: latest };
      } catch {
        // A malformed value can't tell us anything; skip rather than crash (matches degradedRunCount).
      }
    }
    return best ? { run_id: best.run_id, name: best.name } : null;
  }

  /** Insert-or-enrich an agent row. `offset` is deliberately absent from this
   *  method - it is owned by setWorkflowAgentOffset so enrichment can never
   *  rewind the tail position. */
  upsertWorkflowAgent(a: WorkflowAgentUpsert): void {
    this.db
      .query(
        `INSERT INTO workflow_agents
           (run_id, agent_id, label, phase_index, phase_title, idx, model, state, attempt, journal_key,
            last_tool, last_tool_summary, prompt_preview, started_at, ended_at, duration_ms, tool_calls, offset,
            error, fallback_model)
         VALUES ($run, $agent, $label, $pidx, $ptitle, $idx, $model, $state, $attempt, $key,
                 $tool, $tsum, $prompt, $started, $ended, $dur, $calls, 0, $error, $fallback)
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
           tool_calls = COALESCE(excluded.tool_calls, workflow_agents.tool_calls),
           error = COALESCE(excluded.error, workflow_agents.error),
           fallback_model = COALESCE(excluded.fallback_model, workflow_agents.fallback_model)`
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
        $error: a.error ?? null,
        $fallback: a.fallback_model ?? null,
      });
  }

  /** §3: stored model per agent for a run, for the transcript-header re-read
   *  gate (needs to know if the value ON DISK is a bare alias) -- kept
   *  separate from `workflowAgentOffsets` so that method's exact `.toEqual`
   *  shape (tested directly) never has to change. */
  workflowAgentModels(runId: string): { agent_id: string; model: string | null }[] {
    return this.db
      .query(`SELECT agent_id, model FROM workflow_agents WHERE run_id = $run`)
      .all({ $run: runId }) as { agent_id: string; model: string | null }[];
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

  /** Runs worth touching this tick: anything whose dir moved after `cutoff`
   *  (= now - WF_RECHECK_MS). Beyond that window a run is final, which bounds
   *  the re-stat cost regardless of how much history accumulates. A purged
   *  owning session reads as 'ended' so deriveRunState calls it orphaned.
   *
   *  Deliberately excludes `last_seen_at IS NULL` rows: `upsertWorkflowRun`
   *  always writes a real `lastSeenAt`, so the only way a row can have a NULL
   *  one is `recordRunDegraded`'s stub insert for a run whose very first scan
   *  THREW before ever reaching `upsertWorkflowRun` (e.g. a dangling
   *  `subagents/workflows/wf_*` symlink whose target vanished) -- that row
   *  never had, and structurally never can have, a completed scan, so
   *  including it here just re-throws on the same stat forever. */
  workflowRunsToScan(cutoff: number): WorkflowRunScanRow[] {
    return this.db
      .query(
        `SELECT ${Store.WF_SCAN_COLS} FROM workflow_runs r
         LEFT JOIN sessions s ON s.id = r.session_id
         WHERE r.last_seen_at > $cutoff`
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

  /** §3: everything about a run EXCEPT its agents/agent_counts -- shared
   *  verbatim between `hydrateWorkflowRuns` (the full per-agent view) and
   *  `workflowList` (the cheap per-agent-COUNT view, which deliberately never
   *  pays for `hydrateWorkflowRuns`' per-agent hydration). Phases parsing,
   *  state derivation and the live `duration_ms` calc used to be copy-pasted
   *  between the two, which is exactly how `workflowList`'s `agent_counts`
   *  silently fell out of sync with the killed-normalisation the full view
   *  already applied -- extracted so that class of drift can't recur. */
  private static baseRunFields(
    r: Record<string, any>,
    state: "running" | "settled" | "orphaned",
    cost: { cost: number | null; tokens: number; unpriced: number },
    now: number
  ): Omit<WorkflowRun, "agents"> {
    let phases: { title: string; detail: string | null }[] = [];
    try {
      if (r.phases) phases = JSON.parse(r.phases as string);
    } catch {
      phases = [];
    }
    return {
      run_id: r.run_id,
      session_id: r.session_id,
      project: r.project ?? "unknown", // matches costByProject's bucket
      branch: r.branch ?? null,
      name: r.name,
      summary: r.summary,
      status: r.status,
      state,
      error: r.error,
      started_at: r.started_at,
      // §3: a still-running run has no final duration from the manifest yet
      // -- report the live elapsed time instead of a stale/absent stored one.
      duration_ms: state === "running" && r.started_at != null ? now - r.started_at : r.duration_ms,
      ended_at: r.ended_at,
      agent_count: r.agent_count,
      phases,
      cc_version: r.cc_version,
      schema_ok: r.schema_ok === 1,
      total_tokens_reported: r.total_tokens_reported,
      default_model: r.default_model,
      total_tool_calls: r.total_tool_calls,
      costUsd: cost.cost,
      tokens: cost.tokens,
      unpricedTokens: cost.unpriced,
    };
  }

  /** Turn raw workflow_runs rows into API views: parse `phases` back from JSON,
   *  derive the liveness state, and join the per-agent usage rollup. Per-agent
   *  tokens and cost are NOT stored - they are derived from `usage`, so there is
   *  one priced source of truth and it works live, before any manifest exists. */
  private hydrateWorkflowRuns(rows: Record<string, any>[], now: number): WorkflowRun[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.run_id as string);
    const ph = ids.map((_, i) => `$r${i}`).join(", ");
    const params: Record<string, string> = {};
    ids.forEach((id, i) => (params[`$r${i}`] = id));

    const rollup = this.db
      .query(
        // NOT coalesced to 0 (§2.3, finding): an agent/run whose usage is
        // entirely unpriced must show as unknown, not a fabricated $0.00 --
        // the same rule §1.3's other cost aggregates already follow.
        // `unpriced` carries the token total of just the unpriced rows, so a
        // partial (some priced, some not) rollup is never mistaken for whole.
        `SELECT run_id, agent_id, SUM(cost_usd) AS cost, SUM${TOKEN_SUM} AS tokens, ${UNPRICED_TOKEN_SUM} AS unpriced
         FROM usage WHERE run_id IN (${ph}) GROUP BY run_id, agent_id`
      )
      .all(params) as { run_id: string; agent_id: string | null; cost: number | null; tokens: number; unpriced: number }[];
    const byAgent = new Map<string, { cost: number | null; tokens: number; unpriced: number }>();
    const byRun = new Map<string, { cost: number | null; tokens: number; unpriced: number }>();
    for (const r of rollup) {
      byAgent.set(`${r.run_id} ${r.agent_id ?? ""}`, { cost: r.cost, tokens: r.tokens, unpriced: r.unpriced });
      const t = byRun.get(r.run_id) ?? { cost: 0, tokens: 0, unpriced: 0 };
      // null + a real number stays that number (some agents priced, one not);
      // null + null stays null (the whole run is unpriced so far).
      const cost = r.cost == null ? t.cost : t.cost == null ? r.cost : t.cost + r.cost;
      byRun.set(r.run_id, { cost, tokens: t.tokens + r.tokens, unpriced: t.unpriced + r.unpriced });
    }

    const sessionStatus = new Map(
      (this.db.query(`SELECT id, status FROM sessions`).all() as { id: string; status: string }[]).map((s) => [
        s.id,
        s.status,
      ])
    );
    // Each run's derived liveness, computed once and shared by both the
    // agent-state normalisation below and the run objects at the bottom --
    // recomputing it twice from the same inputs would be redundant, and
    // splitting it would risk the two disagreeing (§3.1's whole point).
    const stateByRun = new Map(
      rows.map((r) => [
        r.run_id as string,
        deriveRunState(
          {
            manifest_seen: r.manifest_seen === 1,
            status: r.status,
            last_seen_at: r.last_seen_at,
            session_status: sessionStatus.get(r.session_id) ?? "ended",
          },
          now
        ),
      ])
    );

    // §3: agent-state normalisation at READ time, keyed by the OWNING run's raw
    // status -- a `progress`/`running` agent left behind when the run itself
    // was `killed`/`failed` reads as `killed` (it never got to finish, and
    // never will); a manifest `error` state is untouched either way. Gated on
    // the run's DERIVED state being anything but "running" (spec gap fix,
    // C6): a manifest can say `failed` while agent transcripts are still
    // actively appending and get rewritten to `completed` minutes later
    // (`manifestRewritten` in scanRun) -- during that window the run reads
    // "running" and its agents must too, or the live board would show agents
    // as killed while they are provably still making progress.
    const statusByRun = new Map(rows.map((r) => [r.run_id as string, r.status as string | null]));
    const normalizeAgentState = (runId: string, state: string | null): string | null => {
      const runStatus = statusByRun.get(runId);
      const settled = stateByRun.get(runId) !== "running";
      if (settled && (runStatus === "killed" || runStatus === "failed") && (state === "progress" || state === "running")) {
        return "killed";
      }
      return state;
    };

    const agentRows = this.db
      .query(`SELECT * FROM workflow_agents WHERE run_id IN (${ph}) ORDER BY run_id, idx, agent_id`)
      .all(params) as Record<string, any>[];
    const agentsByRun = new Map<string, WorkflowAgentView[]>();
    for (const a of agentRows) {
      const roll = byAgent.get(`${a.run_id} ${a.agent_id}`) ?? { cost: 0, tokens: 0, unpriced: 0 };
      const list = agentsByRun.get(a.run_id) ?? [];
      list.push({
        agent_id: a.agent_id,
        label: a.label,
        phase_index: a.phase_index,
        phase_title: a.phase_title,
        idx: a.idx,
        model: a.model,
        state: normalizeAgentState(a.run_id, a.state),
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
        unpricedTokens: roll.unpriced,
        error: a.error,
        fallback_model: a.fallback_model,
      });
      agentsByRun.set(a.run_id, list);
    }

    return rows.map((r) => {
      const roll = byRun.get(r.run_id) ?? { cost: 0, tokens: 0, unpriced: 0 };
      const state = stateByRun.get(r.run_id)!;
      return { ...Store.baseRunFields(r, state, roll, now), agents: agentsByRun.get(r.run_id) ?? [] };
    });
  }

  /** Completed + in-flight runs for the history page, newest first. `since`/`until`
   *  filter on `started_at` (since inclusive, until exclusive), matching
   *  rangeClause()'s convention; runs with a NULL start drop out whenever either
   *  bound is given. `limit` caps RUNS, not agents, and is clamped to 1..500.
   *  Agents are embedded: one endpoint, one round trip, no per-row expand fetch.
   *
   *  §3 superseded this in production -- `workflowList` (agents-less, paginated,
   *  searchable) plus `workflowRunDetail` (one run WITH agents, on expand) is
   *  what `GET /api/workflows` and the web page actually use now; nothing in
   *  `src/` calls this any more. It stays as the direct, no-HTTP-layer way to
   *  exercise `hydrateWorkflowRuns` (agent embedding, unpriced-cost handling,
   *  state derivation, killed-normalisation, live duration_ms) with since/
   *  until/limit filtering that `workflowRunDetail` doesn't need for a single
   *  run -- removing it would mean re-deriving those same assertions through
   *  `workflowRunDetail` one run at a time for no behavioural gain, since it is
   *  a thin, un-duplicated wrapper around the same `hydrateWorkflowRuns` /
   *  `baseRunFields` those two production paths already share. */
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
   *  window. Orphaned runs stay visible deliberately - the state is self-healing,
   *  so a run whose files move again flips back to running.
   *
   *  This is the ONLY payload the 5s tick broadcasts. It must never grow into a
   *  buildState()-sized query - which is why the settled predicate is applied
   *  HERE, in SQL, rather than left to the `.filter()` below: a heavy workflow
   *  day can leave many settled runs inside the 24h window, and hydrating all
   *  of them (per-agent usage rollup, workflow_agents fetch, sessions scan)
   *  just to throw the results away is exactly the buildState()-sized cost
   *  this method must never grow into. The condition mirrors deriveRunState's
   *  "settled" branch exactly (manifest_seen && quiet); the `.filter()` stays
   *  as a defensive backstop, not the primary mechanism.
   *
   *  `last_seen_at IS NULL` rows are excluded outright, never treated as "live
   *  forever": `upsertWorkflowRun` always writes a real value, so a NULL one
   *  can only be `recordRunDegraded`'s stub for a run whose first scan threw
   *  before completing (a dangling run-dir symlink, say) -- without this it
   *  would show up as a nameless phantom "orphaned" run on the board forever,
   *  since nothing can ever complete a scan for it and give it a real one. */
  liveWorkflows(now: number = Date.now()): LiveWorkflow[] {
    const rows = this.db
      .query(
        `SELECT * FROM workflow_runs
         WHERE last_seen_at > $cutoff
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
          unpricedTokens: r.unpricedTokens,
          agents: r.agents,
        };
      });
  }

  /** §3: one run WITH its agents, for `GET /api/workflows/:runId`. null when no
   *  such run exists. Reuses `hydrateWorkflowRuns` (killed-normalisation, live
   *  duration_ms and all) for a single row -- the list view avoids this cost
   *  deliberately (`workflowList` below), but a single expanded run is exactly
   *  the shape this method already produces well. */
  workflowRunDetail(runId: string, now: number = Date.now()): WorkflowRun | null {
    const row = this.db.query(`SELECT * FROM workflow_runs WHERE run_id = $run`).get({ $run: runId }) as
      | Record<string, any>
      | undefined;
    if (!row) return null;
    return this.hydrateWorkflowRuns([row], now)[0] ?? null;
  }

  /** §3/§5.3: the `/api/workflows` list -- runs WITHOUT their per-agent array,
   *  plus a cheap `agent_counts` rollup, `total` for pagination, an optional
   *  `q` substring match against name/project (case-insensitive), and an
   *  optional exact `project` filter (the Workflows page's project dropdown --
   *  exact match, not a substring, since it's populated from the same project
   *  names `state.cost.byProject` already lists verbatim). Newest first;
   *  `limit`/`offset` page through it. Deliberately does NOT reuse
   *  `hydrateWorkflowRuns`: that pays for a full per-agent view (including a
   *  per-agent usage JOIN) that a run-listing page never renders -- exactly
   *  the cost this endpoint exists to avoid. */
  workflowList(
    opts: { q?: string; project?: string; since?: number; until?: number; limit?: number; offset?: number } = {},
    now: number = Date.now()
  ): { runs: WorkflowRunSummary[]; total: number } {
    const conds: string[] = [];
    const params: Record<string, string | number> = {};
    if (opts.q) {
      conds.push("(name LIKE $q OR project LIKE $q)");
      params.$q = `%${opts.q}%`;
    }
    if (opts.project) {
      conds.push("project = $project");
      params.$project = opts.project;
    }
    // Kept alongside the new §3 params (q/limit/offset/total) rather than
    // removed -- the workflows page's day-window filter already relies on it
    // (started_at, same convention as workflowHistory/rangeClause: since
    // inclusive, until exclusive).
    if (opts.since !== undefined) {
      conds.push("started_at >= $since");
      params.$since = opts.since;
    }
    if (opts.until !== undefined) {
      conds.push("started_at < $until");
      params.$until = opts.until;
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const total = (this.db.query(`SELECT COUNT(*) AS c FROM workflow_runs ${where}`).get(params) as { c: number }).c;
    const limit = Math.min(500, Math.max(1, Math.round(opts.limit ?? 50)));
    const offset = Math.max(0, Math.round(opts.offset ?? 0));
    const rows = this.db
      .query(
        `SELECT * FROM workflow_runs ${where} ORDER BY started_at DESC LIMIT ${limit} OFFSET ${offset}`
      )
      .all(params) as Record<string, any>[];
    if (rows.length === 0) return { runs: [], total };

    const ids = rows.map((r) => r.run_id as string);
    const ph = ids.map((_, i) => `$r${i}`).join(", ");
    const idParams: Record<string, string> = {};
    ids.forEach((id, i) => (idParams[`$r${i}`] = id));

    const costRows = this.db
      .query(
        `SELECT run_id, SUM(cost_usd) AS cost, SUM${TOKEN_SUM} AS tokens, ${UNPRICED_TOKEN_SUM} AS unpriced
         FROM usage WHERE run_id IN (${ph}) GROUP BY run_id`
      )
      .all(idParams) as { run_id: string; cost: number | null; tokens: number; unpriced: number }[];
    const costByRun = new Map(costRows.map((r) => [r.run_id, r]));

    // Raw per-run, per-state counts -- finalized into buckets below, once each
    // run's derived `state` is known, so the killed-normalisation (same rule
    // as `hydrateWorkflowRuns`) can be applied without a second query.
    const countRows = this.db
      .query(`SELECT run_id, state, COUNT(*) AS n FROM workflow_agents WHERE run_id IN (${ph}) GROUP BY run_id, state`)
      .all(idParams) as { run_id: string; state: string | null; n: number }[];
    const rawCountsByRun = new Map<string, { state: string | null; n: number }[]>();
    for (const r of countRows) {
      const list = rawCountsByRun.get(r.run_id) ?? [];
      list.push({ state: r.state, n: r.n });
      rawCountsByRun.set(r.run_id, list);
    }

    const sessionStatus = new Map(
      (this.db.query(`SELECT id, status FROM sessions`).all() as { id: string; status: string }[]).map((s) => [
        s.id,
        s.status,
      ])
    );

    const runs = rows.map((r) => {
      const state = deriveRunState(
        {
          manifest_seen: r.manifest_seen === 1,
          status: r.status,
          last_seen_at: r.last_seen_at,
          session_status: sessionStatus.get(r.session_id) ?? "ended",
        },
        now
      );
      // §3 + C6 spec-gap fix: a `progress`/`running` agent left behind by a
      // `killed`/`failed` run reads as killed, but only once the run itself
      // has stopped moving (state !== "running") -- same gate as
      // `hydrateWorkflowRuns`, so the list and detail views never disagree.
      const killedNormalizes = state !== "running" && (r.status === "killed" || r.status === "failed");
      const counts: AgentCounts = { total: 0, done: 0, error: 0, running: 0, abandoned: 0, killed: 0 };
      for (const { state: st, n } of rawCountsByRun.get(r.run_id) ?? []) {
        counts.total += n;
        if (st === "done") counts.done += n;
        else if (st === "error") counts.error += n;
        else if (st === "running" || st === "progress") {
          if (killedNormalizes) counts.killed += n;
          else counts.running += n;
        } else if (st === "abandoned") counts.abandoned += n;
      }
      const cost = costByRun.get(r.run_id) ?? { cost: 0, tokens: 0, unpriced: 0 };
      return { ...Store.baseRunFields(r, state, cost, now), agent_counts: counts };
    });
    return { runs, total };
  }

  /** §3: the board's "last run" line for when nothing is live -- the single
   *  most recently-ended run that reads SETTLED (raw `ended_at`/`status` alone
   *  can't tell settled from a run whose dir is still moving, C6).
   *
   *  The WHERE clause applies deriveRunState's "settled" rule directly in SQL
   *  (`manifest_seen && quiet`, its rule 1 -- session status never enters into
   *  that rule, so this needs no join) rather than hydrating candidate rows
   *  and filtering in JS: filtering FIRST and ordering second finds the true
   *  most-recent settled run with no arbitrary candidate cap (the previous
   *  "top 20 by end time, hope one of them is settled" approach could miss a
   *  genuinely settled run during a very active stretch with 20+ concurrent
   *  runs -- a real spec gap, not just a perf one). Cost when something
   *  qualifies is one indexed-enough row lookup plus one cost rollup over a
   *  single run_id -- not `hydrateWorkflowRuns`' full per-agent/session-status
   *  machinery, which this call never needed (only 5 fields ever leave it). */
  lastSettledRun(now: number = Date.now()): LastSettledRun | null {
    const row = this.db
      .query(
        `SELECT run_id, name, status, ended_at FROM workflow_runs
         WHERE manifest_seen = 1 AND (last_seen_at IS NULL OR last_seen_at < $quiet)
         ORDER BY COALESCE(ended_at, started_at) DESC LIMIT 1`
      )
      .get({ $quiet: now - WF_QUIET_MS }) as
      | { run_id: string; name: string | null; status: string | null; ended_at: number | null }
      | undefined;
    if (!row) return null;
    const cost = this.db.query(`SELECT SUM(cost_usd) AS cost FROM usage WHERE run_id = $r`).get({ $r: row.run_id }) as {
      cost: number | null;
    };
    return { run_id: row.run_id, name: row.name, status: row.status, ended_at: row.ended_at, costUsd: cost.cost };
  }

  // --- Codex rollout backfill (§4.4) --------------------------------------

  /** The stored tail state for one Codex rollout file, or null if it has
   *  never been seen before - lets the startup backfill tell "brand new file"
   *  from "grown since last boot" without re-reading from byte 0 every time.
   *  `offset` is the byte just past the last COMPLETE line consumed (never
   *  the raw file size - a trailing partial line at read time must stay
   *  unconsumed so it is re-read once it is finished); `size` is the file's
   *  own size as of that same pass, used only to detect "unchanged since last
   *  time" (offset alone can't: it legitimately stays short of size whenever
   *  the file ends mid-line). */
  getHarnessFileOffset(path: string): { session_id: string; offset: number; mtime: number | null; size: number | null } | null {
    const row = this.db.query(`SELECT session_id, offset, mtime, size FROM harness_files WHERE path = $p`).get({ $p: path });
    return (row as { session_id: string; offset: number; mtime: number | null; size: number | null }) ?? null;
  }

  setHarnessFileOffset(path: string, sessionId: string, offset: number, mtime: number | null, size: number | null): void {
    this.db
      .query(
        `INSERT INTO harness_files (path, session_id, offset, mtime, size) VALUES ($p, $s, $o, $m, $sz)
         ON CONFLICT(path) DO UPDATE SET session_id = excluded.session_id, offset = excluded.offset, mtime = excluded.mtime, size = excluded.size`
      )
      .run({ $p: path, $s: sessionId, $o: offset, $m: mtime, $sz: size });
  }
}
