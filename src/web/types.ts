export type SessionStatus = "working" | "needs_you" | "idle" | "ended";
export type TodoStatus = "todo" | "done";

export interface Session {
  id: string;
  project: string;
  status: SessionStatus;
  current_task: string | null;
  current_intent: string | null;
  attention_reason: string | null;
  active_tool: string | null;
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
  detail: string | null;
  dur: number | null;
  at: number;
}

export interface ToolStat {
  tool: string;
  calls: number;
  totalMs: number;
  avgMs: number | null;
}

export interface SessionCost {
  costUsd: number;
  tokens: number;
}

export interface ModelCost {
  model: string;
  costUsd: number;
}

export interface ProjectCost {
  project: string;
  costUsd: number;
  tokens: number;
}

export interface BranchCost {
  project: string;
  branch: string | null;
  costUsd: number;
  tokens: number;
}

export interface Cost {
  perSession: Record<string, SessionCost>;
  liveTotalUsd: number;
  todayUsd: number;
  byModelToday: ModelCost[];
  byProject: ProjectCost[];
  byBranch: BranchCost[];
}

export interface State {
  sessions: Session[];
  todos: Todo[];
  activity: Activity[];
  stats: ToolStat[];
  cost: Cost;
}
