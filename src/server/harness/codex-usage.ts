import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Store } from "../store.ts";
import { costOf, canonicalModel, type Tokens } from "../pricing.ts";
import { readNewLines } from "../tail-lines.ts";
import { resolveRepoInfo } from "../resolve-project.ts";
import { truncate } from "../derive.ts";
import { parentFromScratchpadCwd } from "./detect.ts";

export const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");

export interface CodexParsedUsage {
  model: string;
  tokens: Tokens;
  at: number;
  messageKey: string;
}

/** §4.4: one rollout chunk's priced usage, plus the latest model seen in it
 *  (from `turn_context.payload.model`) for callers that need to stamp a
 *  session's `model` from content rather than a hook payload (the startup
 *  backfill - a live session already gets `model` from its own hook events).
 *  `firstUserMessage` is the earliest human prompt text found in the chunk
 *  (untruncated - callers apply their own length cap), for the startup
 *  backfill's `current_intent` (a backfilled session has no hook-delivered
 *  prompt event to get it from otherwise). */
export interface CodexChunkResult {
  usage: CodexParsedUsage[];
  lastModel: string | null;
  firstUserMessage: string | null;
}

/** A user prompt's text out of ONE `event_msg` line's payload, across both
 *  real captured shapes (§4.3/4.4 research):
 *   - pre-0.153: `{type:"user_message", message:"<text>", ...}` - a direct,
 *     top-level event.
 *   - 0.156+: `{type:"item_completed", item:{type:"UserMessage",
 *     content:[{type:"text", text:"<text>"}]}}` - the same prompt only ever
 *     appears nested inside an `item_completed` envelope; there is no direct
 *     top-level "UserMessage" event in any real 0.156 capture surveyed.
 *  Returns null for any other event_msg (including a 0.156 `item_completed`
 *  for a non-UserMessage item, e.g. `CommandExecution`/`AgentMessage`). */
function codexUserTextFromEventMsg(payload: any): string | null {
  if (payload?.type === "user_message" && typeof payload.message === "string" && payload.message) {
    return payload.message;
  }
  if (payload?.type === "item_completed" && payload.item?.type === "UserMessage") {
    const content = payload.item.content;
    const block = Array.isArray(content) ? content.find((c: any) => c && typeof c.text === "string" && c.text) : null;
    if (block) return block.text;
  }
  return null;
}

/** Pure parser over already-split rollout lines (§4.4). Table-tested against
 *  REAL captured rollouts spanning cli_version 0.104 (pre-0.153, no
 *  `token_usage_record` line type at all) through 0.156 (adds
 *  `token_usage_record`/`world_state`) - the `event_msg`/`token_count` shape
 *  this reads is IDENTICAL across every version surveyed, so pricing needs no
 *  version branching at all. `token_usage_record` lines are read nowhere:
 *  they duplicate exactly what `event_msg.token_count.info` already carries
 *  and only exist from 0.153 on, so relying on the older, universal source is
 *  what makes one parser cover both eras.
 *
 *  Skips a `token_count` line with `info: null` (every version emits one such
 *  line before the first real API call completes). Tracks the latest
 *  `turn_context.payload.model` seen so far as it scans, so a `token_count`
 *  line prices at whichever model was active for that call - falling back to
 *  `fallbackModel` (the session's own stored model) only while no
 *  `turn_context` has been seen yet in this particular chunk (a tail that
 *  starts mid-conversation, after an earlier turn's `turn_context` already
 *  scrolled past the tailed window). */
