import type { State, TodoStatus } from "./types.ts";

export async function fetchState(): Promise<State> {
  const r = await fetch("/api/state");
  return r.json();
}

export function subscribe(onState: (s: State) => void): () => void {
  const es = new EventSource("/api/stream");
  es.addEventListener("state", (e) => onState(JSON.parse((e as MessageEvent).data)));
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
