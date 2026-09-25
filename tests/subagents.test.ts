import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import {
  parseSubagentMeta,
  listSubagentFiles,
  discoverSubagents,
  tailSubagents,
  sweepSubagents,
  backfillSubagents,
} from "../src/server/subagents.ts";

function line(uuid: string, model = "claude-sonnet-5", output = 20) {
  return (
    JSON.stringify({
      uuid,
      isSidechain: true,
      timestamp: "2026-08-01T08:00:00.000Z",
      message: { model, usage: { input_tokens: 100, output_tokens: output } },
    }) + "\n"
  );
}

function makeSessionDir(): string {
  return mkdtempSync(join(tmpdir(), "am-subagents-"));
}

function writeSubagent(
  sessionDir: string,
  agentId: string,
  opts: { meta?: object; lines?: string } = {}
): { jsonl: string; meta: string } {
  const dir = join(sessionDir, "subagents");
  mkdirSync(dir, { recursive: true });
  const jsonl = join(dir, `agent-${agentId}.jsonl`);
  const meta = join(dir, `agent-${agentId}.meta.json`);
  writeFileSync(jsonl, opts.lines ?? line(`${agentId}-u1`));
  writeFileSync(
    meta,
    JSON.stringify(opts.meta ?? { agentType: "general-purpose", description: "explore the repo", model: "sonnet" })
  );
  return { jsonl, meta };
}

describe("parseSubagentMeta", () => {
  it("reads agentType, description, model, and parentAgentId", () => {
    const m = parseSubagentMeta(
      JSON.stringify({ agentType: "general-purpose", description: "explore", model: "sonnet", parentAgentId: "p1", toolUseId: "t1", spawnDepth: 1 })
    );
    expect(m).toEqual({ agent_type: "general-purpose", description: "explore", model: "sonnet", parent_agent_id: "p1" });
  });

  it("degrades to all-null on invalid JSON instead of throwing", () => {
    expect(parseSubagentMeta("{not json")).toEqual({ agent_type: null, description: null, model: null, parent_agent_id: null });
  });

  it("defaults a missing parentAgentId to null (top-level, non-nested agent)", () => {
    const m = parseSubagentMeta(JSON.stringify({ agentType: "Explore", model: "opus" }));
    expect(m.parent_agent_id).toBeNull();
  });
});

describe("listSubagentFiles", () => {
  it("lists agent-<id>.jsonl files under <sessionDir>/subagents", () => {
    const dir = makeSessionDir();
    writeSubagent(dir, "a1");
    writeSubagent(dir, "a2");
    const files = listSubagentFiles(dir).map((f) => f.agentId).sort();
    expect(files).toEqual(["a1", "a2"]);
  });

  it("excludes the workflows/ subdirectory (workflow agents are ingested separately)", () => {
    const dir = makeSessionDir();
    writeSubagent(dir, "a1");
    mkdirSync(join(dir, "subagents", "workflows"), { recursive: true });
    writeFileSync(join(dir, "subagents", "workflows", "wf_stray.json"), "{}");
    expect(listSubagentFiles(dir).map((f) => f.agentId)).toEqual(["a1"]);
  });

  it("returns empty for a session with no subagents directory", () => {
    expect(listSubagentFiles(makeSessionDir())).toEqual([]);
  });
});

