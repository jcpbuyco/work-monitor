import { formatUsd as formatUsdExact } from "../../cost.ts";

/** Compact USD for chart labels/axes: "$10.8k", "$960", "$1.2M". `null` reuses
 *  the existing "unpriced" convention. Never used for a value under $1000 that
 *  fits the exact formatter (e.g. table cells keep `formatUsd` from cost.ts). */
export function compactUsd(n: number | null): string {
  if (n == null) return formatUsdExact(null);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  if (abs > 0 && abs < 0.01) return "<$0.01";
  // A sub-dollar amount that isn't sub-cent (e.g. a small Other-family model's
  // monthly spend) used to round straight to whole dollars, i.e. "$0" -- a
  // real value silently reading as nothing (reviewer finding, C3's tooltip).
  if (abs > 0 && abs < 1) return `${sign}$${abs.toFixed(2)}`;
  return `${sign}$${abs.toFixed(0)}`;
}

/** Compact token count for axis/label use: "14.8B", "7.9M", "920K". */
export function compactTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(Math.round(n));
}

/** The "$x+" partial-unpriced convention (CostDailyPage's `costCell`, reused
 *  here): a non-null total that nonetheless leaves out some unpriced usage
 *  gets a trailing "+", with a title explaining why -- never a plain dollar
 *  figure that quietly understates the truth. */
export function costCellText(costUsd: number | null, unpricedTokens: number): { text: string; title?: string } {
  if (costUsd == null) return { text: formatUsdExact(null) };
  if (unpricedTokens > 0) return { text: `${formatUsdExact(costUsd)}+`, title: "some usage from unpriced models" };
  return { text: formatUsdExact(costUsd) };
}

export function formatPercent(frac: number, digits = 0): string {
  return `${(frac * 100).toFixed(digits)}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09" -> "Sep" (or "Sep MTD" when it's the current month, or "Sep 2026"
 *  when the axis spans more than one calendar year). */
export function formatMonth(month: string, opts: { current?: string; withYear?: boolean } = {}): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const label = MONTHS[Number(m[2]) - 1];
  const withYear = opts.withYear ? ` ${m[1]}` : "";
  return month === opts.current ? `${label} MTD` : `${label}${withYear}`;
}

/** Neutral month-over-month delta, e.g. "+66%" / "-12%" / "flat". Spend growth
 *  is not a status (§5), so this never carries a color -- callers pair it with
 *  a plain up/down arrow glyph in text-3, never text-danger/text-done. */
export function formatDeltaPct(current: number | null, previous: number | null): string | null {
  if (current == null || previous == null || previous === 0) return null;
  const pct = ((current - previous) / previous) * 100;
  if (Math.abs(pct) < 0.5) return "flat";
  return `${pct > 0 ? "+" : ""}${pct.toFixed(0)}%`;
}
