import { describe, it, expect } from "bun:test";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/server/store.ts";
import { openDb } from "../src/server/db.ts";
import {
  sessionDirFor,
  deriveRunState,
  parseManifest,
  parseJournal,
  parseAgentMeta,
  parseAgentHeader,
  parseScriptMeta,
  findScriptFile,
  findScriptAcrossSlugs,
  scanWorkflows,
  workflowsDegraded,
  resetDegraded,
  backfillWorkflows,
} from "../src/server/workflows.ts";
import { WF_QUIET_MS, WF_RECHECK_MS } from "../src/server/config.ts";

export const FIX = join(import.meta.dir, "fixtures", "workflows");
export const fixture = (name: string): string => readFileSync(join(FIX, name), "utf8");

describe("sessionDirFor", () => {
  it("strips the .jsonl suffix from a transcript path (C9, exact for 20/20 runs)", () => {
    expect(sessionDirFor("/home/u/.claude/projects/-slug/abc-123.jsonl")).toBe(
      "/home/u/.claude/projects/-slug/abc-123"
    );
  });
  it("leaves a path with no .jsonl suffix alone", () => {
    expect(sessionDirFor("/home/u/.claude/projects/-slug/abc-123")).toBe(
      "/home/u/.claude/projects/-slug/abc-123"
    );
  });
});

describe("deriveRunState", () => {
  const NOW = 1_800_000_000_000;
  const run = (over: Partial<Parameters<typeof deriveRunState>[0]> = {}) => ({
    manifest_seen: false,
    status: null,
    last_seen_at: NOW,
    session_status: "working",
    ...over,
  });

  it("stays running when a manifest exists but the dir is still moving (C6 regression)", () => {
    // wf_3b398ae6-146 had a `failed` manifest with agent files still appending
    // 6 minutes later. Sealing on manifest_seen would have lost that spend.
    expect(deriveRunState(run({ manifest_seen: true, status: "failed", last_seen_at: NOW - 1000 }), NOW)).toBe("running");
  });

  it("settles once a manifest exists and the dir has been quiet for WF_QUIET_MS", () => {
    expect(deriveRunState(run({ manifest_seen: true, last_seen_at: NOW - WF_QUIET_MS - 1 }), NOW)).toBe("settled");
  });

  it("un-settles when the dir mtime advances again", () => {
    expect(deriveRunState(run({ manifest_seen: true, last_seen_at: NOW }), NOW)).toBe("running");
  });

  it("reports orphaned for a quiet run with no manifest (hard-killed CLI writes none)", () => {
    expect(deriveRunState(run({ manifest_seen: false, last_seen_at: NOW - WF_QUIET_MS - 1 }), NOW)).toBe("orphaned");
  });

  it("reports orphaned when the owning session has ended, even if the dir just moved", () => {
    expect(deriveRunState(run({ session_status: "ended", last_seen_at: NOW }), NOW)).toBe("orphaned");
  });

  it("treats a never-seen run (null last_seen_at) as quiet", () => {
    expect(deriveRunState(run({ manifest_seen: true, last_seen_at: null }), NOW)).toBe("settled");
  });
});