describe("discoverSubagents", () => {
  it("registers a new subagent file with its meta fields", () => {
    const store = new Store(openDb(":memory:"));
    const dir = makeSessionDir();
    writeSubagent(dir, "a1", { meta: { agentType: "general-purpose", description: "map the codebase", model: "sonnet", parentAgentId: null } });
    const n = discoverSubagents(store, "parent", dir, 1000);
    expect(n).toBe(1);
    const rows = store.subagentsForSession("parent");
    expect(rows).toEqual([
      { agent_id: "a1", path: join(dir, "subagents", "agent-a1.jsonl"), offset: 0, model: "sonnet", model_resolved: false },
    ]);
  });

  it("stamps started_at from the transcript's own first-line timestamp, not discovery time", () => {
    const store = new Store(openDb(":memory:"));
    const dir = makeSessionDir();
    // line()'s default timestamp is 2026-08-01T08:00:00.000Z -- discovery
    // happens "now" (a much later, unrelated instant) so a pass just stores
    // the wall clock, this must not.
    writeSubagent(dir, "a1");
    discoverSubagents(store, "parent", dir, Date.parse("2026-09-25T12:00:00.000Z"));
    const row = store.db.query("SELECT started_at FROM subagents WHERE agent_id = 'a1'").get() as { started_at: number };
    expect(row.started_at).toBe(Date.parse("2026-08-01T08:00:00.000Z"));
  });

  it("does not re-register (or reset) an already-known agent id", () => {
    const store = new Store(openDb(":memory:"));
    const dir = makeSessionDir();
    writeSubagent(dir, "a1");
    discoverSubagents(store, "parent", dir, 1000);
    store.setSubagentTail("a1", 500, 2000, "claude-sonnet-5"); // simulate progress
    const n = discoverSubagents(store, "parent", dir, 3000); // re-scan, nothing new on disk
    expect(n).toBe(0);
    expect(store.subagentsForSession("parent")[0].offset).toBe(500); // untouched, not reset to 0
  });
});

describe("tailSubagents", () => {
  it("records usage from a sidechain-marked subagent line and persists the offset", () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("parent", { status: "working", project: "alpha", last_activity_at: 1 }, 1);
    const dir = makeSessionDir();
    writeSubagent(dir, "a1");
    discoverSubagents(store, "parent", dir, 1000);

    const changed = tailSubagents(store, "parent", 2000);
    expect(changed).toBe(true);
    const row = store.db.query("SELECT session_id, agent_id, project FROM usage").get();
    expect(row).toEqual({ session_id: "parent", agent_id: "a1", project: "alpha" });
    expect(store.subagentsForSession("parent")[0].offset).toBeGreaterThan(0);
  });

  it("resolves model from the transcript's own message.model on first successful tail, overriding the meta alias", () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("parent", { status: "working", last_activity_at: 1 }, 1);
    const dir = makeSessionDir();
    // meta says the bare alias "sonnet"; the transcript resolves to a concrete id.
    writeSubagent(dir, "a1", { meta: { agentType: "general-purpose", model: "sonnet" }, lines: line("u1", "claude-sonnet-4-6") });
    discoverSubagents(store, "parent", dir, 1000);
    expect(store.subagentsForSession("parent")[0].model).toBe("sonnet"); // alias, before any tail

    tailSubagents(store, "parent", 2000);
    expect(store.subagentsForSession("parent")[0].model).toBe("claude-sonnet-4-6"); // resolved, overriding the alias
  });

  it("is idempotent -- a second tail with nothing new records nothing and does not clobber the resolved model", () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("parent", { status: "working", last_activity_at: 1 }, 1);
    const dir = makeSessionDir();
    writeSubagent(dir, "a1", { lines: line("u1", "claude-sonnet-4-6") });
    discoverSubagents(store, "parent", dir, 1000);
    tailSubagents(store, "parent", 2000);
    const again = tailSubagents(store, "parent", 3000);
    expect(again).toBe(false);
    expect(store.subagentsForSession("parent")[0].model).toBe("claude-sonnet-4-6");
  });

  it("resolves the model on a LATER tail when an earlier tail advanced the offset without recording (finding: prompt-first discovery)", () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("parent", { status: "working", last_activity_at: 1 }, 1);
    const dir = makeSessionDir();
    // The file starts with just the user prompt line (no message.usage) --
    // real subagent files often look like this in the sweep window right
    // after the Task tool spawns them, before their first API call returns.
    const promptOnly =
      JSON.stringify({ uuid: "u0", type: "user", timestamp: "2026-08-01T08:00:00.000Z", message: { role: "user", content: "go" } }) + "\n";
    const { jsonl } = writeSubagent(dir, "a1", { meta: { agentType: "general-purpose", model: "sonnet" }, lines: promptOnly });
    discoverSubagents(store, "parent", dir, 1000);

    // First sweep: only the prompt line exists on disk -- the offset advances
    // past it, but nothing is recorded (no usage on a user-prompt line).
    expect(tailSubagents(store, "parent", 2000)).toBe(false);
    expect(store.subagentsForSession("parent")[0].model).toBe("sonnet"); // still the meta alias
    expect(store.subagentsForSession("parent")[0].model_resolved).toBe(false);

    // The subagent's first API call lands after that sweep window.
    appendFileSync(jsonl, line("u1", "claude-sonnet-4-6"));
    expect(tailSubagents(store, "parent", 3000)).toBe(true);
    expect(store.subagentsForSession("parent")[0].model).toBe("claude-sonnet-4-6"); // resolved, not stuck on the alias
    expect(store.subagentsForSession("parent")[0].model_resolved).toBe(true);
  });

  it("dedupes a multi-block message via message_key, so a re-tail after a restart is safe", () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("parent", { status: "working", last_activity_at: 1 }, 1);
    const dir = makeSessionDir();
    const multi = JSON.stringify({
      uuid: "b1", isSidechain: true, timestamp: "2026-08-01T08:00:00.000Z", requestId: "req_1",
      message: { id: "msg_1", model: "claude-sonnet-5", usage: { input_tokens: 5, output_tokens: 2 } },
    }) + "\n" + JSON.stringify({
      uuid: "b2", isSidechain: true, timestamp: "2026-08-01T08:00:01.000Z", requestId: "req_1",
      message: { id: "msg_1", model: "claude-sonnet-5", usage: { input_tokens: 5, output_tokens: 40 } },
    }) + "\n";
    writeSubagent(dir, "a1", { lines: multi });
    discoverSubagents(store, "parent", dir, 1000);
    tailSubagents(store, "parent", 2000);
    const rows = store.db.query("SELECT output_tokens FROM usage").all();
    expect(rows).toEqual([{ output_tokens: 40 }]); // one row, not two
  });
});

