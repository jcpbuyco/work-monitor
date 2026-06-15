import { describe, it, expect } from "bun:test";
import { parseUsageLine, tailUsage } from "../src/server/usage.ts";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import { writeFileSync, appendFileSync, mkdtempSync } from "node:fs";
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