describe("parseManifest", () => {
  it("reads the real manifest: status, times, phases, and 1-based indices", () => {
    const m = parseManifest(fixture("wf_eb7bf7e8-8a5.manifest.json"))!;
    expect(m.status).toBe("completed");
    expect(m.schema_ok).toBe(true);
    expect(typeof m.started_at).toBe("number"); // startTime is epoch ms
    expect(m.ended_at).toBe(Date.parse("2026-08-10T07:16:36.681Z")); // timestamp is ISO
    expect(m.phases.length).toBeGreaterThan(0);
    expect(m.phases[0].title).toBe("Explore");
    // index/phaseIndex are stored VERBATIM, 1-based — a phase pill reads
    // `Phase ${phaseIndex}/${phases.length}` with no arithmetic.
    expect(m.agents[0].idx).toBe(1);
    expect(m.agents[0].phase_index).toBe(1);
    expect(Math.max(...m.agents.map((a) => a.phase_index ?? 0))).toBe(m.phases.length);
  });

  it("filters workflowProgress to type === 'workflow_agent' (workflow_phase entries are dropped)", () => {
    const raw = JSON.parse(fixture("wf_eb7bf7e8-8a5.manifest.json"));
    const total = (raw.workflowProgress as any[]).length;
    const agents = (raw.workflowProgress as any[]).filter((e) => e?.type === "workflow_agent").length;
    expect(agents).toBeLessThan(total); // the fixture really does carry both types
    expect(parseManifest(fixture("wf_eb7bf7e8-8a5.manifest.json"))!.agents.length).toBe(agents);
  });

  it("returns null for a truncated manifest rather than throwing", () => {
    const half = fixture("wf_eb7bf7e8-8a5.manifest.json").slice(0, 400);
    expect(parseManifest(half)).toBeNull();
  });

  it("keeps status/duration/tokens when workflowProgress is missing, and flags schema_ok=0", () => {
    const raw = JSON.parse(fixture("wf_eb7bf7e8-8a5.manifest.json"));
    delete raw.workflowProgress;
    const m = parseManifest(JSON.stringify(raw))!;
    expect(m.status).toBe("completed");
    expect(m.duration_ms).toBe(raw.durationMs);
    expect(m.total_tokens_reported).toBe(raw.totalTokens);
    expect(m.agents).toEqual([]);
    expect(m.schema_ok).toBe(false);
    expect(m.error).toBe("manifest parsed 0 agents");
  });

  it("stores an unknown status string verbatim (C11: `failed` already broke the vocabulary)", () => {
    const raw = JSON.parse(fixture("wf_eb7bf7e8-8a5.manifest.json"));
    raw.status = "quantum-superposition";
    expect(parseManifest(JSON.stringify(raw))!.status).toBe("quantum-superposition");
  });

  it("survives a manifest whose agent entries are missing optional fields", () => {
    const raw = JSON.parse(fixture("wf_eb7bf7e8-8a5.manifest.json"));
    raw.workflowProgress = [{ type: "workflow_agent", agentId: "bare" }];
    const m = parseManifest(JSON.stringify(raw))!;
    expect(m.agents).toEqual([
      {
        agent_id: "bare", label: null, phase_index: null, phase_title: null, idx: null,
        model: null, state: null, attempt: null, last_tool: null, last_tool_summary: null,
        prompt_preview: null, started_at: null, duration_ms: null, tool_calls: null,
      },
    ]);
  });

  it("reads the 10-entry manifest of a run that has 13 agent transcripts", () => {
    const m = parseManifest(fixture("wf_57b2617f-124.manifest.json"))!;
    expect(m.agents.length).toBe(10);
    expect(m.agent_count).toBe(10);
    // attempt is 1 on every surveyed entry — display only, never retry detection.
    expect(m.agents.every((a) => a.attempt === 1 || a.attempt === null)).toBe(true);
  });
});

const jlines = (name: string) => fixture(name).split("\n").filter((l) => l.trim());

