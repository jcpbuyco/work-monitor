import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import {
  parseCodexChunk,
  tailCodexUsage,
  backfillCodexSessions,
} from "../src/server/harness/codex-usage.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "codex");

function fixtureLines(name: string): string[] {
  return readFileSync(join(FIXTURES, name), "utf8").split("\n").filter((l) => l.trim());
}

describe("parseCodexChunk (§4.4, table-tested on real captured rollouts)", () => {
  it("pre-0.153 (cli 0.104, no token_usage_record line type at all): prices both real calls", () => {
    const { usage, lastModel } = parseCodexChunk(fixtureLines("pre-0.153-rollout.jsonl"), "s1", null);
    expect(usage).toHaveLength(1); // one non-null-info token_count line
    expect(usage[0]).toEqual({
      model: "gpt-5.3-codex",
      tokens: { input: 13438 - 7296, output: 137, cache_read: 7296, cache_create_5m: 0, cache_create_1h: 0 },
      at: Date.parse("2026-02-20T09:32:42.509Z"),
      messageKey: "codex:s1:13575",
    });
    expect(lastModel).toBe("gpt-5.3-codex");
  });

  it("skips the null-info token_count line (no completed API call yet)", () => {
    const { usage } = parseCodexChunk(
      ['{"type":"event_msg","payload":{"type":"token_count","info":null}}'],
      "s1",
      null
    );
    expect(usage).toEqual([]);
  });

  it("0.156 (has token_usage_record + world_state): prices both calls from event_msg alone, ignoring token_usage_record", () => {
    const { usage, lastModel } = parseCodexChunk(fixtureLines("0.156-rollout.jsonl"), "s1", null);
    expect(usage).toHaveLength(2);
    expect(usage[0]).toEqual({
      model: "gpt-5.5",
      tokens: { input: 13206 - 1408, output: 33, cache_read: 1408, cache_create_5m: 0, cache_create_1h: 0 },
      at: Date.parse("2026-09-25T04:53:37.169Z"),
      messageKey: "codex:s1:13239",
    });
    expect(usage[1]).toEqual({
      model: "gpt-5.5",
      tokens: { input: 13287 - 12672, output: 5, cache_read: 12672, cache_create_5m: 0, cache_create_1h: 0 },
      at: Date.parse("2026-09-25T04:53:39.140Z"),
      messageKey: "codex:s1:26531", // cumulative total, distinct from the previous call's
    });
    expect(lastModel).toBe("gpt-5.5");
  });

  it("prices at the fallback model until a turn_context is seen in this chunk", () => {
    const { usage } = parseCodexChunk(
      ['{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":100},"last_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10}}}}'],
      "s1",
      "gpt-5.5"
    );
    expect(usage[0].model).toBe("gpt-5.5");
  });

  it("model falls back to 'unknown' with no turn_context ever seen and no fallback given", () => {
    const { usage } = parseCodexChunk(
      ['{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":100},"last_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10}}}}'],
      "s1",
      null
    );
    expect(usage[0].model).toBe("unknown");
  });

  it("degrades gracefully on an unparseable line instead of throwing", () => {
    expect(parseCodexChunk(["not json"], "s1", null).usage).toEqual([]);
  });

  it("a repeated (identical cumulative total) token_count line collapses to the same message_key", () => {
    const line =
      '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":500},"last_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10}}}}';
    const { usage } = parseCodexChunk([line, line], "s1", null);
    expect(usage[0].messageKey).toBe(usage[1].messageKey);
  });

  it("extracts the first user message from a pre-0.153 rollout (direct event_msg/user_message)", () => {
    const { firstUserMessage } = parseCodexChunk(fixtureLines("pre-0.153-rollout.jsonl"), "s1", null);
    expect(firstUserMessage).toBe("add a retry to the payment webhook handler");
  });

  it("extracts the first user message from a 0.156 rollout (nested event_msg/item_completed/UserMessage)", () => {
    const { firstUserMessage } = parseCodexChunk(fixtureLines("0.156-rollout.jsonl"), "s1", null);
    expect(firstUserMessage).toBe("add a retry to the payment webhook handler");
  });

  it("firstUserMessage is null with no user_message/UserMessage event in the chunk", () => {
    const { firstUserMessage } = parseCodexChunk(
      ['{"type":"event_msg","payload":{"type":"token_count","info":null}}'],
      "s1",
      null
    );
    expect(firstUserMessage).toBeNull();
  });

  it("ignores a 0.156 item_completed for a non-UserMessage item (e.g. AgentMessage)", () => {
    const { firstUserMessage } = parseCodexChunk(
      ['{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","content":[{"type":"Text","text":"done"}]}}}'],
      "s1",
      null
    );
    expect(firstUserMessage).toBeNull();
  });
});

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function freshRollout(name: string): string {
  dir = mkdtempSync(join(tmpdir(), "am-codex-rollout-"));
  const dest = join(dir, "rollout.jsonl");
  writeFileSync(dest, readFileSync(join(FIXTURES, name), "utf8"));
  return dest;
}

