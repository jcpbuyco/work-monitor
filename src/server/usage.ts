import type { Store } from "./store.ts";
import { costOf, canonicalModel, type Tokens } from "./pricing.ts";
import { readNewLines } from "./tail-lines.ts";
import { tailCodexUsage } from "./harness/codex-usage.ts";

export interface ParsedUsage {
  uuid: string;
  model: string;
  tokens: Tokens;
  at: number; // epoch ms
  /** True when the line carries a subagent marker: `isSidechain: true` or an
   *  `agentId` field. Every workflow agent transcript line has one (C3); no
   *  parent transcript line on this machine does. The parent tail path skips
   *  these so a future fold-into-parent cannot double-charge (§1.5). */
  sidechain: boolean;
  /** `message.id`, when present. Claude Code writes one JSONL line per content
   *  block (thinking/text/tool_use) and repeats `message.usage` on every one of
   *  them; this is the field that ties those lines back to the single API
   *  message they came from (§2.2). Null on lines with no message id. */
  messageId: string | null;
  /** Top-level `requestId`, when present. Combined with `messageId` into
   *  `message_key` -- `requestId` alone disambiguates the rare case of a
   *  reused message id (2 collisions in 30,296 groups on real data). */
  requestId: string | null;
}

/** `message_key` for one Claude usage line (§2.2): `message.id + ":" +
 *  (requestId ?? "")`, or null when the line has no message id -- those lines
 *  keep the old per-line `message_uuid` dedup only (recordUsage's plain
 *  INSERT OR IGNORE path). */
export function claudeMessageKey(messageId: string | null, requestId: string | null): string | null {
  return messageId ? `${messageId}:${requestId ?? ""}` : null;
}

/** Parse one transcript JSONL line into priced usage, or null if it carries none.
 *  Reads the top-level `message.usage` (already aggregates `iterations` - reading
 *  that array too would double-count). */
export function parseUsageLine(line: string): ParsedUsage | null {
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  const uuid = o?.uuid;
  const msg = o?.message;
  const usage = msg?.usage;
  if (typeof uuid !== "string" || !msg?.model || !usage) return null;
  const cc = usage.cache_creation ?? {};
  const tokens: Tokens = {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cache_read: usage.cache_read_input_tokens ?? 0,
    cache_create_5m: cc.ephemeral_5m_input_tokens ?? 0,
    cache_create_1h: cc.ephemeral_1h_input_tokens ?? 0,
  };
  const at = o.timestamp ? Date.parse(o.timestamp) : NaN;
  const sidechain = o?.isSidechain === true || o?.agentId != null;
  const messageId = typeof msg.id === "string" ? msg.id : null;
  const requestId = typeof o?.requestId === "string" ? o.requestId : null;
  return { uuid, model: msg.model, tokens, at: Number.isFinite(at) ? at : 0, sidechain, messageId, requestId };
}

/** Read new complete lines from a transcript at `path`, price them, and record
 *  them. Returns the new byte offset (the position just past the last newline,
 *  so a partially-written final line is never consumed) and whether anything new
 *  landed. Persistence of the offset is the caller's job: sessions write
 *  `sessions.usage_offset`, workflow agents write `workflow_agents.offset`.
 *
 *  `sessionId` is always the PARENT session id, including for workflow agent
 *  transcripts - `recordUsage`'s subquery stamps project/branch from that row,
 *  which is what makes every existing cost aggregation correct for free.
 *
 *  `skipSidechain` is set by the PARENT path only (see tailUsage). Never set it
 *  for an agent transcript: every line in one is a sidechain (C3). */
export function takeUsage(
  store: Store,
  t: {
    path: string;
    offset: number;
    sessionId: string;
    runId?: string;
    agentId?: string;
    skipSidechain?: boolean;
  }
): { offset: number; recorded: boolean } {
  const { offset, lines } = readNewLines(t.path, t.offset);
  let recorded = false;
  for (const ln of lines) {
    const parsed = parseUsageLine(ln);
    if (!parsed) continue;
    // §2.1: `<synthetic>` lines carry no real spend (0 tokens) and are not a
    // priced model -- skip before recording so they generate no row and no
    // "unknown model" warning, instead of a permanent $0.00 row.
    if (parsed.model === "<synthetic>") continue;
    // Double-count guard (§1.5): on the parent path, a line marked as a
    // subagent's (isSidechain / agentId) belongs to an agent-*.jsonl we tail
    // separately. A no-op today - 0 such lines exist in any parent transcript -
    // it neutralises a future fold-into-parent under fresh uuids, which
    // INSERT OR IGNORE could not dedupe. The offset still advances past it.
    if (t.skipSidechain && parsed.sidechain) continue;
    const ok = store.recordUsage({
      uuid: parsed.uuid,
      sessionId: t.sessionId,
      // Store the canonical id so per-model rollups group cleanly.
      model: canonicalModel(parsed.model),
      tokens: parsed.tokens,
      at: parsed.at,
      cost: costOf(parsed.model, parsed.tokens),
      runId: t.runId,
      agentId: t.agentId,
      // §2.2: ties every content-block line of one API message back together
      // so the store can upsert instead of inserting one priced row per line.
      messageKey: claudeMessageKey(parsed.messageId, parsed.requestId),
      // Every caller of this Claude-transcript parser is a Claude session or
      // one of its Task/workflow subagents (§4.1) - Codex/Cursor usage never
      // flows through here.
      harness: "claude",
    });
    if (ok) recorded = true;
  }
  return { offset, recorded };
}

/** Session-transcript wrapper over `takeUsage` that persists the offset onto the
 *  `sessions` row. §4.4: dispatches by the session's own harness - Claude's
 *  JSONL parser, Codex's rollout parser, or nothing at all for Cursor (it
 *  never writes usage to disk; hooks don't carry it either, per the research).
 *  `harness`/`model` are optional and default to "claude"/null so every
 *  existing caller (and test) that predates multi-harness keeps working
 *  unchanged. */
export function tailUsage(
  store: Store,
  session: { id: string; transcript_path: string | null; usage_offset: number; harness?: string; model?: string | null }
): boolean {
  if (!session.transcript_path) return false;
  const harness = session.harness ?? "claude";
  if (harness === "cursor") return false;
  if (harness === "codex") {
    return tailCodexUsage(store, {
      path: session.transcript_path,
      offset: session.usage_offset,
      sessionId: session.id,
      fallbackModel: session.model ?? null,
    });
  }
  const r = takeUsage(store, {
    path: session.transcript_path,
    offset: session.usage_offset,
    sessionId: session.id,
    // The ONLY caller that sets this. Workflow agent transcripts must not.
    skipSidechain: true,
  });
  if (r.offset !== session.usage_offset) store.setUsageOffset(session.id, r.offset);
  return r.recorded;
}