describe("parseJournal", () => {
  it("gives every key's winner a row; with a manifest present none are left running", () => {
    // wf_eb7bf7e8-8a5: 6 started / 3 result over 6 distinct keys. This run
    // COMPLETED — 3 keys never got a result line, so `started`-without-`result`
    // cannot mean running once a manifest exists (C7).
    const { agents } = parseJournal(jlines("wf_eb7bf7e8-8a5.journal.jsonl"), { manifestPresent: true });
    expect(agents.size).toBe(6);
    expect([...agents.values()].filter((a) => a.state === "running").length).toBe(0);
  });

  it("marks resultless winners running only when the manifest is absent", () => {
    const { agents } = parseJournal(jlines("wf_eb7bf7e8-8a5.journal.jsonl"), { manifestPresent: false });
    expect([...agents.values()].filter((a) => a.state === "running").length).toBe(3);
    expect([...agents.values()].filter((a) => a.state === "done").length).toBe(3);
  });

  it("dedupes retries: the last agentId per key in FILE ORDER wins, earlier ones are abandoned", () => {
    // wf_57b2617f-124: 13 started / 10 result over 10 keys → 10 winners + 3 abandoned.
    // A retry reuses the key with a FRESH agentId; `attempt` stays 1, so it is
    // never the retry signal.
    const { agents } = parseJournal(jlines("wf_57b2617f-124.journal.jsonl"), { manifestPresent: true });
    expect(agents.size).toBe(13); // every agentId keeps its own row so its tokens attribute
    expect([...agents.values()].filter((a) => a.state === "abandoned").length).toBe(3);
    expect([...agents.values()].filter((a) => a.state === "done").length).toBe(10);
    const keys = new Set([...agents.values()].map((a) => a.journal_key));
    expect(keys.size).toBe(10);
  });

  it("marks an unmatched started as running on a manifest-less live run", () => {
    // wf_de7ba892-786 was still live (unmatched started) when this plan was
    // authored; by fixture-capture time the real run had completed and every
    // key had a result line. Drop the final result line to reconstruct the
    // in-flight snapshot this test is meant to exercise, without hand-writing
    // synthetic journal content.
    const allLines = jlines("wf_de7ba892-786.journal.jsonl");
    const inFlight = allLines.slice(0, -1);
    const { agents } = parseJournal(inFlight, { manifestPresent: false });
    expect([...agents.values()].filter((a) => a.state === "running").length).toBeGreaterThan(0);
  });

  it("counts unknown line types and unparseable lines toward degraded, never throws", () => {
    const lines = [
      JSON.stringify({ type: "started", key: "k1", agentId: "a1" }),
      JSON.stringify({ type: "brand_new_type", key: "k1", agentId: "a1" }),
      "{not json",
    ];
    const { agents, unknownTypes } = parseJournal(lines, { manifestPresent: false });
    expect(unknownTypes).toBe(2);
    expect(agents.get("a1")!.state).toBe("running");
  });

  it("returns an empty map for an empty journal", () => {
    expect(parseJournal([], { manifestPresent: false }).agents.size).toBe(0);
  });
});

describe("parseAgentMeta", () => {
  it("reads the bare model alias from the 65-byte form", () => {
    const m = parseAgentMeta(fixture("agent-meta-with-model.json"));
    expect(m.agent_type).toBe("workflow-subagent");
    expect(typeof m.model).toBe("string"); // e.g. "sonnet" — canonicalModel() handles it
  });
  it("returns model: null for the 48-byte form (32 of 116 files omit it — not an edge case)", () => {
    expect(parseAgentMeta(fixture("agent-meta-no-model.json")).model).toBeNull();
  });
  it("returns nulls rather than throwing on malformed JSON", () => {
    expect(parseAgentMeta("{nope")).toEqual({ agent_type: null, model: null });
  });
});

describe("parseAgentHeader", () => {
  it("pulls cc_version, the first message.model, and a 160-char prompt preview", () => {
    const h = parseAgentHeader(fixture("agent-head.jsonl"));
    expect(h.cc_version).toMatch(/^\d+\.\d+\.\d+$/); // 2.1.226 on recent runs
    expect(h.model).toBe("claude-sonnet-5"); // first line carrying message.model
    expect(h.prompt_preview!.length).toBeLessThanOrEqual(160);
    expect(h.prompt_preview!.startsWith("Implement a bug fix")).toBe(true);
  });
  it("returns nulls for an empty or unparseable head", () => {
    expect(parseAgentHeader("")).toEqual({ cc_version: null, model: null, prompt_preview: null });
    expect(parseAgentHeader("{not json\n")).toEqual({ cc_version: null, model: null, prompt_preview: null });
  });
});

describe("parseScriptMeta", () => {
  it("extracts the workflow name and phase skeleton from the script source", () => {
    const s = parseScriptMeta(fixture("script-with-phases.js"));
    expect(s.name).toBe("workflows-monitoring-research");
    expect(s.phases).toEqual([{ title: "Explore", detail: "codebase map, docs research, on-disk artifacts" }]);
  });
  it("returns empty phases when the source has no meta block", () => {
    expect(parseScriptMeta("console.log('hi')")).toEqual({ name: null, phases: [] });
  });
});

