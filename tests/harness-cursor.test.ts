import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeCursorPayload, cursorIntentFromTranscript, findCursorTranscript } from "../src/server/harness/cursor.ts";

// Real captured payloads (redacted), cursor.md §1b.
const SESSION_START = {
  conversation_id: "0f92d777-0000-0000-0000-000000000000",
  generation_id: "0f92d777-0000-0000-0000-000000000000",
  model: "grok-4.7-low",
  is_background_agent: false,
  session_id: "0f92d777-0000-0000-0000-000000000000",
  hook_event_name: "sessionStart",
  cursor_version: "2026.09.23-86fc751",
  workspace_roots: ["/abs/path/to/project"],
  user_email: "redacted@example.com",
  transcript_path: null,
};

const PRE_TOOL_USE = {
  conversation_id: "c1",
  generation_id: "g1",
  model: "grok-4.7",
  tool_name: "Shell",
  tool_input: { command: "echo hi", cwd: "", timeout: 30000 },
  tool_use_id: "aaf5dd9c-0000",
  cwd: "",
  session_id: "c1",
  hook_event_name: "preToolUse",
  cursor_version: "2026.09.23-86fc751",
  workspace_roots: ["/abs/path/to/project"],
  user_email: "redacted@example.com",
  transcript_path: null,
};

const POST_TOOL_USE = {
  ...PRE_TOOL_USE,
  hook_event_name: "postToolUse",
  tool_output: '{"output":"hi\\n","exitCode":0}',
  duration: 3192.697,
};

const SESSION_END = {
  conversation_id: "0f92d777-0000-0000-0000-000000000000",
  generation_id: "0f92d777-0000-0000-0000-000000000000",
  model: "grok-4.7-low",
  reason: "completed",
  duration_ms: 34211,
  is_background_agent: false,
  final_status: "completed",
  session_id: "0f92d777-0000-0000-0000-000000000000",
  hook_event_name: "sessionEnd",
  cursor_version: "2026.09.23-86fc751",
  workspace_roots: ["/abs/path/to/project"],
  user_email: "redacted@example.com",
  transcript_path: "/home/user/.cursor/projects/slug/agent-transcripts/id/id.jsonl",
};

