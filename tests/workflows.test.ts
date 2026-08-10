import { describe, it, expect } from "bun:test";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  utimesSync,
  rmSync,
  chmodSync,
} from "node:fs";
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
  workflowTick,
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
  it("resolves model from an agent transcript header via the REAL scan path, even when it starts past 8KB (finding 4)", () => {
    // agent-head.jsonl is a real (anonymized) transcript: message.model doesn't
    // appear until byte 22,544 — the first three lines (user + two attachments)
    // alone run past a fixed 8KB header window. The agent's meta.json (written
    // by makeRun) carries no model, so this is the fallback path the fixture
    // for parseAgentHeader alone doesn't exercise (that test feeds the parser
    // the whole file directly; this one goes through the scanner's real
    // bounded read).
    const { store, runDir } = makeRun({ agents: ["a1"] });
    writeFileSync(join(runDir, "agent-a1.jsonl"), fixture("agent-head.jsonl"));
    scanWorkflows(store, NOW);
    const row = store.db
      .query("SELECT model FROM workflow_agents WHERE run_id='wf_t1' AND agent_id='a1'")
      .get() as { model: string | null };
    expect(row.model).toBe("claude-sonnet-5");
  });

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

  it("un-settles the DERIVED STATE, not just the scanner's re-scan, when a file grows without a dir-mtime change (finding 3 redo)", () => {
    // Spec §1.4 (redo wording): last_seen_at is dir mtime OR the newest mtime
    // among the run's agent-*.jsonl/journal files — pure disk truth. `grew`
    // forces scanRun to keep tailing (asserted above), but last_seen_at (what
    // deriveRunState actually reads) must also reflect that motion via the
    // FILE's own mtime, or the run keeps reading "settled" and vanishes from
    // liveWorkflows() while it is still spending. The appended file's mtime is
    // set EXPLICITLY here (not left to appendFileSync's real wall-clock
    // stamp): NOW is a fixed fictitious future timestamp, so a genuinely
    // "just now" real mtime would itself read as ancient disk history and the
    // test would falsely pass/fail independent of the fix.
    const { store, runDir } = makeRun({ agents: ["a1"], manifest: fixture("wf_eb7bf7e8-8a5.manifest.json") });
    const agentPath = join(runDir, "agent-a1.jsonl");
    const quiet = NOW - 60 * 60 * 1000;
    setMtime(runDir, quiet);
    setMtime(agentPath, quiet);
    scanWorkflows(store, NOW); // discovery: manifest present + stale dir+file ⇒ settles immediately
    expect(store.liveWorkflows(NOW)).toEqual([]);

    appendFileSync(agentPath, agentLine("u-late"));
    setMtime(agentPath, NOW); // the append IS the disk-truth motion (rule 3's hedge)
    setMtime(runDir, quiet); // the dir itself is never touched, exactly as on disk
    scanWorkflows(store, NOW);
    const live = store.liveWorkflows(NOW);
    expect(live.map((w) => w.run_id)).toContain("wf_t1");
    expect(live.find((w) => w.run_id === "wf_t1")?.state).toBe("running");
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

  it("logs a SECOND, unrelated failure cause on the same run rather than swallowing it (finding 8)", () => {
    // The manifest-parse-failure key (workflows.ts's line ~577) and the
    // thrown-scan-error key (scanWorkflows' catch) both used the BARE run id,
    // so whichever cause hit first permanently suppressed logOnce — and hence
    // bumpDegraded() — for the other, for the rest of the process lifetime.
    resetDegraded();
    const { store, runDir } = makeRun({
      agents: ["a1"],
      manifest: fixture("wf_eb7bf7e8-8a5.manifest.json").slice(0, 400), // truncated -> parse failure
    });
    // Pin the dir mtime relative to NOW (matching every other test's pattern)
    // so the run stays inside the 24h WF_RECHECK_MS window across the 20
    // ticks below — real wall-clock mtime would otherwise already be "older"
    // than NOW - WF_RECHECK_MS, since NOW is a fixed fictitious timestamp.
    setMtime(runDir, NOW - 1000);
    scanWorkflows(store, NOW); // cause 1: manifest parse failure
    expect(workflowsDegraded()).toBe(1);

    rmSync(runDir, { recursive: true, force: true }); // cause 2: statSync(t.dir) now throws every tick
    let tick = NOW;
    for (let i = 0; i < 20; i++) {
      tick += 5_000;
      scanWorkflows(store, tick);
    }
    expect(workflowsDegraded()).toBe(2); // a genuinely different cause must still get its own bump
  });

  it("converges to changed=false on a manifest that exists but never parses (no 5s re-scan loop)", () => {
    resetDegraded();
    const { store } = makeRun({
      agents: ["a1"],
      manifest: fixture("wf_eb7bf7e8-8a5.manifest.json").slice(0, 400),
    });
    scanWorkflows(store, NOW); // discovery: full parse attempt, mtime stored despite the parse failure
    scanWorkflows(store, NOW + 5_000);
    // Steady state: the unparseable manifest must not count as "new" forever,
    // or Step 4 would broadcast an SSE event every 5s until the run dir ages out.
    expect(scanWorkflows(store, NOW + 10_000).changed).toBe(false);
    // Extend across several more ticks. The broadcast-level guarantee is pinned
    // separately by the workflowTick counting-stub tests; this covers the scan layer.
    expect(scanWorkflows(store, NOW + 15_000).changed).toBe(false);
    expect(scanWorkflows(store, NOW + 20_000).changed).toBe(false);
  });

  it("evaluates the §5.8 no-tokens cross-check for a run discovered while ACTIVE, not just a backfilled one (findings 5 & 7)", () => {
    // No agent-*.jsonl files at all — stands in for a Claude Code format break
    // (e.g. a transcript filename convention change AGENT_RE misses); either
    // way the effect is the same, zero usage rows despite a manifest reporting
    // real tokens burned.
    resetDegraded();
    const manifestRaw = JSON.parse(fixture("wf_eb7bf7e8-8a5.manifest.json"));
    expect(manifestRaw.totalTokens).toBeGreaterThan(0); // sanity: fixture really reports tokens
    const { store, runDir } = makeRun({ agents: [], manifest: fixture("wf_eb7bf7e8-8a5.manifest.json") });
    const recent = NOW - 1000;
    setMtime(runDir, recent);
    scanWorkflows(store, NOW); // discovered while ACTIVE: manifest lands, dir just moved
    expect(workflowsDegraded()).toBe(0); // not quiet yet — no false positive while legitimately ahead
    const usageRows = store.db.query("SELECT COUNT(*) AS c FROM usage WHERE run_id='wf_t1'").get() as { c: number };
    expect(usageRows.c).toBe(0);

    // WF_QUIET_MS elapses with nothing on disk moving — exactly the tick the
    // cheap-re-stat early return would otherwise always take, skipping the one
    // check §5 has for silently-wrong cost.
    const later = NOW + WF_QUIET_MS + 5_000;
    scanWorkflows(store, later);
    expect(workflowsDegraded()).toBe(1);
  });
});