describe("script lookup", () => {
  /** projects root ≙ ~/.claude/projects: <root>/<slug>/<sessionId>/workflows/scripts */
  function makeProjects(opts: { underOwnSlug?: boolean; underSibling?: boolean }) {
    const root = mkdtempSync(join(tmpdir(), "am-scripts-"));
    const own = join(root, "-home-u-repo", "sess-1");
    const sibling = join(root, "-home-u-repo-sub", "sess-1");
    mkdirSync(join(own, "workflows", "scripts"), { recursive: true });
    mkdirSync(join(sibling, "workflows", "scripts"), { recursive: true });
    if (opts.underOwnSlug) writeFileSync(join(own, "workflows", "scripts", "research-wf_1.js"), fixture("script-with-phases.js"));
    if (opts.underSibling) writeFileSync(join(sibling, "workflows", "scripts", "research-wf_1.js"), fixture("script-with-phases.js"));
    return { root, sessionDir: own };
  }

  it("finds the script under the session's own dir, matching by the -<runId>.js suffix", () => {
    const { sessionDir } = makeProjects({ underOwnSlug: true });
    expect(findScriptFile(sessionDir, "wf_1")).toBe(join(sessionDir, "workflows", "scripts", "research-wf_1.js"));
    expect(findScriptFile(sessionDir, "wf_other")).toBeNull(); // suffix match, never a prefix
  });

  it("returns null rather than throwing when the scripts dir does not exist", () => {
    expect(findScriptFile("/no/such/session", "wf_1")).toBeNull();
  });

  it("resolves a script parked under a SIBLING slug with the same sessionId (C9's 3 split runs)", () => {
    const { root, sessionDir } = makeProjects({ underSibling: true });
    expect(findScriptFile(sessionDir, "wf_1")).toBeNull(); // the primary lookup misses
    expect(findScriptAcrossSlugs(sessionDir, "wf_1")).toBe(
      join(root, "-home-u-repo-sub", "sess-1", "workflows", "scripts", "research-wf_1.js")
    );
  });

  it("returns null when no slug holds a script for that run (2 of 20 runs have none)", () => {
    const { sessionDir } = makeProjects({});
    expect(findScriptAcrossSlugs(sessionDir, "wf_1")).toBeNull();
  });

  it("never looks outside the projects root or at another sessionId", () => {
    const { root, sessionDir } = makeProjects({ underSibling: true });
    // Same runId, different session → not ours. The glob is pinned to both.
    mkdirSync(join(root, "-home-u-other", "sess-2", "workflows", "scripts"), { recursive: true });
    writeFileSync(join(root, "-home-u-other", "sess-2", "workflows", "scripts", "research-wf_9.js"), "x");
    expect(findScriptAcrossSlugs(sessionDir, "wf_9")).toBeNull();
  });
});

const NOW = 1_800_000_000_000;

/** One priced transcript line: 1M input tokens of opus-5 = exactly $5. */
function agentLine(uuid: string) {
  return (
    JSON.stringify({
      uuid,
      sessionId: "parent",
      isSidechain: true,
      version: "2.1.226",
      timestamp: "2026-08-10T09:00:00.000Z",
      message: { model: "claude-opus-5", content: "do the thing", usage: { input_tokens: 1_000_000, output_tokens: 0 } },
    }) + "\n"
  );
}

/** Lay out a projects root, a session dir and a run dir exactly as Claude Code
 *  does, in a temp tree: <root>/<slug>/<sessionId>/subagents/workflows/wf_t1.
 *  The slug level is load-bearing — findScriptAcrossSlugs derives the projects
 *  root as <sessionDir>/../.., so the whole cross-slug search stays inside `root`
 *  and never touches ~/.claude. `siblingScripts` is C9's split: a SECOND slug
 *  holding the same sessionId, where the run's script sometimes lives. */
