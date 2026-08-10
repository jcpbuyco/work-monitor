import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sessionDirFor, deriveRunState, parseManifest } from "../src/server/workflows.ts";
import { WF_QUIET_MS } from "../src/server/config.ts";

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
