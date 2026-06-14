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
