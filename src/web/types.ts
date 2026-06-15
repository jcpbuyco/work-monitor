export type SessionStatus = "working" | "needs_you" | "idle" | "ended";
export type TodoStatus = "todo" | "done";

export interface Session {
  id: string;
  project: string;
  status: SessionStatus;
  current_task: string | null;
  current_intent: string | null;
  attention_reason: string | null;
  branch: string | null;
  started_at: number;
  last_activity_at: number;
}

export interface Todo {
  id: string;
  title: string;
  note: string;
  for_who: string | null;
  status: TodoStatus;
  origin_project: string | null;
  branch: string | null;
  links: string[] | null;
  position: number;
  updated_at: number;
}

export interface Activity {
  id: number;
  session_id: string;
  tool: string;
  at: number;
}

export interface State {
  sessions: Session[];
  todos: Todo[];
  activity: Activity[];
}