function makeRun(opts: { agents: string[]; journal?: string; manifest?: string; siblingScript?: string }) {
  const root = mkdtempSync(join(tmpdir(), "am-wf-"));           // ≙ ~/.claude/projects
  const sessionDir = join(root, "-slug-a", "parent");
  const transcript = join(root, "-slug-a", "parent.jsonl");
  const runDir = join(sessionDir, "subagents", "workflows", "wf_t1");
  const siblingScripts = join(root, "-slug-b", "parent", "workflows", "scripts");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(sessionDir, "workflows"), { recursive: true });
  writeFileSync(transcript, ""); // the parent transcript
  opts.agents.forEach((id, i) => {
    writeFileSync(join(runDir, `agent-${id}.jsonl`), agentLine(`u-${i}`));
    writeFileSync(join(runDir, `agent-${id}.meta.json`), JSON.stringify({ agentType: "workflow-subagent", spawnDepth: 1 }));
  });
  if (opts.journal) writeFileSync(join(runDir, "journal.jsonl"), opts.journal);
  if (opts.manifest) writeFileSync(join(sessionDir, "workflows", "wf_t1.json"), opts.manifest);
  if (opts.siblingScript) {
    mkdirSync(siblingScripts, { recursive: true });
    writeFileSync(join(siblingScripts, "research-wf_t1.js"), opts.siblingScript);
  }

  const store = new Store(openDb(":memory:"));
  store.applyEvent(
    "parent",
    { status: "working", project: "alpha", branch: "feat/x", transcript_path: transcript, last_activity_at: 1 },
    1
  );
  return { store, root, sessionDir, runDir, siblingScripts };
}

/** Force a directory's mtime, so liveness tests don't depend on wall-clock timing. */
const setMtime = (p: string, ms: number) => utimesSync(p, ms / 1000, ms / 1000);

