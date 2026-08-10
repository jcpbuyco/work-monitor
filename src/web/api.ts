import type { State, TodoStatus, LiveWorkflow } from "./types.ts";

export async function fetchState(): Promise<State> {
  const r = await fetch("/api/state");
  return r.json();
}

/** One EventSource, two event types. Workflows are deliberately NOT part of the
 *  `state` blob: that snapshot costs 243ms to build and is pushed at 60s, while
 *  the workflow strip refreshes every 5s. */
export function subscribe(handlers: {
  onState: (s: State) => void;
  onWorkflows?: (w: LiveWorkflow[]) => void;
}): () => void {
  const es = new EventSource("/api/stream");
  es.addEventListener("state", (e) => handlers.onState(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("workflows", (e) => handlers.onWorkflows?.(JSON.parse((e as MessageEvent).data)));
  return () => es.close();
}

export async function patchTodo(id: string, patch: { status?: TodoStatus; position?: number }): Promise<void> {
  await fetch(`/api/todos/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function deleteTodo(id: string): Promise<void> {
  await fetch(`/api/todos/${id}`, { method: "DELETE" });
}
