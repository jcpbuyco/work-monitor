export interface Tokens {
  input: number;
  output: number;
  cache_read: number;
  cache_create_5m: number;
  cache_create_1h: number;
}

interface Rate {
  input: number; // USD per million input tokens
  output: number; // USD per million output tokens
  cacheRead: number; // USD per million cache-read tokens (explicit, not a multiplier)
  cacheWrite5m: number; // USD per million 5-minute cache-write tokens
  cacheWrite1h: number; // USD per million 1-hour cache-write tokens
}

// Published list prices (USD / MTok), all five fields explicit -- no global
// multipliers (§2.1). Two models (fable-5-1, opus-5-5) have a cheaper cache-read
// rate than the rest of their family, which a shared multiplier could not express.
const RATES: Record<string, Rate> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  "claude-mythos-5": { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite5m: 0, cacheWrite1h: 0 },
  "gpt-5.3-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite5m: 0, cacheWrite1h: 0 },
};

// Bare family aliases that transcripts sometimes emit (e.g. from subagents),
// mapped to a current canonical id of the right pricing tier. Display-only for
// `opus`: the alias is genuinely ambiguous between claude-opus-5 and
// claude-opus-5-5 (both seen resolving from it), so it stays pointed at the
// non-5.5 tier rather than silently costing at the wrong rate either way.
const FAMILY_ALIAS: Record<string, string> = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  // NOT re-pointed: there is no claude-haiku-5 rate, so pointing `haiku` at one
  // would send it to costOf's unknown-model branch and cost it $0.
  haiku: "claude-haiku-4-5",
  fable: "claude-fable-5-1",
  mythos: "claude-mythos-5",
};

/** Normalize a transcript model id to a `RATES` key. Real transcripts emit
 *  date-snapshotted ids (`claude-haiku-4-5-20251001`), bracket-suffixed context
 *  variants (`claude-opus-5-5[1m]` -- from the workflow manifest's `model`/
 *  `defaultModel`, never `message.model` itself), and bare aliases
 *  (`sonnet`/`haiku`). Strip the bracket suffix BEFORE the date suffix -- a
 *  bracket-suffixed id never itself ends in 8 digits, so stripping in the other
 *  order would miss the date on a (hypothetical) combination of both. */
export function canonicalModel(model: string): string {
  const stripped = model.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
  return FAMILY_ALIAS[stripped] ?? stripped;
}

const warned = new Set<string>();

/** USD cost of one message's token usage, or `null` when the model has no
 *  entry in `RATES` -- unpriced, not free (§2.1). Unknown model → logged once. */
export function costOf(model: string, t: Tokens): number | null {
  const rate = RATES[canonicalModel(model)];
  if (!rate) {
    if (!warned.has(model)) {
      console.warn(`[pricing] unknown model, unpriced: ${model}`);
      warned.add(model);
    }
    return null;
  }
  return (
    (t.input * rate.input +
      t.output * rate.output +
      t.cache_read * rate.cacheRead +
      t.cache_create_5m * rate.cacheWrite5m +
      t.cache_create_1h * rate.cacheWrite1h) /
    1e6
  );
}

/** FNV-1a over a sorted-key JSON string -- stable regardless of the source
 *  object's own key order. Exported so a test can hash a modified/reordered
 *  table directly instead of only ever comparing the live constant to itself. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Stable, sorted-key JSON of an id->value table, for hashing. */
function sortedJson<T>(table: Record<string, T>): string {
  return JSON.stringify(Object.keys(table).sort().map((k) => [k, table[k]]));
}

/** Any rate change, alias re-point, OR added/removed alias bumps this, which
 *  is what triggers the generic repricing pass (reprice.ts) to recompute every
 *  stored `cost_usd` from scratch at startup (§2.3). `FAMILY_ALIAS` is hashed
 *  alongside `RATES`: canonicalModel() resolves through both, so re-pointing
 *  an alias alone (e.g. this change's `fable` -> `claude-fable-5-1`) changes
 *  every price it resolves to just as much as editing `RATES` itself would,
 *  and must trigger the same reprice. */
export const RATES_VERSION = fnv1a(sortedJson(RATES) + "|" + sortedJson(FAMILY_ALIAS));