describe("scanWorkflows", () => {
  it("tails every agent transcript against the PARENT session, stamping run_id/agent_id", () => {
    const { store } = makeRun({ agents: ["a1", "a2"] });
    expect(scanWorkflows(store, NOW).changed).toBe(true);
    const rows = store.db
      .query("SELECT run_id, agent_id, project, branch, cost_usd FROM usage ORDER BY agent_id")
      .all() as any[];
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual({ run_id: "wf_t1", agent_id: "a1", project: "alpha", branch: "feat/x", cost_usd: 5 });
    // The keystone: parent attribution means no `unknown` bucket appears.
    expect(store.costByProject()).toEqual([{ project: "alpha", costUsd: 10, tokens: 2_000_000 }]);
  });

  it("creates one agent row per transcript file even when the manifest lists fewer", () => {
    // The real 10-entry manifest against the real 13-agentId journal: keying off
    // the manifest would lose 3 agents' tokens.
    const journal = fixture("wf_57b2617f-124.journal.jsonl");
    const ids = [...new Set(journal.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l).agentId))] as string[];
    expect(ids.length).toBe(13);
    const { store } = makeRun({ agents: ids, journal, manifest: fixture("wf_57b2617f-124.manifest.json") });
    scanWorkflows(store, NOW);
    const n = store.db.query("SELECT COUNT(*) AS c FROM workflow_agents WHERE run_id='wf_t1'").get() as { c: number };
    expect(n.c).toBe(13);
    const abandoned = store.db
      .query("SELECT COUNT(*) AS c FROM workflow_agents WHERE run_id='wf_t1' AND state='abandoned'")
      .get() as { c: number };
    expect(abandoned.c).toBe(3);
  });

  it("reports changed: false on a tick where nothing moved", () => {
    const { store, runDir } = makeRun({ agents: ["a1"], manifest: fixture("wf_eb7bf7e8-8a5.manifest.json") });
    setMtime(runDir, NOW - 60 * 60 * 1000);
    expect(scanWorkflows(store, NOW).changed).toBe(true); // first sight
    expect(scanWorkflows(store, NOW).changed).toBe(false); // pure re-stat
  });

  it("un-settles when an agent file grows without any dir-mtime change (rule 3's hedge)", () => {
    const { store, runDir } = makeRun({ agents: ["a1"], manifest: fixture("wf_eb7bf7e8-8a5.manifest.json") });
    const quiet = NOW - 60 * 60 * 1000;
    setMtime(runDir, quiet);
    scanWorkflows(store, NOW);
    expect(scanWorkflows(store, NOW).changed).toBe(false);

    appendFileSync(join(runDir, "agent-a1.jsonl"), agentLine("u-late"));
    setMtime(runDir, quiet); // appending to a file does NOT touch the dir mtime
    expect(scanWorkflows(store, NOW).changed).toBe(true);
    const total = store.db.query("SELECT COUNT(*) AS c FROM usage").get() as { c: number };
    expect(total.c).toBe(2);
  });

  it("keeps tailing after a manifest appears — a manifest is terminal for STRUCTURE only (C6)", () => {
    const { store, sessionDir, runDir } = makeRun({ agents: ["a1"] });
    setMtime(runDir, NOW - 60 * 60 * 1000);
    scanWorkflows(store, NOW);
    expect(store.getWorkflowRun("wf_t1")!.manifest_seen).toBe(0);

    // The manifest lives OUTSIDE the run dir, so its arrival never bumps the run
    // dir's mtime — the scan must stat it explicitly or the run never enriches.
    writeFileSync(join(sessionDir, "workflows", "wf_t1.json"), fixture("wf_eb7bf7e8-8a5.manifest.json"));
    setMtime(runDir, NOW - 60 * 60 * 1000);
    expect(scanWorkflows(store, NOW).changed).toBe(true);
    expect(store.getWorkflowRun("wf_t1")!.manifest_seen).toBe(1);
    expect(store.getWorkflowRun("wf_t1")!.status).toBe("completed");

    // …and six minutes of appends AFTER the manifest still cost money.
    appendFileSync(join(runDir, "agent-a1.jsonl"), agentLine("u-after-manifest"));
    setMtime(runDir, NOW - 60 * 60 * 1000);
    scanWorkflows(store, NOW);
    const total = store.db.query("SELECT COUNT(*) AS c FROM usage").get() as { c: number };
    expect(total.c).toBe(2);
  });

  it("re-parses a manifest rewritten IN PLACE, which never moves the run dir (C6)", () => {
    // wf_3b398ae6-146's manifest read `failed` at 09:27:58 and was rewritten to
    // `completed` at 09:41:16. The manifest lives outside the run dir, so neither
    // last_seen_at nor any agent file changes — manifest_mtime is the only signal.
    const done = fixture("wf_eb7bf7e8-8a5.manifest.json");
    const failed = JSON.stringify({ ...JSON.parse(done), status: "failed" });
    const { store, sessionDir, runDir } = makeRun({ agents: ["a1"], manifest: failed });
    const manifestPath = join(sessionDir, "workflows", "wf_t1.json");
    const quiet = NOW - 60 * 60 * 1000;
    setMtime(manifestPath, NOW - 10_000);
    setMtime(runDir, quiet);
    scanWorkflows(store, NOW);
    expect(store.getWorkflowRun("wf_t1")!.status).toBe("failed");
    expect(scanWorkflows(store, NOW).changed).toBe(false); // nothing moved

    writeFileSync(manifestPath, done); // the rewrite
    setMtime(manifestPath, NOW - 5_000); // strictly later than the stored mtime
    setMtime(runDir, quiet); // …and the run dir is untouched, as on disk
    expect(scanWorkflows(store, NOW).changed).toBe(true);
    expect(store.getWorkflowRun("wf_t1")!.status).toBe("completed");
  });

  it("resolves phase titles from a SIBLING project slug at discovery (C9's 3 split runs)", () => {
    const { store } = makeRun({ agents: ["a1"], siblingScript: fixture("script-with-phases.js") });
    scanWorkflows(store, NOW);
    const row = store.db.query("SELECT name, phases FROM workflow_runs WHERE run_id='wf_t1'").get() as any;
    expect(row.name).toBe("workflows-monitoring-research");
    expect(JSON.parse(row.phases).length).toBeGreaterThan(0);
  });

  it("never re-runs the cross-slug lookup after discovery — it is a discovery-time cost only", () => {
    const { store, runDir, siblingScripts } = makeRun({ agents: ["a1"] });
    scanWorkflows(store, NOW); // discovery: no script under either slug yet
    expect((store.db.query("SELECT name FROM workflow_runs WHERE run_id='wf_t1'").get() as any).name).toBeNull();

    mkdirSync(siblingScripts, { recursive: true });
    writeFileSync(join(siblingScripts, "research-wf_t1.js"), fixture("script-with-phases.js"));
    appendFileSync(join(runDir, "agent-a1.jsonl"), agentLine("u-late")); // force a full re-parse
    scanWorkflows(store, NOW);
    // Still null: the 5s tick only ever reads <sessionDir>/workflows/scripts.
    expect((store.db.query("SELECT name FROM workflow_runs WHERE run_id='wf_t1'").get() as any).name).toBeNull();
  });

  it("does not touch a settled run older than WF_RECHECK_MS", () => {
    resetDegraded();
    const { store, runDir, root } = makeRun({ agents: ["a1"], manifest: fixture("wf_eb7bf7e8-8a5.manifest.json") });
    setMtime(runDir, NOW - WF_RECHECK_MS - 60_000);
    scanWorkflows(store, NOW);
    store.applyEvent("parent", { status: "ended", last_activity_at: 1 }, 1); // off the discovery list
    rmSync(root, { recursive: true, force: true }); // any stat would now throw
    expect(scanWorkflows(store, NOW).changed).toBe(false);
    expect(workflowsDegraded()).toBe(0); // proves the dir was never stat'd
  });

  it("survives a truncated manifest with schema_ok=0 and an error, still tailing cost", () => {
    resetDegraded();
    const { store } = makeRun({
      agents: ["a1"],
      manifest: fixture("wf_eb7bf7e8-8a5.manifest.json").slice(0, 400),
    });
    scanWorkflows(store, NOW);
    const row = store.db.query("SELECT schema_ok, error FROM workflow_runs WHERE run_id='wf_t1'").get() as any;
    expect(row.schema_ok).toBe(0);
    expect(row.error).toContain("manifest");
    // resetDegraded() above also clears logOnce's key memory — the counter is
    // gated on logOnce returning true, and every test here reuses run id wf_t1.
    expect(workflowsDegraded()).toBe(1); // once per run per cause, not once per tick
    scanWorkflows(store, NOW);
    expect(workflowsDegraded()).toBe(1); // a second tick over the same broken manifest adds nothing
    const total = store.db.query("SELECT COUNT(*) AS c FROM usage").get() as { c: number };
    expect(total.c).toBe(1); // cost is the durable half — it survives structure breaking
  });
});

