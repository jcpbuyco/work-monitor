import { describe, it, expect } from "bun:test";
import { reduceEvent } from "../src/server/events.ts";
import type { HookEvent } from "../src/server/types.ts";

const base = (over: Partial<HookEvent>): HookEvent => ({
  wm_event_type: "stop",
  session_id: "s1",
  ...over,
});

const NOW = 1_000_000;

describe("reduceEvent", () => {
  it("session_start -> working, sets project from cwd", () => {
    const { sessionId, patch } = reduceEvent(
      base({ wm_event_type: "session_start", cwd: "/x/browns", transcript_path: "/t" }),
      NOW
    );
    expect(sessionId).toBe("s1");
    expect(patch.status).toBe("working");
    expect(patch.project).toBe("browns");
    expect(patch.cwd).toBe("/x/browns");
    expect(patch.transcript_path).toBe("/t");
    expect(patch.last_activity_at).toBe(NOW);
  });

  it("prompt -> working, sets current_intent (truncated) and clears attention", () => {
    const { patch } = reduceEvent(
      base({ wm_event_type: "prompt", prompt: "Refactor the checkout flow please" }),
      NOW
    );
    expect(patch.status).toBe("working");
    expect(patch.current_intent).toBe("Refactor the checkout flow please");
    expect(patch.attention_reason).toBeNull();
  });

  it("todo_update -> working, sets current_task from tool_input.todos", () => {
    const { patch } = reduceEvent(
      base({
        wm_event_type: "todo_update",
        tool_name: "TodoWrite",
        tool_input: { todos: [{ content: "A", status: "in_progress" }] },
      }),
      NOW
    );
    expect(patch.status).toBe("working");
    expect(patch.current_task).toBe("A (0/1 done)");
  });

  it("notification -> needs_you with attention_reason", () => {
    const { patch } = reduceEvent(
      base({ wm_event_type: "notification", message: "Run the migration?" }),
      NOW
    );
    expect(patch.status).toBe("needs_you");
    expect(patch.attention_reason).toBe("Run the migration?");
  });

  it("stop -> idle", () => {
    const { patch } = reduceEvent(base({ wm_event_type: "stop" }), NOW);
    expect(patch.status).toBe("idle");
  });

  it("session_end -> ended with ended_at", () => {
    const { patch } = reduceEvent(base({ wm_event_type: "session_end" }), NOW);
    expect(patch.status).toBe("ended");
    expect(patch.ended_at).toBe(NOW);
  });
});
