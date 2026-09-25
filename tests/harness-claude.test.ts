import { describe, it, expect } from "bun:test";
import { normalizeClaudePayload } from "../src/server/harness/claude.ts";

describe("normalizeClaudePayload (§4.3)", () => {
  it("session_start carries model and session_title (real shape, ui.md finding)", () => {
    const out = normalizeClaudePayload({
      session_id: "s1",
      hook_event_name: "SessionStart",
      model: "claude-opus-5-5[1m]",
      session_title: "Fix the login bug",
    });
    expect(out).toEqual({ model: "claude-opus-5-5[1m]", title: "Fix the login bug" });
  });

  it("a later event's model still updates (2.1.265+ carries model beyond session_start)", () => {
    const out = normalizeClaudePayload({ session_id: "s1", hook_event_name: "PreToolUse", model: "claude-sonnet-5" });
    expect(out.model).toBe("claude-sonnet-5");
    expect(out.title).toBeNull();
  });

  it("degrades to nulls with no model/session_title present", () => {
    expect(normalizeClaudePayload({ session_id: "s1" })).toEqual({ model: null, title: null });
  });
});