describe("backfillWorkflows", () => {
  /** ~/.claude/projects/<slug>/<sessionId>/subagents/workflows/wf_* */
  function makeTree() {
    const root = mkdtempSync(join(tmpdir(), "am-bf-"));
    const sessionDir = join(root, "-home-u-repo", "sess-1");
    const runDir = join(sessionDir, "subagents", "workflows", "wf_old");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "agent-a1.jsonl"), agentLine("bf-1"));
    return { root, runDir };
  }

  it("finds run dirs by path structure and resolves the session from the dir's third parent", () => {
    const { root } = makeTree();
    const store = new Store(openDb(":memory:"));
    // The session exists but its transcript_path points somewhere else entirely —
    // resolution must come from the run dir's own path, not string-matching.
    store.applyEvent("sess-1", { status: "ended", project: "repo", branch: "main", transcript_path: "/elsewhere/x.jsonl", last_activity_at: 1 }, 1);

    expect(backfillWorkflows(store, NOW, root).runs).toBe(1);
    const row = store.db.query("SELECT run_id, session_id, project FROM workflow_runs").get();
    expect(row).toEqual({ run_id: "wf_old", session_id: "sess-1", project: "repo" });
    const usage = store.db.query("SELECT session_id, run_id, project FROM usage").get();
    expect(usage).toEqual({ session_id: "sess-1", run_id: "wf_old", project: "repo" });
  });

  it("still ingests a run whose session row is missing, bucketing it under unknown", () => {
    const { root } = makeTree();
    const store = new Store(openDb(":memory:"));
    expect(backfillWorkflows(store, NOW, root).runs).toBe(1);
    // Skipping it would silently drop spend — the one thing this feature exists
    // to prevent. The existing queries already bucket a NULL project as 'unknown'.
    expect(store.costByProject()).toEqual([{ project: "unknown", costUsd: 5, tokens: 1_000_000 }]);
  });

  it("is idempotent — a second backfill records nothing new", () => {
    const { root } = makeTree();
    const store = new Store(openDb(":memory:"));
    backfillWorkflows(store, NOW, root);
    backfillWorkflows(store, NOW, root);
    const n = store.db.query("SELECT COUNT(*) AS c FROM usage").get() as { c: number };
    expect(n.c).toBe(1);
  });

  it("returns 0 runs for a root that does not exist", () => {
    const store = new Store(openDb(":memory:"));
    expect(backfillWorkflows(store, NOW, "/no/such/root").runs).toBe(0);
  });
});
