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
  /** Derived liveness: "running" | "settled" | "orphaned". Typed as string
   *  because the server never validates Claude Code's vocabulary. */
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
