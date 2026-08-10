import { openSync, fstatSync, readSync, closeSync } from "node:fs";
import type { Store } from "./store.ts";
import { costOf, canonicalModel, type Tokens } from "./pricing.ts";

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
}

/** Parse one transcript JSONL line into priced usage, or null if it carries none.
 *  Reads the top-level `message.usage` (already aggregates `iterations` — reading
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
  return { uuid, model: msg.model, tokens, at: Number.isFinite(at) ? at : 0, sidechain };
}

/** Read new complete lines from a transcript at `path`, price them, and record
 *  them. Returns the new byte offset (the position just past the last newline,
 *  so a partially-written final line is never consumed) and whether anything new
 *  landed. Persistence of the offset is the caller's job: sessions write
 *  `sessions.usage_offset`, workflow agents write `workflow_agents.offset`.
 *
 *  `sessionId` is always the PARENT session id, including for workflow agent
 *  transcripts — `recordUsage`'s subquery stamps project/branch from that row,
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
  let fd: number;
  try {
    fd = openSync(t.path, "r");
  } catch {
    return { offset: t.offset, recorded: false }; // missing / unreadable
  }
  try {
    const size = fstatSync(fd).size;
    // Short-circuit BEFORE reading: agent transcripts reach 6.3MB and are polled
    // every 5s, so this is the difference between idle and tens of MB a minute.
    let offset = t.offset;
    if (offset < 0 || offset > size) offset = 0; // shrank / rotated → re-read
    if (size === offset) return { offset, recorded: false };

    const buf = Buffer.allocUnsafe(size - offset);
    // readSync may legally return a SHORT count, and the tail of an allocUnsafe
    // buffer is uninitialized memory — never look past what was actually read.
    const got = readSync(fd, buf, 0, buf.length, offset);
    if (got <= 0) return { offset, recorded: false };
    const chunk = buf.subarray(0, got);
    // Find the last newline BYTE: 0x0A never occurs inside a multi-byte UTF-8
    // sequence, so this is exact without decoding first.
    const nl = chunk.lastIndexOf(0x0a);
    if (nl < 0) return { offset, recorded: false }; // no complete new line

    let recorded = false;
    for (const ln of chunk.subarray(0, nl + 1).toString("utf8").split("\n")) {
      if (!ln.trim()) continue;
      const parsed = parseUsageLine(ln);
      if (!parsed) continue;
      // Double-count guard (§1.5): on the parent path, a line marked as a
      // subagent's (isSidechain / agentId) belongs to an agent-*.jsonl we tail
      // separately. A no-op today — 0 such lines exist in any parent transcript —
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
      });
      if (ok) recorded = true;
    }
    return { offset: offset + nl + 1, recorded };
  } finally {
    closeSync(fd);
  }
}

/** Session-transcript wrapper over `takeUsage` that persists the offset onto the
 *  `sessions` row. Signature unchanged so http.ts and the 60s sweep still work. */
export function tailUsage(
  store: Store,
  session: { id: string; transcript_path: string | null; usage_offset: number }
): boolean {
  if (!session.transcript_path) return false;
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
