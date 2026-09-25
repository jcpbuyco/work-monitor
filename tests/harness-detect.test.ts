import { describe, it, expect } from "bun:test";
import { detectHarness, resolveParentSessionId, parentFromScratchpadCwd } from "../src/server/harness/detect.ts";

describe("detectHarness (§4.2)", () => {
  it("is claude with no other signal", () => {
    expect(detectHarness({ tool_name: "Bash" })).toBe("claude");
  });

  it("is cursor when the payload carries cursor_version (real sessionStart shape)", () => {
    // Real payload, redacted (cursor.md §1b).
    expect(
      detectHarness({
        conversation_id: "0f92d777-0000-0000-0000-000000000000",
        session_id: "0f92d777-0000-0000-0000-000000000000",
        model: "grok-4.7-low",
        hook_event_name: "sessionStart",
        cursor_version: "2026.09.23-86fc751",
        workspace_roots: ["/abs/path/to/project"],
        transcript_path: null,
      })
    ).toBe("cursor");
  });

  it("is cursor when transcript_path sits under ~/.cursor/, even with no cursor_version field", () => {
    expect(
      detectHarness({ transcript_path: "/home/user/.cursor/projects/slug/agent-transcripts/id/id.jsonl" })
    ).toBe("cursor");
  });

  it("is codex when transcript_path sits under ~/.codex/", () => {
    // Real rollout path shape (codex.md §2).
    expect(
      detectHarness({ transcript_path: "/home/user/.codex/sessions/2026/09/25/rollout-2026-09-25T06-53-31-x.jsonl" })
    ).toBe("codex");
  });

  it("is codex when the query string says so, even with no transcript_path yet", () => {
    expect(detectHarness({ session_id: "s1" }, "codex")).toBe("codex");
  });

  it("cursor_version wins over a codex query hint (payload shape is the stronger signal)", () => {
    expect(detectHarness({ cursor_version: "1.2.3" }, "codex")).toBe("cursor");
  });

  it("an unrecognized query harness value falls through to claude", () => {
    expect(detectHarness({}, "typo")).toBe("claude");
  });
});

describe("parentFromScratchpadCwd", () => {
  it("extracts the parent session uuid from the scratchpad cwd convention", () => {
    const cwd =
      "/tmp/claude-1000/-home-lunatic-projects-work-agent-monitor/fe6382e2-c797-47f4-badb-da617338ebdf/scratchpad";
    expect(parentFromScratchpadCwd(cwd)).toBe("fe6382e2-c797-47f4-badb-da617338ebdf");
  });

  it("matches a subdirectory under scratchpad too", () => {
    const cwd =
      "/tmp/claude-1000/-slug/fe6382e2-c797-47f4-badb-da617338ebdf/scratchpad/dl-design";
    expect(parentFromScratchpadCwd(cwd)).toBe("fe6382e2-c797-47f4-badb-da617338ebdf");
  });

  it("is null for an ordinary cwd", () => {
    expect(parentFromScratchpadCwd("/home/user/projects/work/agent-monitor")).toBeNull();
  });

  it("is null for undefined/empty input", () => {
    expect(parentFromScratchpadCwd(null)).toBeNull();
    expect(parentFromScratchpadCwd(undefined)).toBeNull();
    expect(parentFromScratchpadCwd("")).toBeNull();
  });
});

describe("resolveParentSessionId (§4.2)", () => {
  it("prefers pcc over pcx", () => {
    expect(resolveParentSessionId({ pcc: "parent-cc", pcx: "parent-cx", sessionId: "s1" })).toBe("parent-cc");
  });

  it("falls back to pcx when pcc is absent", () => {
    expect(resolveParentSessionId({ pcx: "parent-cx", sessionId: "s1" })).toBe("parent-cx");
  });

  it("skips a pcc/pcx that equals the event's own session id", () => {
    expect(resolveParentSessionId({ pcc: "s1", pcx: "parent-cx", sessionId: "s1" })).toBe("parent-cx");
  });

  it("falls back to the scratchpad cwd pattern when neither env var is present", () => {
    const cwd = "/tmp/claude-1000/-slug/fe6382e2-c797-47f4-badb-da617338ebdf/scratchpad";
    expect(resolveParentSessionId({ cwd, sessionId: "s1" })).toBe("fe6382e2-c797-47f4-badb-da617338ebdf");
  });

  it("is null when nothing resolves", () => {
    expect(resolveParentSessionId({ cwd: "/home/user/repo", sessionId: "s1" })).toBeNull();
  });

  it("never resolves a session as its own parent via the scratchpad fallback", () => {
    const cwd = "/tmp/claude-1000/-slug/s1/scratchpad";
    expect(resolveParentSessionId({ cwd, sessionId: "s1" })).toBeNull();
  });
});