export function parseCodexChunk(lines: string[], sessionId: string, fallbackModel: string | null): CodexChunkResult {
  let currentModel = fallbackModel;
  let firstUserMessage: string | null = null;
  const usage: CodexParsedUsage[] = [];
  for (const line of lines) {
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o?.type === "turn_context" && typeof o.payload?.model === "string") {
      currentModel = o.payload.model;
      continue;
    }
    if (o?.type === "event_msg" && firstUserMessage == null) {
      const text = codexUserTextFromEventMsg(o.payload);
      if (text) firstUserMessage = text;
    }
    if (o?.type !== "event_msg" || o.payload?.type !== "token_count") continue;
    const info = o.payload.info;
    if (info == null) continue; // no completed API call yet on this line
    const last = info.last_token_usage;
    const total = info.total_token_usage?.total_tokens;
    if (!last || typeof total !== "number") continue;
    const cachedInput = typeof last.cached_input_tokens === "number" ? last.cached_input_tokens : 0;
    const rawInput = typeof last.input_tokens === "number" ? last.input_tokens : 0;
    const tokens: Tokens = {
      // cached_input_tokens is a SUBSET of input_tokens, not additive (§4.4
      // research) - the priced "fresh" input is the remainder.
      input: Math.max(0, rawInput - cachedInput),
      output: typeof last.output_tokens === "number" ? last.output_tokens : 0,
      cache_read: cachedInput,
      cache_create_5m: 0,
      cache_create_1h: 0,
    };
    const at = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
    usage.push({
      model: currentModel ?? "unknown",
      tokens,
      at: Number.isFinite(at) ? at : 0,
      // Cumulative total strictly increases per call, so a re-observed line
      // (same total) collapses via this key instead of double-charging.
      messageKey: `codex:${sessionId}:${total}`,
    });
  }
  return { usage, lastModel: currentModel, firstUserMessage };
}

/** Live per-session tail (§4.4), dispatched from `usage.ts`'s `tailUsage` for
 *  any session whose `harness` is "codex". `fallbackModel` is the session's
 *  own stored `model` (set from hook events by the ordinary ingestion path) -
 *  used only until this chunk's own `turn_context` establishes one.
 *
 *  A live session's hook payloads never carry Codex's own CLI version (the
 *  research report's payload survey confirms it - `cli_version` only exists
 *  on the rollout's own `session_meta` line), so `harness_version` (§4.3: "…
 *  from the rollout session_meta.cli_version when tailing") is read here, on
 *  the FIRST tail (`t.offset === 0`) only - a cheap, bounded, one-time read
 *  of the file's own first line, not a per-tail cost. The startup backfill
 *  (`backfillCodexSessions`) covers sessions this misses (one already
 *  discovered before the server's own restart). */
export function tailCodexUsage(
  store: Store,
  t: { path: string; offset: number; sessionId: string; fallbackModel: string | null }
): boolean {
  if (t.offset === 0) {
    const meta = parseSessionMeta(readFirstLine(t.path));
    if (meta?.cliVersion) store.applyEvent(t.sessionId, { harness_version: meta.cliVersion }, Date.now());
  }
  const { offset, lines } = readNewLines(t.path, t.offset);
  const { usage } = parseCodexChunk(lines, t.sessionId, t.fallbackModel);
  let recorded = false;
  for (const u of usage) {
    const ok = store.recordUsage({
      // message_key is already globally unique (session-scoped + a strictly
      // increasing cumulative total) - reusing it as message_uuid too gives
      // idempotent re-tailing via the existing PRIMARY KEY conflict, no new
      // store logic needed.
      uuid: u.messageKey,
      sessionId: t.sessionId,
      model: canonicalModel(u.model),
      tokens: u.tokens,
      at: u.at,
      cost: costOf(u.model, u.tokens),
      messageKey: u.messageKey,
      harness: "codex",
    });
    if (ok) recorded = true;
  }
  if (offset !== t.offset) store.setUsageOffset(t.sessionId, offset);
  return recorded;
}

// --- startup backfill (§4.4) -----------------------------------------------