describe("normalizeCursorPayload (§4.3, table-tested on real captures)", () => {
  it("sessionStart: cwd falls back to workspace_roots[0] (own cwd is absent)", () => {
    const n = normalizeCursorPayload(SESSION_START);
    expect(n.sessionId).toBe("0f92d777-0000-0000-0000-000000000000");
    expect(n.cwd).toBe("/abs/path/to/project");
    expect(n.model).toBe("grok-4.7-low");
    expect(n.harnessVersion).toBe("2026.09.23-86fc751");
    expect(n.durationMs).toBeNull();
  });

  it("drops the 'unknown' placeholder model a default-model sessionStart carries", () => {
    expect(normalizeCursorPayload({ ...SESSION_START, model: "unknown" }).model).toBeNull();
    expect(normalizeCursorPayload({ ...SESSION_START, model: "" }).model).toBeNull();
  });

  it("preToolUse: cwd falls back to workspace_roots[0] when the tool's own cwd is empty string", () => {
    const n = normalizeCursorPayload(PRE_TOOL_USE);
    expect(n.cwd).toBe("/abs/path/to/project");
    expect(n.sessionId).toBe("c1");
  });

  it("postToolUse: duration (ms) maps to durationMs", () => {
    const n = normalizeCursorPayload(POST_TOOL_USE);
    expect(n.durationMs).toBe(3192.697);
  });

  it("sessionEnd: session_id present, no override needed", () => {
    const n = normalizeCursorPayload(SESSION_END);
    expect(n.sessionId).toBe("0f92d777-0000-0000-0000-000000000000");
  });

  it("session_id ?? conversation_id: prefers an explicit non-empty session_id", () => {
    const n = normalizeCursorPayload({ session_id: "s1", conversation_id: "c1" });
    expect(n.sessionId).toBe("s1");
  });

  it("session_id ?? conversation_id: falls back to conversation_id when session_id is absent", () => {
    const n = normalizeCursorPayload({ conversation_id: "c1" });
    expect(n.sessionId).toBe("c1");
  });

  it("cwd: prefers a non-empty own cwd over workspace_roots[0]", () => {
    const n = normalizeCursorPayload({ cwd: "/real/cwd", workspace_roots: ["/root"] });
    expect(n.cwd).toBe("/real/cwd");
  });

  it("degrades to nulls with no throw on an empty payload", () => {
    expect(normalizeCursorPayload({})).toEqual({
      sessionId: null,
      cwd: null,
      model: null,
      harnessVersion: null,
      durationMs: null,
    });
  });
});

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function transcriptPath(lines: string[]): string {
  dir = mkdtempSync(join(tmpdir(), "am-cursor-transcript-"));
  const p = join(dir, "t.jsonl");
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

describe("cursorIntentFromTranscript (§4.3: headless mode fires no prompt event)", () => {
  it("extracts the text inside <user_query> from the first user line", () => {
    const p = transcriptPath([
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "<user_query>\nfix the login bug\n</user_query>" }] },
      }),
      JSON.stringify({ type: "turn_ended", status: "success" }),
    ]);
    expect(cursorIntentFromTranscript(p)).toBe("fix the login bug");
  });

  it("falls back to the first text block verbatim when there is no <user_query> wrapper", () => {
    const p = transcriptPath([
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "just do the thing" }] } }),
    ]);
    expect(cursorIntentFromTranscript(p)).toBe("just do the thing");
  });

  it("skips a leading assistant line and finds the first user line", () => {
    const p = transcriptPath([
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "hello!" }] } }),
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "<user_query>go</user_query>" }] } }),
    ]);
    expect(cursorIntentFromTranscript(p)).toBe("go");
  });

  it("truncates a long prompt", () => {
    const long = "x".repeat(500);
    const p = transcriptPath([
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: `<user_query>${long}</user_query>` }] } }),
    ]);
    const out = cursorIntentFromTranscript(p)!;
    expect(out.length).toBeLessThan(500);
    expect(out.endsWith("…")).toBe(true);
  });

  it("is null for a missing file", () => {
    expect(cursorIntentFromTranscript("/no/such/file.jsonl")).toBeNull();
  });

  it("is null when no user line carries a text block", () => {
    const p = transcriptPath([JSON.stringify({ role: "user", message: { content: [{ type: "tool_use", name: "Read" }] } })]);
    expect(cursorIntentFromTranscript(p)).toBeNull();
  });

  it("is null for an empty file", () => {
    dir = mkdtempSync(join(tmpdir(), "am-cursor-transcript-"));
    const p = join(dir, "empty.jsonl");
    writeFileSync(p, "");
    expect(cursorIntentFromTranscript(p)).toBeNull();
  });
});

describe("findCursorTranscript (early events carry transcript_path: null)", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("finds <root>/<slug>/agent-transcripts/<id>/<id>.jsonl by session id", () => {
    root = mkdtempSync(join(tmpdir(), "am-cursor-projects-"));
    const dir = join(root, "home-me-projects-app", "agent-transcripts", "abc-123");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "abc-123.jsonl"), "");
    mkdirSync(join(root, "other-project", "agent-transcripts"), { recursive: true });
    expect(findCursorTranscript("abc-123", root)).toBe(join(dir, "abc-123.jsonl"));
  });

  it("is null when no project holds the id, or the root is missing", () => {
    root = mkdtempSync(join(tmpdir(), "am-cursor-projects-"));
    expect(findCursorTranscript("nope", root)).toBeNull();
    expect(findCursorTranscript("nope", join(root, "missing"))).toBeNull();
  });

  it("rejects ids that could escape the projects root", () => {
    root = mkdtempSync(join(tmpdir(), "am-cursor-projects-"));
    expect(findCursorTranscript("../x", root)).toBeNull();
    expect(findCursorTranscript("", root)).toBeNull();
  });
});
