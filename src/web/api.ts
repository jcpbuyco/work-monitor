import type { State, TodoStatus, LiveWorkflow, LastRun } from "./types.ts";

export async function fetchState(): Promise<State> {
  const r = await fetch("/api/state");
  return r.json();
}

/** One EventSource, two event types. Workflows are deliberately NOT part of the
 *  `state` blob: that snapshot costs 243ms to build and is pushed at 60s, while
 *  the workflow strip refreshes every 5s.
 *
 *  §3: the wire payload is `{runs, last_run}`, not a bare array -- unwrapped
 *  here so `onWorkflows` keeps its original `LiveWorkflow[]` signature.
 *  `payload.runs ?? payload` also tolerates a server from just before this
 *  shipped (the restart-skew gotcha: a rebuilt bundle can briefly talk to an
 *  old server still sending the bare array). */
export function subscribe(handlers: {
  onState: (s: State) => void;
  onWorkflows?: (w: LiveWorkflow[]) => void;
  onLastRun?: (r: LastRun | null) => void;
}): () => void {
  const es = new EventSource("/api/stream");
  es.addEventListener("state", (e) => handlers.onState(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("workflows", (e) => {
    const payload = JSON.parse((e as MessageEvent).data) as LiveWorkflow[] | { runs: LiveWorkflow[]; last_run: LastRun | null };
    handlers.onWorkflows?.(Array.isArray(payload) ? payload : payload.runs);
    if (!Array.isArray(payload)) handlers.onLastRun?.(payload.last_run);
  });
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