describe("tailCodexUsage (§4.4 live per-session tail)", () => {
  it("records priced usage rows tagged harness=codex and advances the offset", () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", harness: "codex", last_activity_at: 1 }, 1);
    const path = freshRollout("0.156-rollout.jsonl");
    const recorded = tailCodexUsage(store, { path, offset: 0, sessionId: "s1", fallbackModel: null });
    expect(recorded).toBe(true);
    const rows = store.db.query("SELECT model, harness, output_tokens FROM usage ORDER BY at").all();
    expect(rows).toEqual([
      { model: "gpt-5.5", harness: "codex", output_tokens: 33 },
      { model: "gpt-5.5", harness: "codex", output_tokens: 5 },
    ]);
  });

  it("stamps harness_version from the rollout's own session_meta on the first tail (offset 0)", () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", harness: "codex", last_activity_at: 1 }, 1);
    const path = freshRollout("0.156-rollout.jsonl");
    tailCodexUsage(store, { path, offset: 0, sessionId: "s1", fallbackModel: null });
    expect(store.getSession("s1")!.harness_version).toBe("0.156.1");
  });

  it("does not re-read session_meta on a later tail (offset > 0)", () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", harness: "codex", harness_version: "already-set", last_activity_at: 1 }, 1);
    const path = freshRollout("0.156-rollout.jsonl");
    tailCodexUsage(store, { path, offset: 100, sessionId: "s1", fallbackModel: null });
    expect(store.getSession("s1")!.harness_version).toBe("already-set");
  });

  it("is idempotent on a re-tail with nothing new", () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", harness: "codex", last_activity_at: 1 }, 1);
    const path = freshRollout("0.156-rollout.jsonl");
    tailCodexUsage(store, { path, offset: 0, sessionId: "s1", fallbackModel: null });
    const again = tailCodexUsage(store, { path, offset: 0, sessionId: "s1", fallbackModel: null });
    expect(again).toBe(false); // same bytes re-read from 0, but message_key dedupe makes it a no-op write
    const count = store.db.query("SELECT COUNT(*) AS c FROM usage").get() as { c: number };
    expect(count.c).toBe(2); // not 4
  });
});

