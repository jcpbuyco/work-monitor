import type { Todo, TodoStatus } from "./types.ts";

const STATUSES: TodoStatus[] = ["todo", "done"];

/** Given a drag from `activeId` dropped over `overId`, return the status patch to
 *  persist, or null if it's not a valid cross-column move. */
export function resolveDrop(
  todos: Todo[],
  activeId: string,
  overId: string | null
): { id: string; status: TodoStatus } | null {
  if (!overId || !STATUSES.includes(overId as TodoStatus)) return null;
  const todo = todos.find((t) => t.id === activeId);
  if (!todo || todo.status === overId) return null;
  return { id: activeId, status: overId as TodoStatus };
}
