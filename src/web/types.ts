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
  /** null when every usage row for the session is unpriced -- never a
   *  fabricated $0.00 (server: store.ts §2.3). */
  costUsd: number | null;
  tokens: number;
}

export interface ModelCost {
  model: string;
  costUsd: number | null;
}

export interface ProjectCost {
  project: string;
  costUsd: number | null;
  tokens: number;
  // OPTIONAL like `workflows_degraded` (State): a live dashboard can briefly
  // talk to a server from just before this field shipped (the restart-skew
  // gotcha) -- always read as `?? 0`.
  unpricedTokens?: number;
}

export interface BranchCost {
  project: string;
  branch: string | null;
  costUsd: number | null;
  tokens: number;
  unpricedTokens?: number;
}

export interface Cost {
  perSession: Record<string, SessionCost>;
  liveTotalUsd: number;
  /** null only when there is no priced usage at all today (no usage yet, or
   *  every row seen is unpriced) -- never a fabricated $0.00. */
  todayUsd: number | null;
  byModelToday: ModelCost[];
  byProject: ProjectCost[];
  byBranch: BranchCost[];
  unpricedTokens?: number;
  unpricedModels?: { model: string; tokens: number }[];
}

export interface State {
  sessions: Session[];
  todos: Todo[];
  activity: Activity[];
  stats: ToolStat[];
  cost: Cost;
  /** OPTIONAL on purpose: a rebuilt bundle can briefly talk to a server that
   *  predates the field (the restart-skew gotcha). Always read it as `?? 0`. */
  workflows_degraded?: number;
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
  costUsd: number | null;
  unpricedTokens?: number;
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
  costUsd: number | null;
  tokens: number;
  unpricedTokens?: number;
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
  phase: { index: number; total: number; title: string } | null;
  schema_ok: boolean;
  costUsd: number | null;
  tokens: number;
  unpricedTokens?: number;
  agents: WorkflowAgentView[];
}
