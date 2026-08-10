import { WF_QUIET_MS } from "./config.ts";

/** A session's on-disk directory is its transcript path minus `.jsonl` — exact
 *  for 20 of 20 surveyed runs (C9). Never recompute the project slug from cwd. */
export function sessionDirFor(transcriptPath: string): string {
  return transcriptPath.replace(/\.jsonl$/, "");
}

/** Liveness from two independent signals — structure (`manifest_seen`) and motion
 *  (`last_seen_at`, which is the run dir's mtime as of the last tick that saw it,
 *  NOT the time we last looked). Pure: no I/O, no agent argument.
 *
 *  Rules in force order (spec §1.4):
 *   1. manifest + quiet ⇒ settled. A manifest is terminal for STRUCTURE only —
 *      it never stops cost tailing, which is why "running" wins while the dir moves.
 *   2. quiet with no manifest, or an ended owning session ⇒ orphaned (display only,
 *      never persisted; self-healing if files move again).
 *   3. otherwise running. */
export function deriveRunState(
  run: {
    manifest_seen: boolean;
    status: string | null;
    last_seen_at: number | null;
    session_status: string;
  },
  now: number
): "running" | "settled" | "orphaned" {
  const quiet = run.last_seen_at == null || now - run.last_seen_at > WF_QUIET_MS;
  if (run.manifest_seen && quiet) return "settled";
  if (quiet || run.session_status === "ended") return "orphaned";
  return "running";
}

/** One console.warn per key per process, modelled on the `warned` Set in
 *  pricing.ts. Keys are run ids — once per run, not per tick (§5.5). */
const warnedRuns = new Set<string>();

/** Process-lifetime counter of parse failures, unknown journal line types and
 *  zero-agent manifests. Surfaced as `workflows_degraded` in buildState (§5.9).
 *  Resetting on restart is intended: a restart is how you clear the banner.
 *
 *  Every bump is gated on `logOnce` returning true, so a cause that recurs on
 *  every 5s tick counts ONCE per run per cause, not 720 times an hour (§5.5). */
let degraded = 0;
export function workflowsDegraded(): number {
  return degraded;
}
export function bumpDegraded(n = 1): void {
  degraded += n;
}
/** Tests only. Clears the once-per-key log memory as well as the counter — the
 *  two are coupled now, and fixtures reuse a fixed run id (`wf_t1`) across tests,
 *  so a stale key would silently suppress the next test's bump. */
export function resetDegraded(): void {
  degraded = 0;
  warnedRuns.clear();
}

/** Warn once per key (see `warnedRuns` above), and return TRUE only on the pass
 *  that actually logged. Callers gate `bumpDegraded()` on that boolean, which is
 *  what makes the degraded counter once-per-run-per-cause instead of
 *  once-per-tick. */
export function logOnce(key: string, err: unknown): boolean {
  if (warnedRuns.has(key)) return false;
  warnedRuns.add(key);
  console.warn(`[workflows] ${key}: ${String(err)}`);
  return true;
}

export interface Phase {
  title: string;
  detail: string | null;
}

export interface ManifestAgent {
  agent_id: string;
  label: string | null;
  phase_index: number | null;
  phase_title: string | null;
  idx: number | null;
  model: string | null;
  state: string | null;
  attempt: number | null;
  last_tool: string | null;
  last_tool_summary: string | null;
  prompt_preview: string | null;
  started_at: number | null;
  duration_ms: number | null;
  tool_calls: number | null;
}

export interface ManifestView {
  name: string | null;
  status: string | null;
  summary: string | null;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  agent_count: number | null;
  total_tokens_reported: number | null;
  phases: Phase[];
  agents: ManifestAgent[];
  schema_ok: boolean;
  error: string | null;
}

/** Tolerant getters. NOTHING in this file destructures a parsed object (§5.1). */
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Parse a workflow manifest. Returns null only when the text is not JSON at all;
 *  a structurally surprising manifest still yields a partial view with
 *  `schema_ok = false` (the toolStats() precedent — degrade, never throw). */
export function parseManifest(text: string): ManifestView | null {
  let o: any;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;

  const phases: Phase[] = [];
  const rawPhases = Array.isArray(o.phases) ? o.phases : [];
  for (const p of rawPhases) {
    const title = str(p?.title);
    if (title) phases.push({ title, detail: str(p?.detail) });
  }

  const agents: ManifestAgent[] = [];
  const progress = Array.isArray(o.workflowProgress) ? o.workflowProgress : [];
  for (const e of progress) {
    // Entries of other types (workflow_phase today, more tomorrow) are ignored,
    // never destructured.
    if (e?.type !== "workflow_agent") continue;
    const id = str(e?.agentId);
    if (!id) continue;
    agents.push({
      agent_id: id,
      label: str(e?.label),
      phase_index: num(e?.phaseIndex),
      phase_title: str(e?.phaseTitle),
      idx: num(e?.index),
      model: str(e?.model),
      state: str(e?.state),
      attempt: num(e?.attempt),
      last_tool: str(e?.lastToolName),
      last_tool_summary: str(e?.lastToolSummary),
      prompt_preview: str(e?.promptPreview),
      started_at: num(e?.startedAt),
      duration_ms: num(e?.durationMs),
      tool_calls: num(e?.toolCalls),
    });
  }

  const endedIso = str(o.timestamp);
  const endedAt = endedIso ? Date.parse(endedIso) : NaN;
  const zeroAgents = agents.length === 0;

  return {
    name: str(o.workflowName),
    status: str(o.status), // RAW passthrough — no enum, no validation
    summary: str(o.summary),
    started_at: num(o.startTime),
    ended_at: Number.isFinite(endedAt) ? endedAt : null,
    duration_ms: num(o.durationMs),
    agent_count: num(o.agentCount),
    total_tokens_reported: num(o.totalTokens),
    phases,
    agents,
    schema_ok: !zeroAgents,
    error: zeroAgents ? "manifest parsed 0 agents" : null,
  };
}
