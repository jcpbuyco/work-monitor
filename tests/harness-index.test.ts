import { describe, it, expect } from "bun:test";
import { normalizeIncomingEvent } from "../src/server/harness/index.ts";

describe("normalizeIncomingEvent (§4.3 orchestrator)", () => {
  it("claude: passes the payload through untouched, extracting model/title", () => {
    const out = normalizeIncomingEvent("session_start", {
      session_id: "s1",
      cwd: "/repo",
      model: "claude-opus-5-5[1m]",
      session_title: "Fix the login bug",
    });
    expect(out.harness).toBe("claude");
    expect(out.model).toBe("claude-opus-5-5[1m]");
    expect(out.title).toBe("Fix the login bug");
    expect(out.harnessVersion).toBeNull();
    expect(out.payload).toEqual({
      session_id: "s1",
      cwd: "/repo",
      model: "claude-opus-5-5[1m]",
      session_title: "Fix the login bug",
    });
  });

  it("cursor: folds session_id/cwd/duration onto the generic fields the pipeline reads", () => {
    const out = normalizeIncomingEvent("activity", {
      conversation_id: "c1",
      cwd: "",
      workspace_roots: ["/abs/project"],
      tool_name: "Shell",
      duration: 3192.697,
      cursor_version: "2026.09.23-86fc751",
      model: "grok-4.7",
    });
    expect(out.harness).toBe("cursor");
    expect(out.payload.session_id).toBe("c1");
    expect(out.payload.cwd).toBe("/abs/project");
    expect(out.payload.duration_ms).toBe(3192.697);
    expect(out.model).toBe("grok-4.7");
    expect(out.harnessVersion).toBe("2026.09.23-86fc751");
  });

  it("codex: detected from transcript_path, synthesizes a notification message", () => {
    const out = normalizeIncomingEvent(
      "notification",
      {
        session_id: "s1",
        transcript_path: "/home/user/.codex/sessions/2026/09/25/rollout-x.jsonl",
        model: "gpt-5.5",
      },
      undefined
    );
    expect(out.harness).toBe("codex");
    expect(out.payload.message).toBe("Codex is waiting for approval");
    expect(out.model).toBe("gpt-5.5");
    expect(out.harnessVersion).toBeNull(); // read from the rollout at tail time (§4.4), not per-event
  });

  it("codex: detected via the query harness param when transcript_path is absent yet", () => {
    const out = normalizeIncomingEvent("session_start", { session_id: "s1" }, "codex");
    expect(out.harness).toBe("codex");
  });

  it("leaves an unrelated field (e.g. Cursor's tool_output) passed through untouched", () => {
    const out = normalizeIncomingEvent("activity", {
      conversation_id: "c1",
      cursor_version: "1.0.0",
      tool_output: '{"output":"hi"}',
    });
    expect(out.payload.tool_output).toBe('{"output":"hi"}');
  });
});
