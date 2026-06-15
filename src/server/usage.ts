import type { Tokens } from "./pricing.ts";

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