function readdirSafe(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

/** Bounded read of just the file's first line, for `session_meta` - real
 *  session_meta lines run up to ~22KB (a full system-prompt string embedded
 *  in `base_instructions`), so this cap leaves generous headroom without
 *  reading the whole (potentially many-MB) rollout. */
const SESSION_META_READ_CAP = 262_144;

function readFirstLine(path: string): string | null {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.allocUnsafe(SESSION_META_READ_CAP);
      const got = readSync(fd, buf, 0, buf.length, 0);
      if (got <= 0) return null;
      const text = buf.subarray(0, got).toString("utf8");
      const nl = text.indexOf("\n");
      return nl >= 0 ? text.slice(0, nl) : text;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

interface CodexSessionMeta {
  id: string;
  cwd: string | null;
  cliVersion: string | null;
  threadSource: string | null;
}

function parseSessionMeta(firstLine: string | null): CodexSessionMeta | null {
  if (!firstLine) return null;
  let o: any;
  try {
    o = JSON.parse(firstLine);
  } catch {
    return null;
  }
  if (o?.type !== "session_meta") return null;
  const p = o.payload ?? {};
  const id = typeof p.id === "string" ? p.id : null;
  if (!id) return null;
  return {
    id,
    cwd: typeof p.cwd === "string" ? p.cwd : null,
    cliVersion: typeof p.cli_version === "string" ? p.cli_version : null,
    threadSource: typeof p.thread_source === "string" ? p.thread_source : null,
  };
}

/** The rollout's own last line's timestamp - "ended_at" for a backfilled
 *  session (§4.4: "started/ended from first/last timestamps"). Reads the
 *  whole file (backfill is a one-time, offline pass; rollouts are bounded by
 *  a single CLI session's lifetime, not the multi-MB scale of a long-lived
 *  Claude Code transcript) rather than adding a second bounded-tail-from-the-
 *  end reader for a value only needed once per file. */
function lastTimestamp(path: string): number | null {
  const { lines } = readNewLines(path, 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(lines[i]);
      const t = typeof o?.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
      if (Number.isFinite(t)) return t;
    } catch {
      // keep scanning backward past an unparseable trailing line
    }
  }
  return null;
}

function walkRolloutFiles(dir: string, depth: number = 0): string[] {
  if (depth > 8) return [];
  const out: string[] = [];
  for (const name of readdirSafe(dir)) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walkRolloutFiles(full, depth + 1));
    else if (name.startsWith("rollout-") && name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

export interface CodexBackfillResult {
  scanned: number;
  sessionsUpserted: number;
  recorded: number;
  /** Codex native sub-agent rollouts found (`thread_source === "subagent"`)
   *  and skipped - an explicit spec non-goal (zero organic samples at design
   *  time), but their own spend is real and currently uncounted anywhere.
   *  Surfaced (and logged at startup) purely so that known gap stays
   *  VISIBLE rather than silent, pending the UI-facing "partially priced"
   *  treatment a later workstream can build on this count for. */
  skippedSubagentRollouts: number;
}

/** Startup backfill (§4.4): scan `~/.codex/sessions/**\/rollout-*.jsonl`
 *  (root injectable for tests), skip subagent rollouts (`thread_source ===
 *  "subagent"` - Codex native sub-agents are out of scope per the spec's own
 *  non-goals), upsert an `ended` session row per file, and ingest its usage.
 *  Idempotent via `message_key` (a re-run collapses onto the same rows) and,
 *  per file, via a stored offset/mtime/size in `harness_files` so an
 *  unchanged file is skipped entirely on the next boot rather than re-read.
 *
 *  Never downgrades a session that already has a row: a Codex session already
 *  live (created by its own `session_start` hook, possibly still running) is
 *  enriched (harness/model/version/parent, if still unset) but its
 *  status/started_at are left alone - only a session backfill is discovering
 *  for the FIRST time gets stamped `ended` with the rollout's own first/last
 *  timestamps. An already-`ended` session (backfilled earlier, or one whose
 *  rollout kept being appended to after its own SessionEnd hook fired) has
 *  its `ended_at`/`last_activity_at` advanced when the file grows further. */
export async function backfillCodexSessions(
  store: Store,
  now: number,
  root: string = CODEX_SESSIONS_DIR
): Promise<CodexBackfillResult> {
  let scanned = 0;
  let sessionsUpserted = 0;
  let recorded = 0;
  let skippedSubagentRollouts = 0;

  for (const path of walkRolloutFiles(root)) {
    scanned++;
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    const known = store.getHarnessFileOffset(path);
    // Unchanged since last pass iff BOTH mtime and size match: `offset` alone
    // can't tell "fully consumed" from "stopped short of a trailing partial
    // line" (a real, expected state -- see the offset-write below), so
    // comparing it to size would wrongly treat "still has a dangling partial
    // line from last time, and NOTHING has been appended since" as "changed,
    // re-scan" forever instead of skipping it like any other untouched file.
    if (known && known.mtime === st.mtimeMs && known.size === st.size) continue;

    const firstLine = readFirstLine(path);
    const meta = parseSessionMeta(firstLine);
    if (!meta) continue; // unparseable/incomplete session_meta -- retry on a later boot, it may be mid-write
    if (meta.threadSource === "subagent") {
      skippedSubagentRollouts++;
      // Persist a marker so a subagent rollout (which never gets a session
      // row) is skipped on sight next boot too, instead of re-reading its
      // first line forever.
      store.setHarnessFileOffset(path, meta.id, st.size, st.mtimeMs, st.size);
      continue;
    }

    const sessionId = meta.id;
    const existing = store.getSession(sessionId);
    const { offset, lines } = readNewLines(path, known?.offset ?? 0);
    const { usage, lastModel, firstUserMessage } = parseCodexChunk(lines, sessionId, existing?.model ?? null);
    for (const u of usage) {
      const ok = store.recordUsage({
        uuid: u.messageKey,
        sessionId,
        model: canonicalModel(u.model),
        tokens: u.tokens,
        at: u.at,
        cost: costOf(u.model, u.tokens),
        messageKey: u.messageKey,
        harness: "codex",
      });
      if (ok) recorded++;
    }

    if (!existing) {
      const info = meta.cwd ? await resolveRepoInfo(meta.cwd) : { project: "unknown", branch: null };
      let startedAt = now;
      try {
        const t = Date.parse(((JSON.parse(firstLine!) as { timestamp?: string }).timestamp ?? "") as string);
        if (Number.isFinite(t)) startedAt = t;
      } catch {
        // no parseable timestamp on the session_meta line -- fall back to now
      }
      const endedAt = lastTimestamp(path) ?? startedAt;
      store.applyEvent(
        sessionId,
        {
          project: info.project,
          branch: info.branch,
          cwd: meta.cwd ?? "",
          transcript_path: path,
          current_intent: firstUserMessage ? truncate(firstUserMessage) : undefined,
          harness: "codex",
          model: lastModel ?? undefined,
          harness_version: meta.cliVersion ?? undefined,
          parent_session_id: parentFromScratchpadCwd(meta.cwd),
          status: "ended",
          last_activity_at: endedAt,
          ended_at: endedAt,
        },
        startedAt
      );
      sessionsUpserted++;
    } else {
      // A live (or already-backfilled) session: enrich without ever touching
      // its status/started_at.
      const grewWhileEnded = existing.status === "ended" ? lastTimestamp(path) : null;
      store.applyEvent(
        sessionId,
        {
          harness: "codex",
          ...(lastModel ? { model: lastModel } : {}),
          ...(meta.cliVersion ? { harness_version: meta.cliVersion } : {}),
          ...(parentFromScratchpadCwd(meta.cwd) ? { parent_session_id: parentFromScratchpadCwd(meta.cwd) } : {}),
          ...(grewWhileEnded != null ? { ended_at: grewWhileEnded, last_activity_at: grewWhileEnded } : {}),
        },
        now
      );
    }

    store.setHarnessFileOffset(path, sessionId, offset, st.mtimeMs, st.size);
  }

  return { scanned, sessionsUpserted, recorded, skippedSubagentRollouts };
}
