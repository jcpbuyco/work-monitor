import { readdirSync, statSync, readFileSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Store } from "./store.ts";
import { takeUsage } from "./usage.ts";
import { WF_QUIET_MS, WF_RECHECK_MS, CLAUDE_PROJECTS_DIR } from "./config.ts";
import { truncate } from "./derive.ts";

/** A session's on-disk directory is its transcript path minus `.jsonl` — exact
 *  for 20 of 20 surveyed runs (C9). Never recompute the project slug from cwd. */
export function sessionDirFor(transcriptPath: string): string {
  return transcriptPath.replace(/\.jsonl$/, "");
}

/** Liveness from two independent signals — structure (`manifest_seen`) and motion
 *  (`last_seen_at`, which is the run dir's mtime OR the newest mtime among the
 *  run's agent-*.jsonl/journal files, as of the last tick that saw it — NOT the
 *  time we last looked). Pure: no I/O, no agent argument.
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

/** Last derived state (`running`/`settled`/`orphaned`) broadcast for each run,
 *  keyed per Store so tests using fresh in-memory stores never see another
 *  test's residual state. deriveRunState is a pure function of stored fields
 *  and `now` — the ACTIVE→SETTLED (and running→orphaned) transition fires
 *  purely from the passage of time, with nothing on disk moving, so it can
 *  only be caught by comparing against a remembered previous value (§1.4,
 *  §3.1 "a state transition" is a change that must broadcast). */
const lastRunState = new WeakMap<Store, Map<string, "running" | "settled" | "orphaned">>();

/** Run ids for which the §5.8 "manifest reports tokens but we ingested none"
 *  cross-check has already had its one shot, keyed per Store like
 *  `lastRunState` (a fresh Store per test means no cross-test pollution). The
 *  check needs a full pass (to re-read the manifest and query the usage
 *  rollup), but the disk-motion flags below are false BY DEFINITION on the
 *  exact tick a run goes quiet — that's what "settled" means — so without
 *  this a run discovered while ACTIVE would hit the cheap-re-stat early
 *  return forever and never get checked (findings 5 & 7). Marking it done
 *  after the one forced pass keeps that pass a one-time cost per run, not a
 *  recurring one. */
const crosschecked = new WeakMap<Store, Set<string>>();

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

export interface RunTarget {
  run_id: string;
  session_id: string;
  dir: string;
}

const AGENT_RE = /^agent-(.+)\.jsonl$/;

// `readdirSafe` already exists from Task 10 (the script lookup uses it).

function readFileSafe(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** First `bytes` of a file — enough for version/model/prompt without paying for a
 *  6.3MB read. */
function readHead(path: string, bytes = 8192): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const n = Math.min(bytes, fstatSync(fd).size);
    if (n <= 0) return "";
    const buf = Buffer.allocUnsafe(n);
    // Same short-read rule as takeUsage: decode only what was actually read.
    const got = readSync(fd, buf, 0, n, 0);
    return got > 0 ? buf.subarray(0, got).toString("utf8") : "";
  } finally {
    closeSync(fd);
  }
}

/** Cap on `readAgentHeader`'s growing read window (finding 4). A fixed 8KB
 *  window can never reach `message.model`: that field lives on the SECOND
 *  (assistant) transcript line, and the FIRST (user) line alone reaches
 *  65,902 bytes on real transcripts, with the model line itself starting as
 *  late as byte 86,774. A bigger fixed constant would just move the cliff, so
 *  this grows instead — bounded so a pathological transcript can't turn one
 *  header read into a multi-MB scan. */
const HEADER_READ_CAP = 256 * 1024;

/** Read an agent transcript's header, DOUBLING the read window (8KB, 16KB, …)
 *  until `parseAgentHeader` resolves `model`, the whole file has been read, or
 *  `HEADER_READ_CAP` is hit — whichever comes first. Runs at most once per
 *  agent (the `!offsets.has(id)` gate at the call site), so the extra reads
 *  are a bounded, one-time cost per agent, not a per-tick one.
 *
 *  File size is checked via `statSync`, not the decoded string's `.length` —
 *  a multi-byte UTF-8 line (non-English prompt text, emoji, …) decodes to
 *  fewer UTF-16 code units than bytes read, so comparing string length
 *  against the byte budget would signal "hit EOF" prematurely and stop
 *  growing before the model line is actually reached. */