describe("sweepSubagents", () => {
  it("discovers a brand-new subagent file and tails it in the same pass", () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("parent", { status: "working", last_activity_at: 1 }, 1);
    const dir = makeSessionDir();
    writeSubagent(dir, "a1");
    expect(sweepSubagents(store, "parent", dir, 1000)).toBe(true);
    expect(store.db.query("SELECT COUNT(*) AS c FROM usage").get()).toEqual({ c: 1 });
  });
});

describe("backfillSubagents", () => {
  it("ingests subagents for every session already in the store, including ended ones", () => {
    const store = new Store(openDb(":memory:"));
    const dir = makeSessionDir();
    writeSubagent(dir, "a1");
    store.applyEvent("s1", { status: "ended", project: "alpha", transcript_path: dir + ".jsonl", last_activity_at: 1 }, 1);
    const r = backfillSubagents(store, 1000, "/no/such/root");
    expect(r.discovered).toBe(1);
    expect(store.db.query("SELECT COUNT(*) AS c FROM usage").get()).toEqual({ c: 1 });
  });

  it("globs unknown sessions on disk (no row in the store at all) via the root fallback", () => {
    const store = new Store(openDb(":memory:"));
    const root = mkdtempSync(join(tmpdir(), "am-projects-"));
    const sessionDir = join(root, "-slug-a", "orphan-session");
    mkdirSync(sessionDir, { recursive: true });
    writeSubagent(sessionDir, "a1");
    const r = backfillSubagents(store, 1000, root);
    expect(r.discovered).toBe(1);
    const row = store.db.query("SELECT session_id FROM usage").get() as { session_id: string };
    expect(row.session_id).toBe("orphan-session");
  });

  it("never double-registers a session covered by both the store loop and the glob", () => {
    const store = new Store(openDb(":memory:"));
    const root = mkdtempSync(join(tmpdir(), "am-projects-"));
    const sessionDir = join(root, "-slug-a", "s1");
    mkdirSync(sessionDir, { recursive: true });
    writeSubagent(sessionDir, "a1");
    store.applyEvent("s1", { status: "working", transcript_path: sessionDir + ".jsonl", last_activity_at: 1 }, 1);
    const r = backfillSubagents(store, 1000, root);
    expect(r.discovered).toBe(1); // not counted twice
    expect(store.db.query("SELECT COUNT(*) AS c FROM subagents").get()).toEqual({ c: 1 });
  });
});
