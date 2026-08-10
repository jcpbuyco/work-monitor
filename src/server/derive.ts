import { MAX_INTENT_LEN } from "./config.ts";

export function projectFromCwd(cwd: string): string {
  if (!cwd) return "unknown";
  const parts = cwd.replace(/\/+$/, "").split("/");
  const last = parts[parts.length - 1];
  return last || "unknown";
}

export function truncate(s: string, n: number = MAX_INTENT_LEN): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

interface TodoItem {
  content?: string;
  status?: string;
  activeForm?: string;
}

// Claude Code's background-task/workflow subsystem fires UserPromptSubmit for
// synthetic "task finished" notifications too, injecting this XML wrapper as
// the prompt text with no other marker distinguishing it from a real,
// human-typed prompt. Keyed only off the one shape actually observed in real
// data — see investigation notes for the survey across stored prompt events.
const SYNTHETIC_PROMPT_PREFIXES = ["<task-notification>"];

export function isSyntheticPrompt(prompt: string): boolean {
  const t = prompt.trimStart();
  return SYNTHETIC_PROMPT_PREFIXES.some((p) => t.startsWith(p));
}

export function deriveCurrentTask(todos: TodoItem[] | undefined): string | null {
  if (!todos || todos.length === 0) return null;
  const total = todos.length;
  const completed = todos.filter((t) => t?.status === "completed").length;
  const active = todos.find((t) => t?.status === "in_progress");
  if (active) {
    const label = active.activeForm || active.content || "working";
    return `${label} (${completed}/${total} done)`;
  }
  return `${completed}/${total} done`;
}
