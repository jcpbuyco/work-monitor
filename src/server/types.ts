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
  branch: string | null;
  started_at: number;
  last_activity_at: number;
  ended_at: number | null;
}

export type EventType =
  | "session_start"
  | "prompt"
  | "todo_update"
  | "activity"
  | "notification"
  | "stop"
  | "session_end";

/** Raw Claude Code hook payload plus the type from the query string. */
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
  branch?: string | null;
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