describe("backfillCodexSessions (§4.4 startup backfill, injectable root)", () => {
  function writeRollout(root: string, subpath: string, fixture: string): string {
    const full = join(root, subpath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, readFileSync(join(FIXTURES, fixture), "utf8"));
    return full;
  }

  it("upserts an ended session row and ingests usage for a discovered rollout", async () => {
    const store = new Store(openDb(":memory:"));
    const root = mkdtempSync(join(tmpdir(), "am-codex-sessions-"));
    dir = root;
    const path = writeRollout(root, "2026/09/25/rollout-2026-09-25T04-53-31-01a0d6e9.jsonl", "0.156-rollout.jsonl");

    const r = await backfillCodexSessions(store, 1_700_000_000_000, root);
    expect(r.scanned).toBe(1);
    expect(r.sessionsUpserted).toBe(1);
    expect(r.recorded).toBe(2);

    const session = store.getSession("01a0d6e9-56f7-7131-b578-26c543558c6f")!;
    expect(session.harness).toBe("codex");
    expect(session.status).toBe("ended");
    expect(session.model).toBe("gpt-5.5");
    expect(session.harness_version).toBe("0.156.1");
    expect(session.started_at).toBe(Date.parse("2026-09-25T04:53:31.590Z")); // the rollout LINE's own envelope timestamp
    expect(session.ended_at).toBe(Date.parse("2026-09-25T04:53:40.200Z"));
    // A backfilled session has no hook-delivered prompt/transcript_path event
    // to get these from otherwise -- both must come from the rollout itself.
    expect(session.transcript_path).toBe(path);
    expect(session.current_intent).toBe("add a retry to the payment webhook handler");

    const usageRows = store.db.query("SELECT COUNT(*) AS c FROM usage WHERE session_id = $s").get({ $s: session.id }) as {
      c: number;
    };
    expect(usageRows.c).toBe(2);
  });

  it("resumes correctly after a partial trailing line: nothing is lost once the line completes", async () => {
    const store = new Store(openDb(":memory:"));
    const root = mkdtempSync(join(tmpdir(), "am-codex-sessions-"));
    dir = root;
    const full = writeRollout(root, "2026/09/25/rollout-partial.jsonl", "0.156-rollout.jsonl");
    const complete = readFileSync(full, "utf8");
    const lines = complete.split("\n").filter((l) => l.trim());
    // Cut the file off partway through its SECOND token_count line, as if the
    // writer was interrupted mid-flush.
    const secondTokenCountLine = lines[lines.length - 2];
    const cutPoint = complete.indexOf(secondTokenCountLine) + 40;
    writeFileSync(full, complete.slice(0, cutPoint));

    const first = await backfillCodexSessions(store, 1_700_000_000_000, root);
    expect(first.recorded).toBe(1); // only the first (complete) token_count line

    // The writer finishes flushing the rest of the file.
    writeFileSync(full, complete);
    const second = await backfillCodexSessions(store, 1_700_000_000_001, root);
    expect(second.recorded).toBe(1); // the previously-partial line, now complete -- not lost

    const count = store.db.query("SELECT COUNT(*) AS c FROM usage").get() as { c: number };
    expect(count.c).toBe(2); // both calls priced, none double-counted
  });

  it("does not re-scan an unchanged file across boots even when it ends on a trailing partial line", async () => {
    const store = new Store(openDb(":memory:"));
    const root = mkdtempSync(join(tmpdir(), "am-codex-sessions-"));
    dir = root;
    const full = writeRollout(root, "2026/09/25/rollout-partial2.jsonl", "0.156-rollout.jsonl");
    const complete = readFileSync(full, "utf8");
    const lines = complete.split("\n").filter((l) => l.trim());
    const secondTokenCountLine = lines[lines.length - 2];
    const cutPoint = complete.indexOf(secondTokenCountLine) + 40;
    writeFileSync(full, complete.slice(0, cutPoint));

    await backfillCodexSessions(store, 1_700_000_000_000, root);
    // Nothing written to the file between these two passes.
    const again = await backfillCodexSessions(store, 1_700_000_000_001, root);
    expect(again.scanned).toBe(1);
    expect(again.recorded).toBe(0); // unchanged (mtime+size match) -- skipped, not re-scanned
  });

  it("advances ended_at/last_activity_at for an already-ended (backfilled) session whose rollout grows further", async () => {
    const store = new Store(openDb(":memory:"));
    const root = mkdtempSync(join(tmpdir(), "am-codex-sessions-"));
    dir = root;
    const full = writeRollout(root, "2026/09/25/rollout-grows.jsonl", "0.156-rollout.jsonl");
    const complete = readFileSync(full, "utf8");
    const withoutLastLine = complete.split("\n").filter((l) => l.trim()).slice(0, -1).join("\n") + "\n";
    writeFileSync(full, withoutLastLine);

    const first = await backfillCodexSessions(store, 1_700_000_000_000, root);
    expect(first.sessionsUpserted).toBe(1);
    const before = store.getSession("01a0d6e9-56f7-7131-b578-26c543558c6f")!;
    expect(before.status).toBe("ended");
    expect(before.ended_at).toBeLessThan(Date.parse("2026-09-25T04:53:40.200Z"));

    // The rollout gains its final line on a later boot (a delayed flush).
    writeFileSync(full, complete);
    await backfillCodexSessions(store, 1_700_000_000_001, root);
    const after = store.getSession("01a0d6e9-56f7-7131-b578-26c543558c6f")!;
    expect(after.status).toBe("ended"); // still ended -- only the timestamps advance
    expect(after.ended_at).toBe(Date.parse("2026-09-25T04:53:40.200Z"));
    expect(after.last_activity_at).toBe(Date.parse("2026-09-25T04:53:40.200Z"));
  });

  it("skips a subagent rollout entirely (thread_source === 'subagent'), but counts it instead of silently dropping it", async () => {
    const store = new Store(openDb(":memory:"));
    const root = mkdtempSync(join(tmpdir(), "am-codex-sessions-"));
    dir = root;
    writeRollout(root, "2026/09/25/rollout-2026-09-25T04-53-41-sub.jsonl", "subagent-rollout.jsonl");

    const r = await backfillCodexSessions(store, 1_700_000_000_000, root);
    expect(r.sessionsUpserted).toBe(0);
    expect(r.skippedSubagentRollouts).toBe(1); // a known gap (§4.4 non-goal) -- surfaced, not silent
    expect(store.getSession("01a0d6ef-487f-74c0-b197-50faf0c9eb9e")).toBeNull();
  });

  it("does not keep re-reading a skipped subagent rollout on every later boot", async () => {
    const store = new Store(openDb(":memory:"));
    const root = mkdtempSync(join(tmpdir(), "am-codex-sessions-"));
    dir = root;
    writeRollout(root, "2026/09/25/rollout-2026-09-25T04-53-41-sub.jsonl", "subagent-rollout.jsonl");

    await backfillCodexSessions(store, 1_700_000_000_000, root);
    const again = await backfillCodexSessions(store, 1_700_000_000_001, root);
    expect(again.scanned).toBe(1); // the file is still found by the walk...
    expect(again.skippedSubagentRollouts).toBe(0); // ...but its marker short-circuits any actual re-read
  });

  it("is idempotent: a second pass with nothing changed on disk records nothing new", async () => {
    const store = new Store(openDb(":memory:"));
    const root = mkdtempSync(join(tmpdir(), "am-codex-sessions-"));
    dir = root;
    writeRollout(root, "2026/09/25/rollout-x.jsonl", "0.156-rollout.jsonl");

    await backfillCodexSessions(store, 1_700_000_000_000, root);
    const again = await backfillCodexSessions(store, 1_700_000_000_001, root);
    expect(again.recorded).toBe(0);
    expect(again.sessionsUpserted).toBe(0);
    const count = store.db.query("SELECT COUNT(*) AS c FROM usage").get() as { c: number };
    expect(count.c).toBe(2);
  });

  it("never downgrades a session that already has a live row (status/timestamps untouched)", async () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent(
      "01a0d6e9-56f7-7131-b578-26c543558c6f",
      { status: "working", harness: "codex", project: "already-resolved", last_activity_at: 500 },
      500
    );
    const root = mkdtempSync(join(tmpdir(), "am-codex-sessions-"));
    dir = root;
    writeRollout(root, "2026/09/25/rollout-x.jsonl", "0.156-rollout.jsonl");

    await backfillCodexSessions(store, 1_700_000_000_000, root);
    const session = store.getSession("01a0d6e9-56f7-7131-b578-26c543558c6f")!;
    expect(session.status).toBe("working"); // not overwritten to "ended"
    expect(session.started_at).toBe(500); // untouched
    expect(session.project).toBe("already-resolved");
    expect(session.model).toBe("gpt-5.5"); // still enriched from the rollout's own turn_context
  });

  it("degrades gracefully (no throw) when the root directory does not exist", async () => {
    const store = new Store(openDb(":memory:"));
    const r = await backfillCodexSessions(store, 1000, "/no/such/codex/sessions/root");
    expect(r).toEqual({ scanned: 0, sessionsUpserted: 0, recorded: 0, skippedSubagentRollouts: 0 });
  });
});
