/** `null` means unpriced (an unknown model, or a row awaiting the next
 *  repricing pass) -- never a fabricated $0.00 (server: pricing.ts §2.1/§2.3).
 *  Renders as a plain word so it reads as "we don't know" rather than "free". */
export function formatUsd(n: number | null): string {
  if (n == null) return "unpriced";
  if (n > 0 && n < 0.01) return "<$0.01";
  // Thousands-grouped (`toLocaleString`, not `toFixed`): an exact table cell
  // or tooltip value in the thousands used to print with no separator at all
  // ("$3205.65"), the one thing that read differently from every whole-dollar
  // figure elsewhere on the page (reviewer finding, B9).
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatTokens(n: number): string {
  // §6 (Insights): a lifetime total can reach into the billions (14.79B
  // tokens on the current copy) -- without this case it fell through to the
  // millions branch and printed an unreadable "14787.2M".
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(n);
}

/** Whole-dollar, thousands-separated USD for a big standalone figure (a hero
 *  number, a KPI tile, a records-strip value) -- distinct from `formatUsd`'s
 *  exact-cents convention, which stays for table cells and axis ticks (§5:
 *  "Large standalone numbers ... use proportional figures"). `null` keeps the
 *  same "unpriced" convention as `formatUsd`. */
export function formatUsdWhole(n: number | null): string {
  if (n == null) return formatUsd(null);
  // A genuinely sub-dollar standalone figure (a small harness's monthly
  // total, say) keeps `formatUsd`'s cents -- rounding it to whole dollars
  // would print "$0" or "$1" for a real, nonzero amount (reviewer finding;
  // previously every call site had to remember this exception itself).
  if (n > 0 && n < 1) return formatUsd(n);
  return "$" + Math.round(n).toLocaleString("en-US");
}

/** "claude-opus-4-8" → "Opus 4.8"; unknown ids are best-effort title-cased.
 *  Strips a trailing date snapshot (e.g. "-20251001") for clean labels. GPT
 *  ids keep their conventional hyphen ("gpt-5.5" → "GPT-5.5") rather than the
 *  Claude/Grok-style space - §5.1's per-harness model pill.
 *
 *  §5.3: a bracket-suffixed context-window variant (`claude-opus-5-5[1m]`,
 *  from a workflow manifest's `model`/`defaultModel` -- never `message.model`
 *  itself) renders as "Opus 5.5 · 1M" rather than the raw "Opus 5.5[1m]": the
 *  bracket is stripped BEFORE the name/version split, and its content re-
 *  appended as a separate, uppercased " · 1M" token so it reads as a distinct
 *  fact (the context window), not part of the version number. */
export function prettyModel(id: string): string {
  const bracket = /\[([^\]]+)\]$/.exec(id);
  const base = bracket ? id.slice(0, bracket.index) : id;
  const parts = base.replace(/^claude-/, "").replace(/-\d{8}$/, "").split("-");
  const suffix = bracket ? ` · ${bracket[1].toUpperCase()}` : "";
  if (parts.length === 0 || !parts[0]) return id;
  const ver = parts.slice(1).join(".");
  if (parts[0].toLowerCase() === "gpt") return (ver ? `GPT-${ver}` : "GPT") + suffix;
  const name = parts[0][0].toUpperCase() + parts[0].slice(1);
  return (ver ? `${name} ${ver}` : name) + suffix;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-06-16" → "Jun 16". Returns the input unchanged if it isn't an ISO day. */
export function formatDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

export type CostWindow = 7 | 14 | 30 | "all";

/** `since` epoch-ms for a window: local midnight (N-1) days before `nowMs`.
 *  "all" → no lower bound. `until` is always left open (up to now). */
export function costDailyRange(window: CostWindow, nowMs: number): { since?: number } {
  if (window === "all") return {};
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (window - 1));
  return { since: d.getTime() };
}
