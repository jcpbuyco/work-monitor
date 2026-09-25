import { describe, it, expect } from "bun:test";
import { normalizeCodexPayload } from "../src/server/harness/codex.ts";

// Real captured payload, redacted (codex.md §1).
const PRE_TOOL_USE = {
  session_id: "01a0d6e9-56f7-7131-b578-26c543558c6f",
  turn_id: "01a0d6e9-5745-7610-a8f4-5e5a7eb17f6f",
  transcript_path: "/home/user/.codex/sessions/2026/09/25/rollout-x.jsonl",
  cwd: "/home/user/workdir",
  hook_event_name: "PreToolUse",
  model: "gpt-5.5",
  permission_mode: "bypassPermissions",
  tool_name: "Bash",
  tool_input: { command: "echo hi" },
  tool_use_id: "call_3GqA51GaP0QP6S0X251LUC5k",
};

const SESSION_END = {
  session_id: "01a0d6e9-56f7-7131-b578-26c543558c6f",
  transcript_path: "/home/user/.codex/sessions/2026/09/25/rollout-x.jsonl",
  cwd: "/home/user/workdir",
  hook_event_name: "SessionEnd",
  reason: "other",
};

describe("normalizeCodexPayload (§4.3, table-tested on real captures)", () => {
  it("reads model off an ordinary event", () => {
    expect(normalizeCodexPayload("tool_start", PRE_TOOL_USE)).toEqual({ model: "gpt-5.5", message: null });
  });

  it("SessionEnd carries no model", () => {
    expect(normalizeCodexPayload("session_end", SESSION_END).model).toBeNull();
  });

  it("maps a notification event (PermissionRequest) to a synthesized message", () => {
    const out = normalizeCodexPayload("notification", { session_id: "s1", model: "gpt-5.5" });
    expect(out.message).toBe("Codex is waiting for approval");
  });

  it("never overwrites a message the payload already carries", () => {
    const out = normalizeCodexPayload("notification", { session_id: "s1", message: "a real future message" });
    expect(out.message).toBeNull();
  });

  it("never synthesizes a message for a non-notification event", () => {
    expect(normalizeCodexPayload("tool_start", PRE_TOOL_USE).message).toBeNull();
  });
});