describe("scanWorkflows + liveWorkflows (Minor A: live is no longer scanWorkflows's concern)", () => {
  it("scanWorkflows returns changed only — the live payload is NOT computed or returned here", () => {
    const { store, runDir } = makeRun({ agents: ["a1"] });
    setMtime(runDir, NOW - 1000);
    const first = scanWorkflows(store, NOW);
    expect(first).toEqual({ changed: true }); // no `live` key at all
    // The same data is still reachable — just via store.liveWorkflows(), which is
    // the one place that pays for it (and only workflowTick calls it, on change).
    const live = store.liveWorkflows(NOW);
    expect(live.map((w) => w.run_id)).toEqual(["wf_t1"]);
    expect(live[0].costUsd).toBeCloseTo(5, 6);
    expect(live[0].agents[0].agent_id).toBe("a1");
  });

  it("store.liveWorkflows() returns empty once every run has settled", () => {
    const { store, runDir } = makeRun({ agents: ["a1"], manifest: fixture("wf_eb7bf7e8-8a5.manifest.json") });
    setMtime(runDir, NOW - 60 * 60 * 1000);
    scanWorkflows(store, NOW);
    const again = scanWorkflows(store, NOW);
    expect(again.changed).toBe(false);
    expect(store.liveWorkflows(NOW)).toEqual([]);
  });

  it("excludes a settled run in SQL, never paying to hydrate it (finding 6)", () => {
    // liveWorkflows() must not select every row in the 24h WF_RECHECK_MS window
    // and filter settled ones out in JS afterward — that pays the per-agent
    // usage rollup, workflow_agents fetch and sessions scan for rows that get
    // thrown away. The settled predicate belongs in the WHERE clause.
    const { store, runDir } = makeRun({ agents: ["a1"], manifest: fixture("wf_eb7bf7e8-8a5.manifest.json") });
    setMtime(runDir, NOW - 60 * 60 * 1000);
    scanWorkflows(store, NOW);
    expect(store.liveWorkflows(NOW)).toEqual([]); // sanity: it really is settled

    let queryCount = 0;
    const origQuery = store.db.query.bind(store.db);
    (store.db as unknown as { query: typeof store.db.query }).query = ((sql: string) => {
      queryCount++;
      return origQuery(sql);
    }) as typeof store.db.query;
    try {
      store.liveWorkflows(NOW);
    } finally {
      store.db.query = origQuery;
    }
    // Before the fix: workflow_runs SELECT + usage rollup + workflow_agents +
    // sessions — four queries paid for a run that gets discarded by a JS
    // `.filter()`. After: the settled run never leaves the WHERE clause, so
    // hydrateWorkflowRuns short-circuits on an empty row set and only the
    // first query ever runs.
    expect(queryCount).toBe(1);
  });
});

