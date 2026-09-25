import type { Harness } from "../shared/harness.ts";

export type SessionStatus = "working" | "needs_you" | "idle" | "ended";

export interface Session {
  id: string;
  project: string;
  cwd: string;
  transcript_path: string | null;
  status: SessionStatus;
  current_task: string | null;
  current_intent: string | null;
  attention_reason: string | null;
  active_tool: string | null;
  branch: string | null;
  /** Why an `idle` session went idle: "stopped" (a Stop hook) or "quiet"
   *  (swept for silence past STALE_MS). Meaningless - and not necessarily
   *  cleared - once the session leaves `idle`. */
  idle_reason: string | null;
  /** §4.1: which coding-agent CLI produced this session. Defaults to
   *  'claude' for every row that predates multi-harness ingestion. */
  harness: Harness;
  /** The model reported by the harness's own hook payload (a raw id or
   *  alias, harness-specific) - display only, never used for pricing. */
  model: string | null;
  /** Claude Code's own `session_title` (session_start only) - null for every
   *  other harness and for sessions that started before this was ingested. */
  title: string | null;
  /** The session that spawned this one (a Bash `codex exec`/`cursor-agent`
   *  call, or a nested Claude Code session under a scratchpad dir), resolved
   *  once from `pcc`/`pcx`/the scratchpad cwd pattern (§4.2) and never
   *  overwritten afterward. Null for a top-level session. */
  parent_session_id: string | null;
  /** The harness's own CLI/build version (`cursor_version`, Codex's
   *  `cli_version`), for the harness mark's tooltip - display only. */
  harness_version: string | null;
  started_at: number;
  last_activity_at: number;
  ended_at: number | null;
}

export type EventType =
  | "session_start"
  | "prompt"
  | "tool_start"
  | "todo_update"
  | "activity"
  | "notification"
  | "stop"
  | "session_end";

/** Raw hook payload (Claude Code's shape, or another harness's own shape
 *  after §4.3 normalization already folded it onto these fields) plus the
 *  type from the query string. */
export interface HookEvent {
  wm_event_type: EventType;
  session_id: string;
  cwd?: string;
  transcript_path?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  message?: string;
  reason?: string;
  source?: string;
}

export interface SessionPatch {
  project?: string;
  cwd?: string;
  transcript_path?: string | null;
  status?: SessionStatus;
  current_task?: string | null;
  current_intent?: string | null;
  attention_reason?: string | null;
  active_tool?: string | null;
  branch?: string | null;
  idle_reason?: string | null;
  harness?: Harness;
  model?: string | null;
  title?: string | null;
  /** Set-once (§4.2): the store applies this only while the session has no
   *  parent recorded yet, and never clears or replaces one already set. */
  parent_session_id?: string | null;
  harness_version?: string | null;
  last_activity_at?: number;
  ended_at?: number | null;
}

export type TodoStatus = "todo" | "done";

export interface Todo {
  id: string;
  title: string;
  note: string;
  for_who: string | null;
  status: TodoStatus;
  origin_session_id: string | null;
  origin_project: string | null;
  branch: string | null;
  links: string[] | null;
  position: number;
  created_at: number;
  updated_at: number;
}

export interface CreateTodoInput {
  title: string;
  note?: string;
  for_who?: string | null;
  origin_session_id?: string | null;
  origin_project?: string | null;
  branch?: string | null;
  links?: string[] | null;
}

export interface UpdateTodoInput {
  title?: string;
  note?: string;
  for_who?: string | null;
  status?: TodoStatus;
  branch?: string | null;
  links?: string[] | null;
  position?: number;
}