function readAgentHeader(path: string): ReturnType<typeof parseAgentHeader> {
  let fileSize: number;
  try {
    fileSize = statSync(path).size;
  } catch {
    return parseAgentHeader("");
  }
  let bytes = 8192;
  for (;;) {
    const parsed = parseAgentHeader(readHead(path, bytes));
    if (parsed.model || bytes >= fileSize || bytes >= HEADER_READ_CAP) return parsed;
    bytes *= 2;
  }
}

/** Scan one run dir: refresh structure, then tail every agent transcript.
 *  Returns true when anything changed (new run, dir moved, manifest arrived or was
 *  rewritten in place, or usage recorded) — the `changed` contract the SSE
 *  broadcast keys off.
 *  Throws only on a stat of the run dir itself; the caller catches. */
export function scanRun(store: Store, t: RunTarget, now: number): boolean {
  const dirStat = statSync(t.dir);
  const mtime = Math.round(dirStat.mtimeMs);
  const prev = store.getWorkflowRun(t.run_id);
  // NOTE: the scanner never calls deriveRunState. Liveness is derived at READ time
  // (hydrateWorkflowRuns / liveWorkflows), from `manifest_seen` + `last_seen_at` +
  // the joined session status — so nothing here needs the owning session's status.

  // The manifest lives OUTSIDE the run dir, so neither its arrival nor an in-place
  // rewrite bumps the run dir mtime — it has to be stat'd explicitly, and its own
  // mtime remembered.
  const sessionDir = resolve(t.dir, "..", "..", "..");
  const manifestPath = join(sessionDir, "workflows", `${t.run_id}.json`);
  let manifestMtime: number | null = null;
  try {
    manifestMtime = Math.round(statSync(manifestPath).mtimeMs);
  } catch {}
  const manifestExists = manifestMtime !== null;
  // Keyed on manifest_mtime, not manifest_seen: the mtime is stored whenever the
  // FILE exists (parsed or not), so a manifest that exists but never parses is
  // "new" for exactly one pass. manifest_seen stays 0 on a parse failure, which
  // would otherwise re-trigger the full scan every tick forever.
  const manifestNew = manifestExists && (!prev || prev.manifest_mtime == null);
  // C6: a manifest is rewritten in place (`failed` 09:27:58 → `completed` 09:41:16)
  // with the run dir untouched. A stored mtime older than the file's is the only
  // signal that happened. A NULL stored value (row written before this column, or
  // by a pass that never read the manifest) re-parses once, then converges.
  const manifestRewritten =
    manifestExists && !!prev && (prev.manifest_mtime == null || manifestMtime! > prev.manifest_mtime);

  // Agent set = the run dir's agent-*.jsonl files. Not the manifest, not the journal.
  const offsets = new Map(store.workflowAgentOffsets(t.run_id).map((o) => [o.agent_id, o.offset]));
  const files: { agent_id: string; path: string }[] = [];
  let grew = false;
  // last_seen_at (spec §1.4, finding-3 redo): dir mtime OR the newest mtime
  // among this run's agent-*.jsonl / journal.jsonl files — PURE disk truth,
  // never `now`. An append bumps that FILE's own mtime even when it leaves
  // the run dir's mtime untouched (rule 3: "an append to an ALREADY-TRACKED
  // transcript... leaves the dir mtime alone"), so this un-settles a growing
  // run without ever fabricating a clock reading, and it settles correctly
  // the instant real writes stop — including a transcript stuck at
  // size > offset forever (an unterminated trailing line): its mtime freezes
  // the moment writes actually stop, independent of the offset.
  let lastSeenAt = mtime;
  for (const name of readdirSafe(t.dir)) {
    const m = AGENT_RE.exec(name);
    if (!m) continue;
    const path = join(t.dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    files.push({ agent_id: m[1], path });
    // Size-vs-offset is a signal to bypass the cheap early-return and pay for
    // the tail below — NEVER a liveness input (a file stuck with an
    // unterminated final line satisfies this forever; see `lastSeenAt`
    // above for how that case still settles correctly).
    if (st.size > (offsets.get(m[1]) ?? 0)) grew = true;
    const fileMtime = Math.round(st.mtimeMs);
    if (fileMtime > lastSeenAt) lastSeenAt = fileMtime;
  }
  // journal.jsonl lives in the run dir too; an append to it is exactly as much
  // "the run is alive" as an agent transcript append is.
  try {
    const journalMtime = Math.round(statSync(join(t.dir, "journal.jsonl")).mtimeMs);
    if (journalMtime > lastSeenAt) lastSeenAt = journalMtime;
  } catch {}

  // Structural motion of the DIR ITSELF — a brand-new agent file (or the dir
  // touched for any other reason) bumps the dir's own mtime; an append to an
  // already-tracked transcript does not (rule 3). Deliberately narrower than
  // `lastSeenAt` above: this feeds the early-return bypass and the `changed`
  // broadcast decision below, and folding ordinary file growth into it would
  // broadcast on every tick a transcript merely grows, regardless of whether
  // that growth actually changed anything worth showing on the client (the
  // re-verify's regression (b): 19 identical-payload broadcasts over 20
  // ticks). Liveness itself un-settles via `lastSeenAt`/`stateChanged` below,
  // never via this flag.
  const dirMoved = !prev || prev.last_seen_at == null || mtime > prev.last_seen_at;

  // Rule 1.4 / §3.1: the ACTIVE→SETTLED (and running→orphaned) transition is
  // purely time-based — WF_QUIET_MS elapses with nothing on disk moving — so
  // none of the disk-motion checks above ever see it. Compare the freshly
  // derived state against the last one we computed for this run and treat a
  // flip as a change even when nothing else did; otherwise a finished run
  // never gets re-broadcast and stays "running" on the client forever
  // (findings 1 & 2).
  //
  // Single source of truth (finding-3 redo): this MUST use the same
  // `lastSeenAt` that gets persisted below and that liveWorkflows/deriveRunState
  // read back later — never the raw dir `mtime` alone. Reading raw `mtime`
  // here while persisting a different value is exactly what re-opened
  // findings 1&2 in the rejected fix: a long-running workflow's dir mtime is
  // permanently "quiet" on its own (only file appends keep it alive), so a
  // pre-pass check pinned to raw `mtime` sees "settled" on every tick
  // regardless of real activity, corrupting this cache with a false
  // transition and permanently masking the real one.
  let stateCache = lastRunState.get(store);
  if (!stateCache) {
    stateCache = new Map();
    lastRunState.set(store, stateCache);
  }
  let stateChanged = false;
  let derivedState: "running" | "settled" | "orphaned" | null = null;
  if (prev) {
    derivedState = deriveRunState(
      {
        manifest_seen: !!prev.manifest_seen,
        status: prev.status,
        last_seen_at: lastSeenAt,
        session_status: prev.session_status,
      },
      now
    );
    stateChanged = stateCache.get(t.run_id) !== derivedState;
    stateCache.set(t.run_id, derivedState);
  }

  // §5.8's cross-check needs a full pass to re-read the manifest's
  // total_tokens_reported and query the usage rollup. Force exactly one when
  // a previously-known run has just settled and has never been checked —
  // otherwise a run discovered while ACTIVE hits the cheap re-stat below
  // forever and the check written specifically for silently-wrong cost never
  // runs for it (findings 5 & 7). Consumption itself (`cc.add`) is deferred
  // until the check has actually run against a successfully-parsed manifest,
  // below — marking it here would spend the run's one shot on a pass where
  // the manifest exists but fails to parse (or existed only transiently),
  // permanently losing the check for a run that never gets a valid manifest
  // until later.
  let cc = crosschecked.get(store);
  if (!cc) {
    cc = new Set();
    crosschecked.set(store, cc);
  }
  const needsCrosscheck = !!prev && derivedState === "settled" && !cc.has(t.run_id);
  // NOTE: cc.add(t.run_id) happens below, only once the check has actually run
  // against a successfully-parsed manifest — see the comment above `cc`.

  if (prev && !dirMoved && !grew && !manifestNew && !manifestRewritten && !needsCrosscheck) return stateChanged; // cheap re-stat only

  const manifest = manifestExists ? parseManifest(readFileSafe(manifestPath)) : null;
  let error: string | null = null;
  if (manifestExists && !manifest) error = "manifest: not valid JSON";
  else if (manifest && !manifest.schema_ok) error = manifest.error;
  // logOnce returns true only on the pass that actually logged; gating the counter
  // on it makes workflows_degraded once-per-run-per-cause, not once-per-5s-tick.
  if (error && logOnce(t.run_id, error)) bumpDegraded();

  const journalLines = readFileSafe(join(t.dir, "journal.jsonl")).split("\n");
  const { agents: journalAgents, unknownTypes } = parseJournal(journalLines, { manifestPresent: !!manifest });
  if (unknownTypes > 0 && logOnce(`${t.run_id}:journal-types`, `${unknownTypes} unknown journal line type(s)`)) {
    bumpDegraded(unknownTypes);
  }

  // The script is the only LIVE source of phase titles; once a manifest exists it
  // is strictly better, so don't pay for the read.
  let script: { name: string | null; phases: Phase[] } = { name: null, phases: [] };
  if (!manifest) {
    // Primary lookup: one readdir of a small dir, every ACTIVE tick.
    let scriptPath = findScriptFile(sessionDir, t.run_id);
    // Fallback (C9): 3 of 20 runs park their script under a SIBLING project slug
    // carrying the same sessionId. `!prev` pins this to the pass that DISCOVERS
    // the run — the first tick that sees it, or the startup backfill on a fresh
    // DB — so it is a discovery-time cost and NEVER lands on a 5s tick (§1.3).
    if (!scriptPath && !prev) scriptPath = findScriptAcrossSlugs(sessionDir, t.run_id);
    if (scriptPath) script = parseScriptMeta(readFileSafe(scriptPath));
  }

  const manifestById = new Map((manifest?.agents ?? []).map((a) => [a.agent_id, a]));
  const ids = new Set<string>([...files.map((f) => f.agent_id), ...journalAgents.keys(), ...manifestById.keys()]);
  // `quiet` uses the SAME `lastSeenAt` computed above — the single value that
  // also gets persisted below and fed to deriveRunState both here and at read
  // time (liveWorkflows). One source of truth, incapable of disagreeing
  // (spec §1.4, finding-3 redo).
  const quiet = now - lastSeenAt > WF_QUIET_MS;

  let ccVersion: string | null = null;
  let recorded = false;

  for (const id of ids) {
    const file = files.find((f) => f.agent_id === id);
    const j = journalAgents.get(id);
    const m = manifestById.get(id);
    // Read the transcript head only for an agent we have never seen; after that
    // the header fields never change.
    const header =
      file && !offsets.has(id)
        ? readAgentHeader(file.path)
        : { cc_version: null, model: null, prompt_preview: null };
    if (!ccVersion && header.cc_version) ccVersion = header.cc_version;
    const meta = file
      ? parseAgentMeta(readFileSafe(file.path.replace(/\.jsonl$/, ".meta.json")))
      : { agent_type: null, model: null };

    store.upsertWorkflowAgent({
      run_id: t.run_id,
      agent_id: id,
      label: m?.label ?? null, // labels exist only in the manifest — null on a live run
      phase_index: m?.phase_index ?? null,
      phase_title: m?.phase_title ?? null,
      idx: m?.idx ?? null,
      model: m?.model ?? header.model ?? meta.model ?? null,
      // Rule 6: a transcript with no journal mention is running while ACTIVE, done once quiet.
      state: m?.state ?? j?.state ?? (file ? (quiet ? "done" : "running") : null),
      attempt: m?.attempt ?? null,
      journal_key: j?.journal_key ?? null,
      last_tool: m?.last_tool ?? null,
      last_tool_summary: m?.last_tool_summary ?? null,
      prompt_preview: m?.prompt_preview ?? header.prompt_preview ?? null,
      started_at: m?.started_at ?? null,
      duration_ms: m?.duration_ms ?? null,
      tool_calls: m?.tool_calls ?? null,
    });

    if (!file) continue;
    const before = offsets.get(id) ?? 0;
    const r = takeUsage(store, {
      path: file.path,
      offset: before,
      sessionId: t.session_id, // PARENT session id — the keystone (C3)
      runId: t.run_id,
      agentId: id,
    });
    if (r.offset !== before) store.setWorkflowAgentOffset(t.run_id, id, r.offset);
    if (r.recorded) recorded = true;
  }

  const phases = manifest?.phases.length ? manifest.phases : script.phases;
  store.upsertWorkflowRun({
    run_id: t.run_id,
    session_id: t.session_id,
    dir: t.dir,
    name: manifest?.name ?? script.name ?? null,
    summary: manifest?.summary ?? null,
    status: manifest?.status ?? null, // RAW
    error,
    // Before a manifest exists, the dir's birthtime is the best start we have
    // (~42s early on a sample); mtimeMs is the fallback where birthtime is 0.
    started_at: manifest?.started_at ?? Math.round(dirStat.birthtimeMs || dirStat.mtimeMs),
    ended_at: manifest?.ended_at ?? null,
    duration_ms: manifest?.duration_ms ?? null,
    agent_count: manifest?.agent_count ?? null,
    phases: phases.length ? JSON.stringify(phases) : null,
    cc_version: ccVersion,
    manifest_seen: !!manifest,
    // Stored whenever the FILE exists, parsed or not: a corrupt manifest that is
    // later fixed in place must still re-trigger on its new mtime.
    manifest_mtime: manifestMtime,
    last_seen_at: lastSeenAt, // dir mtime OR newest run-file mtime — pure disk truth (spec §1.4)
    schema_ok: !error,
    total_tokens_reported: manifest?.total_tokens_reported ?? null,
  });

  // Refresh the state cache with what was just written, so the next tick's
  // cheap-re-stat comparison (above) starts from an accurate baseline instead
  // of the pre-scan value. `session_status` isn't otherwise needed on this
  // path (the scanner deliberately never calls deriveRunState for its own
  // purposes — see the NOTE above); `prev`'s is close enough for a freshly
  // discovered or just-rescanned run, and any drift self-corrects on the very
  // next tick once `prev` is re-read from the row this upsert just wrote.
  stateCache.set(
    t.run_id,
    deriveRunState(
      {
        manifest_seen: !!manifest,
        status: manifest?.status ?? null,
        last_seen_at: lastSeenAt,
        session_status: prev?.session_status ?? "working",
      },
      now
    )
  );

  // Cross-check §5.8 — PRESENCE, not proportion. Claude Code's `totalTokens` is
  // not comparable to our rollup (24x–276x across 19 manifests), so the only
  // sound signal is "it says tokens were burned and we ingested none".
  //
  // Consumption is marked HERE, only once the check has actually run against a
  // successfully-parsed manifest — never at `needsCrosscheck`'s computation
  // above. A null `manifest` (parse failure, or a manifest that hasn't landed
  // yet despite `derivedState` reading "settled") must leave the run's one
  // shot unspent so a later pass, once the manifest is readable, still gets
  // to run it.
  if (needsCrosscheck && manifest) cc.add(t.run_id);
  if (manifest && quiet && (manifest.total_tokens_reported ?? 0) > 0) {
    const row = store.db
      .query(
        `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens +
                            cache_create_5m_tokens + cache_create_1h_tokens), 0) AS t
         FROM usage WHERE run_id = $r`
      )
      .get({ $r: t.run_id }) as { t: number };
    if (row.t === 0 && logOnce(`${t.run_id}:no-tokens`, "manifest reports tokens but no usage rows were ingested")) {
      bumpDegraded();
    }
  }

  // `stateChanged` covers a full pass that was forced purely by a derived
  // state transition or a cross-check due (findings 1, 2, 5, 7) — none of
  // dirMoved/manifestNew/manifestRewritten/recorded need be true in that case.
  return recorded || dirMoved || manifestNew || manifestRewritten || !prev || stateChanged;
}

/** One tick. Discovery is per-session `readdir` (~100µs), never a glob — the only
 *  global glob in this feature is the one-time startup backfill.
 *
 *  Returns `changed` ONLY — no `live` payload. Computing `store.liveWorkflows()`
 *  costs 4 SQL queries, and the vast majority of ticks find nothing new; paying
 *  for it here would mean paying it on every 5s tick regardless of whether
 *  anyone ever looks at the result. That cost belongs to whoever actually needs
 *  the list — `workflowTick()`, and only on the branch where `changed` is true. */
export function scanWorkflows(store: Store, now: number): { changed: boolean } {
  let changed = false;
  const targets = new Map<string, RunTarget>();

  for (const s of store.listSessions()) {
    if (!s.transcript_path) continue;
    const runsDir = join(sessionDirFor(s.transcript_path), "subagents", "workflows");
    for (const n of readdirSafe(runsDir)) {
      if (!n.startsWith("wf_")) continue;
      targets.set(n, { run_id: n, session_id: s.id, dir: join(runsDir, n) });
    }
  }
  for (const r of store.workflowRunsToScan(now - WF_RECHECK_MS)) {
    if (!targets.has(r.run_id)) targets.set(r.run_id, { run_id: r.run_id, session_id: r.session_id, dir: r.dir });
  }

  for (const t of targets.values()) {
    try {
      if (scanRun(store, t, now)) changed = true;
    } catch (err) {
      // Per-run isolation: one unreadable run can never break the others, the
      // stale sweep, or session cost tailing. Counted once per run, not per tick.
      // Qualified key (":scan"): a manifest-parse failure inside scanRun logs
      // under the BARE run id (§5.5's `error` cause) — sharing that key here
      // would let whichever cause hits first permanently suppress the other's
      // log line and degraded bump for this run (finding 8).
      if (logOnce(`${t.run_id}:scan`, err)) bumpDegraded();
    }
  }
  return { changed };
}

/** Structural hub type: only what a 5s tick needs to publish a change, so tests
 *  can pass a plain counting stub instead of a real SseHub (or anything else
 *  that happens to have a `broadcast` method — that's the point of typing this
 *  structurally rather than importing SseHub itself). */
export interface BroadcastHub {
  broadcast(event: string, payload: unknown): void;
}

/** One 5s tick, in full: scan every run, and broadcast the live list ONLY when
 *  something changed. A tick that just re-stats and finds nothing sends
 *  nothing — and, per scanWorkflows' contract above, never even computes the
 *  live payload in that case. `store.liveWorkflows(now)` is called from THIS
 *  gated branch, not from scanWorkflows.
 *
 *  Never calls pushState()/broadcasts "state": buildState() is 243ms and a 5s
 *  full-state broadcast would burn ~5% CPU permanently. Usage this tick records
 *  therefore does not reach the cost panels until the next 60s sweep; that
 *  asymmetry is accepted. This is the one place index.ts's setInterval calls into. */
export function workflowTick(store: Store, hub: BroadcastHub, now: number): void {
  try {
    const { changed } = scanWorkflows(store, now);
    if (changed) hub.broadcast("workflows", store.liveWorkflows(now));
  } catch (err) {
    // Unchanged from Task 13: the counter is gated on logOnce's boolean, so a
    // tick that fails every 5s counts once, not 720 times an hour (§5.5).
    if (logOnce("wf-scan", err)) bumpDegraded();
  }
}

/** One-time startup pass over every run dir on disk. This is the ONLY place a
 *  global glob is allowed (~1ms for 20 dirs).
 *
 *  Each hit is resolved to its session by PATH STRUCTURE, never by string-matching
 *  `transcript_path`: the session dir is the run dir's third parent and the
 *  session id is that directory's basename. A run whose session id is absent from
 *  `sessions` is still ingested — recordUsage's subquery yields NULL project, which
 *  the cost queries already bucket under 'unknown'. Dropping it would lose spend.
 *
 *  Every run here is a first sight on a fresh DB, so this is also where scanRun's
 *  once-per-run cross-slug script lookup (§1.3) happens for historical runs — at
 *  backfill time, never on a 5s tick. On a warm DB the run rows already exist and
 *  scanRun skips it. */
export function backfillWorkflows(
  store: Store,
  now: number,
  root: string = CLAUDE_PROJECTS_DIR
): { runs: number } {
  let runs = 0;
  for (const slug of readdirSafe(root)) {
    for (const sessionId of readdirSafe(join(root, slug))) {
      const runsDir = join(root, slug, sessionId, "subagents", "workflows");
      for (const name of readdirSafe(runsDir)) {
        if (!name.startsWith("wf_")) continue;
        const target: RunTarget = { run_id: name, session_id: sessionId, dir: join(runsDir, name) };
        try {
          scanRun(store, target, now);
          runs++;
        } catch (err) {
          // Qualified key, matching scanWorkflows' catch (finding 8): a
          // manifest-parse failure inside scanRun logs under the bare run id.
          if (logOnce(`${name}:scan`, err)) bumpDegraded(); // once per run per cause (§5.5)
        }
      }
    }
  }
  return { runs };
}
