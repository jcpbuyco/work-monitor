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
}

// Published list prices (USD / MTok). Keep current as models change.
const RATES: Record<string, Rate> = {
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
};

const CACHE_READ_MULT = 0.1;
const CACHE_CREATE_5M_MULT = 1.25;
const CACHE_CREATE_1H_MULT = 2.0;

const warned = new Set<string>();

/** USD cost of one message's token usage. Unknown model → 0 (warned once). */
export function costOf(model: string, t: Tokens): number {
  const rate = RATES[model];
  if (!rate) {
    if (!warned.has(model)) {
      console.warn(`[pricing] unknown model, costing $0: ${model}`);
      warned.add(model);
    }
    return 0;
  }
  const inPer = rate.input / 1e6;
  const outPer = rate.output / 1e6;
  return (
    t.input * inPer +
    t.output * outPer +
    t.cache_read * inPer * CACHE_READ_MULT +
    t.cache_create_5m * inPer * CACHE_CREATE_5M_MULT +
    t.cache_create_1h * inPer * CACHE_CREATE_1H_MULT
  );
}
