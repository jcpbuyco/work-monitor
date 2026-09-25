import { describe, it, expect } from "bun:test";
import { compactPayload, extractEventColumns, detectHarness } from "../src/server/payload.ts";

describe("compactPayload", () => {
  it("drops known-huge/redundant fields", () => {
    const out = JSON.parse(
      compactPayload({
        session_id: "s1",
        tool_response: "x".repeat(50_000),
        tool_output: "y",
        output: "z",
        content: "cursor beforeReadFile body",
        last_assistant_message: "a whole reply",
        edits: [{ old: "a", new: "b" }],
        tool_name: "Bash",
      })
    );
    expect(out).toEqual({ session_id: "s1", tool_name: "Bash" });
  });

  it("truncates a long string value with a trailing ellipsis", () => {
    const long = "a".repeat(3000);
    const out = JSON.parse(compactPayload({ session_id: "s1", prompt: long }));
    expect(out.prompt.length).toBe(2001); // 2000 chars + "…"
    expect(out.prompt.endsWith("…")).toBe(true);
  });

  it("truncates strings recursively inside nested objects and arrays", () => {
    const long = "b".repeat(3000);
    const out = JSON.parse(
      compactPayload({ session_id: "s1", tool_input: { nested: { deep: long }, list: [long, "short"] } })
    );
    expect(out.tool_input.nested.deep.endsWith("…")).toBe(true);
    expect(out.tool_input.nested.deep.length).toBe(2001);
    expect(out.tool_input.list[0].endsWith("…")).toBe(true);
    expect(out.tool_input.list[1]).toBe("short");
  });

  it("leaves a short, ordinary payload untouched", () => {
    const payload = { session_id: "s1", cwd: "/x/repo", tool_name: "Read", tool_input: { file_path: "/x/repo/a.ts" } };
    const out = JSON.parse(compactPayload(payload));
    expect(out).toEqual(payload);
  });

  it("always produces valid JSON, even for a pathologically large payload", () => {
    const huge: Record<string, unknown> = { session_id: "s1", cwd: "/x", tool_name: "Bash", hook_event_name: "PostToolUse" };
    // Many merely-longish fields (not one giant one) so per-string truncation
    // alone doesn't bring it under the cap -- this must hit the fallback.
    for (let i = 0; i < 50; i++) huge[`field_${i}`] = "z".repeat(1999);
    const json = compactPayload(huge);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json.length).toBeLessThanOrEqual(8000);
  });

  it("falls back to the minimal summary shape when still too large after truncation", () => {
    const huge: Record<string, unknown> = {
      session_id: "s1",
      cwd: "/x/repo",
      tool_name: "Bash",
      tool_input: { command: "run the tests" },
      hook_event_name: "PostToolUse",
    };
    for (let i = 0; i < 50; i++) huge[`field_${i}`] = "z".repeat(1999);
    const out = JSON.parse(compactPayload(huge));
    expect(Object.keys(out).sort()).toEqual(["cwd", "hook_event_name", "session_id", "tool_input", "tool_name"].sort());
    expect(out.session_id).toBe("s1");
    expect(out.cwd).toBe("/x/repo");
    expect(out.tool_name).toBe("Bash");
    expect(out.hook_event_name).toBe("PostToolUse");
    expect(typeof out.tool_input).toBe("string");
    expect(out.tool_input).toBe("run the tests"); // Bash prefers its description/command
  });

  it("fallback tool_input summary degrades gracefully with no tool_input at all", () => {
    const huge: Record<string, unknown> = { session_id: "s1", cwd: "/x", tool_name: "Bash" };
    for (let i = 0; i < 50; i++) huge[`field_${i}`] = "z".repeat(1999);
    const out = JSON.parse(compactPayload(huge));
    expect(out.tool_input).toBe("");
  });
});

describe("extractEventColumns", () => {
  it("extracts tool_name, numeric duration_ms, and agent_id", () => {
    const cols = extractEventColumns({ tool_name: "Bash", duration_ms: 1500, agent_id: "a1" });
    expect(cols).toEqual({ toolName: "Bash", durationMs: 1500, agentId: "a1", harness: "claude" });
  });

  it("leaves fields null when absent or the wrong type", () => {
    expect(extractEventColumns({})).toEqual({ toolName: null, durationMs: null, agentId: null, harness: "claude" });
    expect(extractEventColumns({ duration_ms: "1500" })).toEqual({
      toolName: null,
      durationMs: null,
      agentId: null,
      harness: "claude",
    });
    expect(extractEventColumns({ duration_ms: Number.NaN })).toEqual({
      toolName: null,
      durationMs: null,
      agentId: null,
      harness: "claude",
    });
  });
});

describe("detectHarness", () => {
  it("is claude by default", () => {
    expect(detectHarness({ tool_name: "Bash" })).toBe("claude");
  });

  it("is cursor when the payload carries cursor_version", () => {
    expect(detectHarness({ cursor_version: "1.2.3" })).toBe("cursor");
  });
});