describe("workflowTick (the gate that used to live, untested, at index.ts:76)", () => {
  /** A counting stub — the whole point is a hub typed structurally off nothing
   *  but `broadcast(event, payload)`, so no SseHub/server/HTTP is needed to prove
   *  the gate. */
  function countingHub() {
    const calls: { event: string; payload: unknown }[] = [];
    return {
      calls,
      broadcast(event: string, payload: unknown) {
        calls.push({ event, payload });
      },
    };
  }

  it("broadcasts on the discovery tick(s) only, then ZERO more over a permanently-corrupt manifest", () => {
    resetDegraded();
    const { store } = makeRun({
      agents: ["a1"],
      // Truncated JSON never parses — parseManifest returns null every pass, so
      // this run can never reach schema_ok and never stops being "new" in the
      // one way that matters: it must still converge to changed=false (see the
      // "converges to changed=false" scanWorkflows test above for the same fixture).
      manifest: fixture("wf_eb7bf7e8-8a5.manifest.json").slice(0, 400),
    });
    const hub = countingHub();

    workflowTick(store, hub, NOW); // discovery: run + manifest are new
    const afterDiscovery = hub.calls.length;
    expect(afterDiscovery).toBeGreaterThan(0); // the discovery tick DID broadcast

    workflowTick(store, hub, NOW + 5_000);
    workflowTick(store, hub, NOW + 10_000);
    workflowTick(store, hub, NOW + 15_000);
    // Three more ticks over a manifest that never stops being corrupt: not one
    // additional broadcast. An unconditional `hub.broadcast(...)` on every tick
    // would fail this assertion while still passing every other test in the file.
    expect(hub.calls.length).toBe(afterDiscovery);
  });

  it("broadcasts exactly once for a tick where usage was genuinely appended to a transcript", () => {
    const { store, runDir } = makeRun({ agents: ["a1"], manifest: fixture("wf_eb7bf7e8-8a5.manifest.json") });
    // Kept RECENT (not quiet) throughout, deliberately — a settled run is
    // filtered out of liveWorkflows() entirely (by design: the strip shows only
    // unsettled runs), which would make the payload assertion below vacuous.
    // Recency is what keeps this run "running" so the broadcast payload actually
    // carries it.
    const recent = NOW - 1000;
    setMtime(runDir, recent);
    workflowTick(store, countingHub(), NOW); // discovery, off to the side

    const hub = countingHub();
    workflowTick(store, hub, NOW); // pure re-stat: nothing moved
    expect(hub.calls.length).toBe(0);

    appendFileSync(join(runDir, "agent-a1.jsonl"), agentLine("u-late"));
    setMtime(runDir, recent); // an append never touches the dir mtime (rule 3's hedge)
    workflowTick(store, hub, NOW);
    expect(hub.calls.length).toBe(1);
    expect(hub.calls[0].event).toBe("workflows");
    const payload = hub.calls[0].payload as { run_id: string }[];
    expect(payload.map((w) => w.run_id)).toContain("wf_t1");
  });

  it("broadcasts a running->settled transition caused purely by the passage of time (findings 1&2)", () => {
    // Nothing on disk ever moves again after discovery — dir mtime, manifest
    // mtime and every agent file stay exactly as they were — but WF_QUIET_MS of
    // wall-clock time passes. deriveRunState flips the run to "settled" at READ
    // time; the client must be told, or the board shows a finished run forever.
    const { store, runDir } = makeRun({ agents: ["a1"], manifest: fixture("wf_eb7bf7e8-8a5.manifest.json") });
    const recent = NOW - 1000;
    setMtime(runDir, recent);
    const hub = countingHub();
    workflowTick(store, hub, NOW); // discovery
    expect(hub.calls.length).toBe(1);
    const first = hub.calls[0].payload as { run_id: string; state: string }[];
    expect(first.find((w) => w.run_id === "wf_t1")?.state).toBe("running");

    const later = NOW + WF_QUIET_MS + 5_000;
    workflowTick(store, hub, later); // pure clock advance, nothing on disk moved
    expect(hub.calls.length).toBe(2);
    const second = hub.calls[1].payload as { run_id: string; state: string }[];
    expect(second.map((w) => w.run_id)).not.toContain("wf_t1"); // settled runs drop out
  });

  it("broadcasts a running->orphaned transition caused purely by the passage of time (findings 1&2)", () => {
    // Same defect, manifest-less case: the run never disappears (liveWorkflows
    // keeps orphans visible) but the client's copy must stop reading "running".
    const { store, runDir } = makeRun({ agents: ["a1"] }); // no manifest
    const recent = NOW - 1000;
    setMtime(runDir, recent);
    const hub = countingHub();
    workflowTick(store, hub, NOW); // discovery
    expect(hub.calls.length).toBe(1);
    const first = hub.calls[0].payload as { run_id: string; state: string }[];
    expect(first.find((w) => w.run_id === "wf_t1")?.state).toBe("running");

    const later = NOW + WF_QUIET_MS + 5_000;
    workflowTick(store, hub, later); // pure clock advance, nothing on disk moved
    expect(hub.calls.length).toBe(2);
    const second = hub.calls[1].payload as { run_id: string; state: string }[];
    expect(second.find((w) => w.run_id === "wf_t1")?.state).toBe("orphaned");
  });

  // --- finding-3 REDO: three rejection timelines from the adversarial re-verify
  // of cb071f9 (existingAgentGrew / effectiveLastSeenAt). last_seen_at must be
  // pure disk truth (dir mtime OR the newest mtime among the run's
  // agent-*.jsonl/journal files) — never a fabricated `now` reading — and the
  // scanner's in-pass state cache must derive from that SAME value, never from
  // the raw dir mtime alone.

  it("growth un-settles once, then only a REAL quiet period settles — not a stale-dir false alarm (finding-3 redo, timeline 1)", () => {
    // An ordinary long-running workflow: its run DIR is touched once, at
    // creation, and never again — only the agent transcript's mtime moves as
    // it grows (rule 3). `born` stands in for "long enough ago that the dir's
    // OWN mtime alone already reads as quiet", which is true of any workflow
    // that has been running for longer than WF_QUIET_MS.
    const { store, runDir } = makeRun({ agents: ["a1"], manifest: fixture("wf_eb7bf7e8-8a5.manifest.json") });
    const agentPath = join(runDir, "agent-a1.jsonl");
    const born = NOW - 2 * WF_QUIET_MS;
    setMtime(runDir, born);
    setMtime(agentPath, born);
    const hub = countingHub();
    workflowTick(store, hub, NOW); // discovery: dir AND file already old ⇒ settles immediately
    expect(hub.calls.length).toBe(1);
    expect(store.liveWorkflows(NOW)).toEqual([]); // sanity: really settled at discovery

    // A real append: the agent file's mtime moves to NOW (disk truth) while
    // the run DIR's mtime is left exactly where it was — an append to an
    // already-tracked transcript never bumps the dir (rule 3's hedge).
    appendFileSync(agentPath, agentLine("u-grow"));
    setMtime(agentPath, NOW);
    setMtime(runDir, born); // dir stays put, exactly as on disk
    workflowTick(store, hub, NOW);
    expect(hub.calls.length).toBe(2); // un-settle: real usage landed AND the state flipped back to running
    const grown = hub.calls[1].payload as { run_id: string; state: string }[];
    expect(grown.find((w) => w.run_id === "wf_t1")?.state).toBe("running");

    // Walk the clock forward in ordinary 5s ticks with NOTHING further
    // touched on disk. The rejected fix broadcast a premature "settled"
    // transition on the very NEXT tick — 5s after growth, nowhere near a real
    // quiet window — because its state cache read the raw, permanently-stale
    // dir mtime while the value actually persisted (and later read by
    // liveWorkflows) was something else entirely; having flipped once, the
    // cache then never noticed the REAL settle at WF_QUIET_MS either. A
    // correct implementation must not broadcast again until a genuine
    // WF_QUIET_MS has elapsed since the growth.
    let tick = NOW;
    let firstBroadcastElapsed: number | null = null;
    while (tick < NOW + WF_QUIET_MS + 10_000) {
      tick += 5_000;
      const before = hub.calls.length;
      workflowTick(store, hub, tick);
      if (hub.calls.length !== before && firstBroadcastElapsed === null) firstBroadcastElapsed = tick - NOW;
    }
    expect(firstBroadcastElapsed).not.toBeNull();
    expect(firstBroadcastElapsed!).toBeGreaterThanOrEqual(WF_QUIET_MS); // not a moment sooner
    expect(hub.calls.length).toBe(3); // exactly one settle broadcast across the whole walk
    const settled = hub.calls[2].payload as { run_id: string }[];
    expect(settled.map((w) => w.run_id)).not.toContain("wf_t1"); // settled runs drop out of the live strip

    // Further ticks over the same, now-frozen disk state: silence.
    workflowTick(store, hub, tick + 5_000);
    workflowTick(store, hub, tick + 10_000);
    expect(hub.calls.length).toBe(3);
  });

  it("per-tick non-usage growth keeps the run running without rebroadcasting an unchanged payload (finding-3 redo, timeline 2)", () => {
    // Regression measured against the rejected fix: 19 identical-payload
    // broadcasts over 20 ticks, caused by the scanner's pre-pass state check
    // reading the raw dir mtime (permanently stale for an ordinary
    // long-running workflow — see timeline 1) while the value actually
    // persisted read something else entirely. Disk-truth last_seen_at
    // genuinely advances every tick here (each append moves the agent file's
    // real mtime) — the run must stay "running" throughout — but since
    // neither the cost nor the truly derived state ever changes after the
    // initial un-settle, none of the remaining ticks may broadcast.
    const { store, runDir } = makeRun({ agents: ["a1"], manifest: fixture("wf_eb7bf7e8-8a5.manifest.json") });
    const agentPath = join(runDir, "agent-a1.jsonl");
    const born = NOW - 2 * WF_QUIET_MS; // dir touched once, long ago (rule 3)
    setMtime(runDir, born);
    setMtime(agentPath, born);
    const hub = countingHub();
    workflowTick(store, hub, NOW); // discovery: already quiet from a standing start ⇒ settled
    expect(hub.calls.length).toBe(1);

    let tick = NOW;
    for (let i = 0; i < 20; i++) {
      tick += 5_000;
      // A complete line with no `message.usage` — parseUsageLine() prices
      // nothing, so takeUsage() advances the offset but never records.
      appendFileSync(agentPath, JSON.stringify({ uuid: `heartbeat-${i}`, type: "tool_result" }) + "\n");
      setMtime(agentPath, tick); // disk truth: this file really was touched now
      setMtime(runDir, born); // the dir itself is never touched by an append (rule 3)
      workflowTick(store, hub, tick);
    }
    expect(hub.calls.length).toBe(2); // one un-settle broadcast (tick 1), then dead silence for 19 more
    expect(store.liveWorkflows(tick).find((w) => w.run_id === "wf_t1")?.state).toBe("running");
  });

  it("a transcript with a permanently incomplete final line settles once and goes silent, despite size > offset forever (finding-3 redo, timeline 3)", () => {
    // Regression measured against the rejected fix: existingAgentGrew stayed
    // true forever (size > offset never resolves for an unterminated final
    // line), so the run never settled — 132 broadcasts and a phantom
    // "running" card pinned indefinitely.
    const { store, runDir } = makeRun({ agents: ["a1"], manifest: fixture("wf_eb7bf7e8-8a5.manifest.json") });
    const agentPath = join(runDir, "agent-a1.jsonl");
    setMtime(runDir, NOW);
    setMtime(agentPath, NOW);
    const hub = countingHub();
    workflowTick(store, hub, NOW); // discovery: running, the one complete line fully consumed
    expect(hub.calls.length).toBe(1);

    // The write that never finishes: appended WITHOUT a trailing newline, so
    // takeUsage's search for a complete line never succeeds — size grows past
    // the stored offset, but the offset can never advance past it. Disk truth
    // exactly as it happens for real: a process that dies or stalls mid-write.
    appendFileSync(agentPath, JSON.stringify({ uuid: "partial", message: { model: "claude-opus-5" } })); // no trailing "\n"
    const wroteAt = NOW + 5_000;
    setMtime(agentPath, wroteAt); // this is the LAST time the file is ever touched
    setMtime(runDir, NOW); // the dir itself never moves (rule 3)
    workflowTick(store, hub, wroteAt);
    expect(hub.calls.length).toBe(1); // not yet quiet, nothing new recorded, no transition

    // WF_QUIET_MS elapses with the file's mtime FROZEN at `wroteAt` (no
    // further writes, ever) — the run must settle exactly once...
    const settleTick = wroteAt + WF_QUIET_MS + 5_000;
    workflowTick(store, hub, settleTick);
    expect(hub.calls.length).toBe(2);
    const settled = hub.calls[1].payload as { run_id: string }[];
    expect(settled.map((w) => w.run_id)).not.toContain("wf_t1");

    // ...and NEVER un-settle again: size > offset holds forever (the offset
    // can never advance past an unterminated final line), but that must never
    // be read as liveness. 20 more ticks, dead silent.
    let tick = settleTick;
    for (let i = 0; i < 20; i++) {
      tick += 5_000;
      workflowTick(store, hub, tick);
    }
    expect(hub.calls.length).toBe(2); // no phantom "running" card, no broadcast storm
  });

  // --- the two defects the re-verify of 38c81b9 rejected. Both come from the
  // same root cause: the full-pass decision and the broadcast decision hung off
  // signals OTHER than "did the disk move" / "did the payload change", so each
  // could disagree with the disk (and with each other).

  it("a manifest that parsed once and then becomes unreadable never re-triggers a full pass or a broadcast (rejection defect i)", () => {
    resetDegraded();
    const { store, runDir, sessionDir } = makeRun({
      agents: ["a1"],
      manifest: fixture("wf_eb7bf7e8-8a5.manifest.json"),
    });
    const manifestPath = join(sessionDir, "workflows", "wf_t1.json");
    const agentPath = join(runDir, "agent-a1.jsonl");
    const born = NOW - 2 * WF_QUIET_MS; // quiet from a standing start
    setMtime(runDir, born);
    setMtime(agentPath, born);
    setMtime(manifestPath, born);
    const hub = countingHub();
    workflowTick(store, hub, NOW); // discovery: manifest parses, run is settled
    expect(hub.calls.length).toBe(1);
    expect(store.getWorkflowRun("wf_t1")!.manifest_seen).toBe(1);

    // The manifest is still THERE — statSync succeeds and its mtime never moves
    // — but it can no longer be READ (a permission flip, a half-replaced file,
    // an FS hiccup). Nothing about the RUN changed: it is quiet, settled, and
    // must stay that way. `!!manifest` (this pass's parse result) is now false
    // while the PERSISTED manifest_seen is still 1, and only the persisted one
    // may feed state.
    chmodSync(manifestPath, 0o000);

    let fullPasses = 0;
    const upsert = store.upsertWorkflowRun.bind(store);
    store.upsertWorkflowRun = (r) => {
      fullPasses++;
      upsert(r);
    };

    // One full pass is legitimately still owed: the §5.8 cross-check gets a
    // single forced pass when a tracked run first reads settled. It must
    // consume that shot HERE, on its one attempt, even though the manifest it
    // wanted to read is unreadable — otherwise it re-forces a pass forever.
    workflowTick(store, hub, NOW + 5_000);
    expect(fullPasses).toBe(1);
    const degradedAfterOneShot = workflowsDegraded();
    expect(degradedAfterOneShot).toBeGreaterThan(0); // the skip IS reported...

    // ...and then nothing, ever again: no full pass, no broadcast, no degraded
    // bump, and no flip-flop between "settled" (persisted manifest_seen) and
    // "orphaned" (this pass's failed read).
    let tick = NOW + 5_000;
    for (let i = 0; i < 25; i++) {
      tick += 5_000;
      workflowTick(store, hub, tick);
    }
    expect(fullPasses).toBe(1);
    expect(hub.calls.length).toBe(1);
    expect(workflowsDegraded()).toBe(degradedAfterOneShot); // once per run, not per tick
    expect(store.getWorkflowRun("wf_t1")!.manifest_seen).toBe(1); // sticky
    expect(store.liveWorkflows(tick)).toEqual([]); // still settled, never orphaned
    chmodSync(manifestPath, 0o600); // leave the temp tree removable
  });

  it("a journal-only append triggers a full pass, ingests the new agent, advances last_seen_at, and broadcasts exactly once (rejection defect ii)", () => {
    const jline = (o: Record<string, string>) => JSON.stringify(o) + "\n";
    const { store, runDir } = makeRun({
      agents: ["a1"],
      journal:
        jline({ type: "started", key: "v2:k1", agentId: "a1" }) +
        jline({ type: "result", key: "v2:k1", agentId: "a1" }),
    });
    const journalPath = join(runDir, "journal.jsonl");
    const agentPath = join(runDir, "agent-a1.jsonl");
    const t0 = NOW - 1_000; // recent: the run is genuinely live
    setMtime(runDir, t0);
    setMtime(agentPath, t0);
    setMtime(journalPath, t0);

    const hub = countingHub();
    workflowTick(store, hub, NOW); // discovery
    expect(hub.calls.length).toBe(1);
    expect(store.getWorkflowRun("wf_t1")!.last_seen_at).toBe(t0);

    workflowTick(store, hub, NOW + 5_000); // nothing moved
    expect(hub.calls.length).toBe(1);

    // The workflow spawns a second agent. The JOURNAL records it first — the
    // transcript file does not exist yet — so the only thing that moves on disk
    // is journal.jsonl's OWN mtime: appending to a file inside the run dir
    // never bumps the DIR's mtime, and no agent transcript grew past its
    // stored offset. Keying the full pass off the dir mtime alone loses this
    // append entirely (and with it every agent that never gets a transcript).
    appendFileSync(journalPath, jline({ type: "started", key: "v2:k2", agentId: "a2" }));
    const appendedAt = NOW + 7_000;
    setMtime(journalPath, appendedAt);
    setMtime(runDir, t0);
    setMtime(agentPath, t0);

    workflowTick(store, hub, NOW + 10_000);
    expect(hub.calls.length).toBe(2); // exactly one broadcast for one real change
    const payload = hub.calls[1].payload as { run_id: string; agents: { agent_id: string }[] }[];
    expect(payload.find((w) => w.run_id === "wf_t1")!.agents.map((a) => a.agent_id).sort()).toEqual(["a1", "a2"]);
    const n = store.db.query("SELECT COUNT(*) AS c FROM workflow_agents WHERE run_id='wf_t1'").get() as { c: number };
    expect(n.c).toBe(2);
    // The journal's mtime is part of the blend, so the persisted value advances
    // to it — which is what makes the NEXT tick's quiet check correct by
    // construction instead of by a second, separately-maintained signal.
    expect(store.getWorkflowRun("wf_t1")!.last_seen_at).toBe(appendedAt);

    // Steady state again: the blend stops advancing, so the ticks go quiet.
    workflowTick(store, hub, NOW + 15_000);
    workflowTick(store, hub, NOW + 20_000);
    expect(hub.calls.length).toBe(2);
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
