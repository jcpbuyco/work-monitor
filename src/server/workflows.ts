import { readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { WF_QUIET_MS } from "./config.ts";
import { truncate } from "./derive.ts";

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

export type AgentState = "running" | "done" | "abandoned";

export interface JournalAgent {
  agent_id: string;
  journal_key: string;
  state: AgentState;
}

/** Reduce a run's journal.jsonl into per-agent states (§1.3, C7).
 *
 *  `key` is an opaque content hash (`v2:<sha256>`) — a grouping key only, never
 *  rendered. Journal lines carry no timestamp, so FILE ORDER is the tiebreak:
 *  the last agentId seen for a key wins and earlier ones become `abandoned`.
 *  Abandoned agents keep their row so their tokens still attribute.
 *
 *  `started`-without-`result` means running ONLY when no manifest exists. A
 *  completed run legitimately has resultless keys (6 started / 3 result over 6
 *  keys was observed on a completed run) and would otherwise show phantom
 *  running agents forever. */
export function parseJournal(
  lines: string[],
  opts: { manifestPresent: boolean }
): { agents: Map<string, JournalAgent>; unknownTypes: number } {
  let unknownTypes = 0;
  const keyOrder = new Map<string, string[]>(); // key → agentIds in file order
  const keyOf = new Map<string, string>(); // agentId → key
  const hasResult = new Set<string>(); // agentIds with a result line

  for (const ln of lines) {
    if (!ln.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(ln);
    } catch {
      unknownTypes++;
      continue;
    }
    const type = str(o?.type);
    if (type !== "started" && type !== "result") {
      unknownTypes++;
      continue;
    }
    const key = str(o?.key);
    const id = str(o?.agentId);
    if (!key || !id) {
      unknownTypes++;
      continue;
    }
    const seq = keyOrder.get(key) ?? [];
    if (seq[seq.length - 1] !== id) seq.push(id);
    keyOrder.set(key, seq);
    keyOf.set(id, key);
    if (type === "result") hasResult.add(id);
  }

  const agents = new Map<string, JournalAgent>();
  for (const [key, seq] of keyOrder) {
    const winner = seq[seq.length - 1];
    for (const id of seq) {
      let state: AgentState;
      if (id !== winner) state = "abandoned";
      else if (hasResult.has(id)) state = "done";
      else state = opts.manifestPresent ? "done" : "running";
      agents.set(id, { agent_id: id, journal_key: key, state });
    }
  }
  return { agents, unknownTypes };
}

/** `agent-<id>.meta.json` is 48–65 bytes: {agentType, spawnDepth, model?}.
 *  `model` is usually a bare alias and is DISPLAY ONLY — never a pricing input,
 *  which always reads `message.model` off the transcript line. */
export function parseAgentMeta(text: string): { agent_type: string | null; model: string | null } {
  let o: any;
  try {
    o = JSON.parse(text);
  } catch {
    return { agent_type: null, model: null };
  }
  return { agent_type: str(o?.agentType), model: str(o?.model) };
}

/** Read what we need from the head of an agent transcript: the Claude Code
 *  `version` (for the "format last verified on X" badge), the first line
 *  carrying a `message.model` (the fallback when the meta file omits `model` —
 *  32 of 116 do), and the prompt preview.
 *
 *  `head` is the first few KB of the file; pass whatever you have. */
export function parseAgentHeader(head: string): {
  cc_version: string | null;
  model: string | null;
  prompt_preview: string | null;
} {
  let cc_version: string | null = null;
  let model: string | null = null;
  let prompt_preview: string | null = null;

  for (const ln of head.split("\n")) {
    if (!ln.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(ln);
    } catch {
      continue; // a clipped final line is expected when `head` is a byte slice
    }
    if (!cc_version) cc_version = str(o?.version);
    if (!model) model = str(o?.message?.model);
    if (!prompt_preview) {
      const content = o?.message?.content;
      let text: string | null = null;
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        const part = content.find((c: any) => typeof c?.text === "string");
        text = str(part?.text);
      }
      // 160 MUST be passed explicitly — truncate()'s default is MAX_INTENT_LEN (140).
      if (text) prompt_preview = truncate(text, 160);
    }
    if (cc_version && model && prompt_preview) break;
  }
  return { cc_version, model, prompt_preview };
}

/** The workflow script is the ONLY live source of phase titles. It is plain JS
 *  with an `export const meta = { name, description, phases: [{title, detail}] }`
 *  header, so this is a deliberately shallow regex read of that header — not a
 *  parser. Best-effort: 2 of 20 runs have no script at all and 3 more have one
 *  only under a sibling project slug, which we deliberately do NOT search (§1.3).
 *  A miss costs a phase label on a live run; the completed run gets full phases
 *  from its manifest anyway. */
export function parseScriptMeta(text: string): { name: string | null; phases: Phase[] } {
  const head = text.slice(0, 4000);
  const name = /name:\s*['"]([^'"]*)['"]/.exec(head)?.[1] ?? null;
  const phases: Phase[] = [];
  const open = head.indexOf("phases:");
  if (open >= 0) {
    const close = head.indexOf("]", open);
    const block = head.slice(open, close >= 0 ? close + 1 : undefined);
    const re = /title:\s*['"]([^'"]*)['"](?:\s*,\s*detail:\s*['"]([^'"]*)['"])?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) phases.push({ title: m[1], detail: m[2] ?? null });
  }
  return { name, phases };
}

/** ENOENT → empty, never a throw. Task 12's scanner reuses this. */
function readdirSafe(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

/** Primary script lookup, matched by the `-<runId>.js` SUFFIX — never by the
 *  manifest's `scriptPath`, whose filename is unreliable (C11). One readdir of a
 *  small dir; cheap enough to run on every ACTIVE tick. 15 of 20 runs hit here. */
export function findScriptFile(sessionDir: string, runId: string): string | null {
  const dir = join(sessionDir, "workflows", "scripts");
  const hit = readdirSafe(dir).find((n) => n.endsWith(`-${runId}.js`));
  return hit ? join(dir, hit) : null;
}

/** Fallback for C9's split: when a session's cwd moves into a subdirectory, Claude
 *  Code writes that run's script under a DIFFERENT project slug carrying the SAME
 *  sessionId (3 of 20 runs). Equivalent to the glob
 *  `~/.claude/projects/*<sessionId>/workflows/scripts/*-<runId>.js`, with the
 *  projects root derived by path structure — <sessionDir> is
 *  <root>/<slug>/<sessionId>, so the root is two levels up. That keeps the search
 *  inside the tree that already holds the run and needs no config (the same
 *  resolve-by-structure rule the backfill uses).
 *
 *  Pinned to ONE sessionId and ONE runId: a readdir per slug, never a tree walk.
 *  The CALLER is responsible for running this at most once per run (Task 12) —
 *  it must never land on a steady-state 5s tick. */
export function findScriptAcrossSlugs(sessionDir: string, runId: string): string | null {
  const sessionId = basename(sessionDir);
  const projectsRoot = resolve(sessionDir, "..", "..");
  for (const slug of readdirSafe(projectsRoot)) {
    const dir = join(projectsRoot, slug, sessionId, "workflows", "scripts");
    const hit = readdirSafe(dir).find((n) => n.endsWith(`-${runId}.js`));
    if (hit) return join(dir, hit);
  }
  return null;
}
