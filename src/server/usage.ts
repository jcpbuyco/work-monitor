import { readFileSync } from "node:fs";
import type { Store } from "./store.ts";
import { costOf, canonicalModel, type Tokens } from "./pricing.ts";

export interface ParsedUsage {
  uuid: string;
  model: string;
  tokens: Tokens;
  at: number; // epoch ms
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
  return { uuid, model: msg.model, tokens, at: Number.isFinite(at) ? at : 0 };
}

/** Read new complete lines from a session's transcript, price them, and record
 *  them. Advances usage_offset to the last newline so a partially-written final
 *  line is never consumed. Idempotent via the message_uuid primary key. */
export function tailUsage(
  store: Store,
  session: { id: string; transcript_path: string | null; usage_offset: number }
): boolean {
  const path = session.transcript_path;
  if (!path) return false;

  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return false; // missing / unreadable
  }

  let offset = session.usage_offset;
  if (offset > content.length) offset = 0; // file shrank/rotated → re-read

  const end = content.lastIndexOf("\n") + 1; // 0 when there is no newline
  if (end <= offset) return false; // no complete new line since last time

  let recorded = false;
  for (const ln of content.slice(offset, end).split("\n")) {
    if (!ln.trim()) continue;
    const parsed = parseUsageLine(ln);
    if (!parsed) continue;
    const ok = store.recordUsage({
      uuid: parsed.uuid,
      sessionId: session.id,
      // Store the canonical id so per-model rollups group cleanly (a
      // date-snapshotted id and its bare form are the same model).
      model: canonicalModel(parsed.model),
      tokens: parsed.tokens,
      at: parsed.at,
      cost: costOf(parsed.model, parsed.tokens),
    });
    if (ok) recorded = true;
  }
  store.setUsageOffset(session.id, end);
  return recorded;
}
