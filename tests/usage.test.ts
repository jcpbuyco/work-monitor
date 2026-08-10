import { describe, it, expect } from "bun:test";
import { parseUsageLine, tailUsage, takeUsage } from "../src/server/usage.ts";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import { writeFileSync, appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const assistantLine = JSON.stringify({
  type: "assistant",
  uuid: "u-1",
  timestamp: "2026-06-15T08:00:00.000Z",
  message: {
    model: "claude-opus-4-8",
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
      iterations: [{ input_tokens: 100, output_tokens: 20 }],
    },
  },
});

describe("parseUsageLine", () => {
  it("extracts uuid, model, tokens, and timestamp", () => {
    const p = parseUsageLine(assistantLine);
    expect(p).not.toBeNull();
    expect(p!.uuid).toBe("u-1");
    expect(p!.model).toBe("claude-opus-4-8");
    expect(p!.tokens).toEqual({
      input: 100, output: 20, cache_read: 1000, cache_create_5m: 100, cache_create_1h: 200,
    });
    expect(p!.at).toBe(Date.parse("2026-06-15T08:00:00.000Z"));
  });

  it("returns null for lines without usage (user / tool_result lines)", () => {
    expect(parseUsageLine(JSON.stringify({ type: "user", uuid: "x", message: { role: "user", content: "hi" } }))).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseUsageLine("{not json")).toBeNull();
  });

  it("defaults missing cache_creation split to 0", () => {
    const line = JSON.stringify({
      uuid: "u-2", timestamp: "2026-06-15T08:00:00.000Z",
      message: { model: "claude-haiku-4-5", usage: { input_tokens: 5, output_tokens: 1 } },
    });
    const p = parseUsageLine(line)!;
    expect(p.tokens).toEqual({ input: 5, output: 1, cache_read: 0, cache_create_5m: 0, cache_create_1h: 0 });
  });
});

function line(uuid: string, model = "claude-opus-4-8") {
  return JSON.stringify({
    uuid, timestamp: "2026-06-15T08:00:00.000Z",
    message: { model, usage: { input_tokens: 1_000_000, output_tokens: 0 } },
  }) + "\n";
}

describe("tailUsage", () => {
  it("ingests new complete lines, is idempotent, and resumes from the offset", () => {
    const dir = mkdtempSync(join(tmpdir(), "am-usage-"));
    const file = join(dir, "t.jsonl");
    writeFileSync(file, line("m1") + line("m2"));
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", transcript_path: file, last_activity_at: 1 }, 1);

    const info1 = store.getTailInfo("s1")!;
    expect(tailUsage(store, { id: "s1", ...info1 })).toBe(true);
    expect(store.costSummary(0).perSession.s1.costUsd).toBeCloseTo(10, 6); // 2 × $5 (1M input @ opus)

    // Re-tail with no new content → nothing recorded, total unchanged
    const info2 = store.getTailInfo("s1")!;
    expect(tailUsage(store, { id: "s1", ...info2 })).toBe(false);
    expect(store.costSummary(0).perSession.s1.costUsd).toBeCloseTo(10, 6);

    // Append a third line → only it is ingested
    appendFileSync(file, line("m3"));
    const info3 = store.getTailInfo("s1")!;
    expect(tailUsage(store, { id: "s1", ...info3 })).toBe(true);
    expect(store.costSummary(0).perSession.s1.costUsd).toBeCloseTo(15, 6);
  });

  it("ignores a trailing partial line until it is completed", () => {
    const dir = mkdtempSync(join(tmpdir(), "am-usage-"));
    const file = join(dir, "t.jsonl");
    writeFileSync(file, line("m1") + '{"uuid":"m2","partial'); // no trailing newline on m2
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", transcript_path: file, last_activity_at: 1 }, 1);

    tailUsage(store, { id: "s1", ...store.getTailInfo("s1")! });
    expect(store.costSummary(0).perSession.s1.costUsd).toBeCloseTo(5, 6); // only m1

    // Complete the partial line
    writeFileSync(file, line("m1") + line("m2"));
    tailUsage(store, { id: "s1", ...store.getTailInfo("s1")! });
    expect(store.costSummary(0).perSession.s1.costUsd).toBeCloseTo(10, 6); // m1 + m2
  });

  it("returns false for a missing transcript", () => {
    const store = new Store(openDb(":memory:"));
    expect(tailUsage(store, { id: "x", transcript_path: "/no/such/file.jsonl", usage_offset: 0 })).toBe(false);
  });
});

/** The same priced line as `line()`, plus a subagent marker at the top level.
 *  Real agent transcript lines carry `isSidechain: true`; `agentId` is the other
 *  marker a fold would plausibly keep. */
const markedLine = (uuid: string, marker: Record<string, unknown>) =>
  JSON.stringify({
    uuid,
    timestamp: "2026-06-15T08:00:00.000Z",
    ...marker,
    message: { model: "claude-opus-4-8", usage: { input_tokens: 1_000_000, output_tokens: 0 } },
  }) + "\n";

describe("parseUsageLine sidechain markers", () => {
  it("flags isSidechain and agentId lines and leaves an ordinary line unflagged", () => {
    expect(parseUsageLine(line("p1"))!.sidechain).toBe(false);
    expect(parseUsageLine(markedLine("s1", { isSidechain: true }))!.sidechain).toBe(true);
    expect(parseUsageLine(markedLine("s2", { agentId: "a-1" }))!.sidechain).toBe(true);
  });
});

