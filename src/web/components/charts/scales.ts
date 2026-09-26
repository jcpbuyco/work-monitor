/** Linear scale: maps a value in [domainMin, domainMax] to [rangeMin, rangeMax]. */
export function linear(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  return (v: number): number => (span === 0 ? r0 : r0 + ((v - d0) / span) * (r1 - r0));
}

/** Log10 scale. `domain[0]` must be > 0 (callers clamp a $0 value up first --
 *  C7's log axis starts at $0.10, never $0). */
export function log10(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const l0 = Math.log10(Math.max(d0, 1e-9));
  const l1 = Math.log10(Math.max(d1, d0 * 10));
  const span = l1 - l0;
  return (v: number): number => {
    const lv = Math.log10(Math.max(v, d0));
    return span === 0 ? r0 : r0 + ((lv - l0) / span) * (r1 - r0);
  };
}

/** Band scale: N discrete slots evenly spaced across `range`, each `bandwidth`
 *  wide with `paddingRatio` of gap on each side (d3-style). */
export function band(domain: string[], range: [number, number], paddingRatio = 0.3) {
  const [r0, r1] = range;
  const n = Math.max(domain.length, 1);
  const step = (r1 - r0) / n;
  const bandwidth = step * (1 - paddingRatio);
  const index = new Map(domain.map((d, i) => [d, i]));
  const at = (key: string): number => {
    const i = index.get(key) ?? 0;
    return r0 + i * step + (step - bandwidth) / 2;
  };
  return { at, step, bandwidth };
}

/** "Nice" round tick values from 0 to at least `max`, roughly `count` of them
 *  (e.g. niceTicks(2982, 4) -> [0, 1000, 2000, 3000]). */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const roughStep = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const residual = roughStep / magnitude;
  let niceStep: number;
  if (residual > 5) niceStep = 10 * magnitude;
  else if (residual > 2) niceStep = 5 * magnitude;
  else if (residual > 1) niceStep = 2 * magnitude;
  else niceStep = magnitude;
  const ticks: number[] = [];
  for (let v = 0; v <= max + niceStep * 0.999; v += niceStep) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

/** Log-scale ticks: every power of 10 from the decade below `min` through the
 *  decade at/above `max` (C7/C8's "$0.10 / $1 / $10 / $100" ladder). */
export function logTicks(min: number, max: number): number[] {
  const lo = Math.floor(Math.log10(Math.max(min, 1e-9)));
  const hi = Math.ceil(Math.log10(Math.max(max, min * 10)));
  const out: number[] = [];
  for (let e = lo; e <= hi; e++) out.push(10 ** e);
  return out;
}

/** Quantile bin edges over a set of values, into `n` bins (default 5, for the
 *  calendar/rhythm sequential ramp). Returns `n+1` edges; `binOf` maps a value
 *  to its 0-based bin index. Zero/absent values are the caller's job to keep
 *  out of `values` (they get the dedicated empty color, not bin 0). */
export function quantileEdges(values: number[], n = 5): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Array.from({ length: n + 1 }, () => 0);
  const edges: number[] = [];
  for (let i = 0; i <= n; i++) {
    const pos = (i / n) * (sorted.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    const frac = pos - lo;
    edges.push(sorted[lo] + (sorted[hi] - sorted[lo]) * frac);
  }
  return edges;
}

export function binOf(value: number, edges: number[]): number {
  const n = edges.length - 1;
  for (let i = 0; i < n; i++) {
    if (value <= edges[i + 1] || i === n - 1) return i;
  }
  return n - 1;
}
