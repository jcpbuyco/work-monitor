import type { HookEvent, SessionPatch } from "./types.ts";
import { projectFromCwd, truncate, deriveCurrentTask } from "./derive.ts";

export function reduceEvent(
  event: HookEvent,
  now: number
): { sessionId: string; patch: SessionPatch } {
  const patch: SessionPatch = { last_activity_at: now };

  if (event.cwd) {
    patch.cwd = event.cwd;
    patch.project = projectFromCwd(event.cwd);
  }
  if (event.transcript_path) patch.transcript_path = event.transcript_path;

  switch (event.wm_event_type) {
    case "session_start":
      patch.status = "working";
      break;
    case "prompt":
      patch.status = "working";
      patch.attention_reason = null;
      if (typeof event.prompt === "string") {
        patch.current_intent = truncate(event.prompt);
      }
      break;
    case "todo_update": {
      patch.status = "working";
      const todos = (event.tool_input as { todos?: unknown })?.todos;
      const task = deriveCurrentTask(
        Array.isArray(todos) ? (todos as { content: string; status: string }[]) : undefined
      );
      if (task !== null) patch.current_task = task;
      break;
    }
    case "notification":
      patch.status = "needs_you";
      patch.attention_reason = event.message ?? "Needs your attention";
      break;
    case "stop":
      patch.status = "idle";
      break;
    case "session_end":
      patch.status = "ended";
      patch.ended_at = now;
      break;
  }

  return { sessionId: event.session_id, patch };
}