describe("takeUsage", () => {
  it("short-circuits when the file has not grown (no re-read of a multi-MB transcript)", () => {
    const dir = mkdtempSync(join(tmpdir(), "am-take-"));
    const file = join(dir, "t.jsonl");
    writeFileSync(file, line("m1"));
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", last_activity_at: 1 }, 1);

    const first = takeUsage(store, { path: file, offset: 0, sessionId: "s1" });
    expect(first.recorded).toBe(true);
    expect(first.offset).toBe(Buffer.byteLength(line("m1")));

    const second = takeUsage(store, { path: file, offset: first.offset, sessionId: "s1" });
    expect(second.recorded).toBe(false);
    expect(second.offset).toBe(first.offset);
  });

  it("stamps run_id/agent_id and attributes to the PARENT session's project/branch", () => {
    const dir = mkdtempSync(join(tmpdir(), "am-take-"));
    const file = join(dir, "agent-a1.jsonl");
    writeFileSync(file, line("w1"));
    const store = new Store(openDb(":memory:"));
    store.applyEvent("parent", { status: "working", project: "alpha", branch: "feat/x", last_activity_at: 1 }, 1);

    const r = takeUsage(store, { path: file, offset: 0, sessionId: "parent", runId: "wf_1", agentId: "a1" });
    expect(r.recorded).toBe(true);
    const row = store.db.query("SELECT run_id, agent_id, project, branch FROM usage WHERE message_uuid = 'w1'").get();
    expect(row).toEqual({ run_id: "wf_1", agent_id: "a1", project: "alpha", branch: "feat/x" });
  });

  it("is idempotent — re-reading from offset 0 records nothing new", () => {
    const dir = mkdtempSync(join(tmpdir(), "am-take-"));
    const file = join(dir, "t.jsonl");
    writeFileSync(file, line("m1") + line("m2"));
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", last_activity_at: 1 }, 1);
    takeUsage(store, { path: file, offset: 0, sessionId: "s1" });
    const again = takeUsage(store, { path: file, offset: 0, sessionId: "s1" });
    expect(again.recorded).toBe(false);
    expect(store.costSummary(0).perSession.s1.costUsd).toBeCloseTo(10, 6); // still 2 × $5
  });

  it("resets to 0 and re-reads when the file shrank below the stored offset", () => {
    const dir = mkdtempSync(join(tmpdir(), "am-take-"));
    const file = join(dir, "t.jsonl");
    writeFileSync(file, line("m1"));
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", last_activity_at: 1 }, 1);
    const r = takeUsage(store, { path: file, offset: 1_000_000, sessionId: "s1" });
    expect(r.recorded).toBe(true);
    expect(r.offset).toBe(Buffer.byteLength(line("m1")));
  });

  it("returns the caller's offset unchanged for a missing file", () => {
    const store = new Store(openDb(":memory:"));
    expect(takeUsage(store, { path: "/no/such/file.jsonl", offset: 7, sessionId: "s1" })).toEqual({
      offset: 7,
      recorded: false,
    });
  });

  it("skips sidechain / agent-marked lines on the PARENT path (double-count guard)", () => {
    const dir = mkdtempSync(join(tmpdir(), "am-take-"));
    const file = join(dir, "parent.jsonl");
    // A synthetic parent transcript: one ordinary assistant line plus two lines
    // folded in from subagents. No real parent transcript on this machine holds
    // such a line today — the guard exists so that if Claude Code ever starts
    // folding them in under FRESH uuids, the same spend is not counted twice
    // (once here, once from agent-*.jsonl).
    writeFileSync(file, line("p1") + markedLine("s1", { isSidechain: true }) + markedLine("s2", { agentId: "a-1" }));
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", last_activity_at: 1 }, 1);

    const r = takeUsage(store, { path: file, offset: 0, sessionId: "s1", skipSidechain: true });
    expect(r.recorded).toBe(true);
    expect(store.db.query("SELECT message_uuid FROM usage ORDER BY message_uuid").all()).toEqual([
      { message_uuid: "p1" },
    ]);
    // The offset still advances past every line — skipped, not deferred.
    expect(r.offset).toBe(Buffer.byteLength(readFileSync(file, "utf8")));
  });

  it("tailUsage passes the guard, so a session transcript never prices a folded agent line", () => {
    const dir = mkdtempSync(join(tmpdir(), "am-take-"));
    const file = join(dir, "parent.jsonl");
    writeFileSync(file, line("p1") + markedLine("s1", { isSidechain: true }));
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", last_activity_at: 1 }, 1);
    expect(tailUsage(store, { id: "s1", transcript_path: file, usage_offset: 0 })).toBe(true);
    expect(store.costSummary(0).perSession.s1.costUsd).toBeCloseTo(5, 6); // one line, not two
  });

  it("still records a marked line through the WORKFLOW path — every agent line is a sidechain (C3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "am-take-"));
    const file = join(dir, "agent-a1.jsonl");
    writeFileSync(file, markedLine("w1", { isSidechain: true }));
    const store = new Store(openDb(":memory:"));
    store.applyEvent("parent", { status: "working", project: "alpha", last_activity_at: 1 }, 1);
    // No skipSidechain here, deliberately: setting it would ingest nothing at all.
    const r = takeUsage(store, { path: file, offset: 0, sessionId: "parent", runId: "wf_1", agentId: "a1" });
    expect(r.recorded).toBe(true);
  });
});
