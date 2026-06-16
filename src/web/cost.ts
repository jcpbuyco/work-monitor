export function formatUsd(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01";
  return "$" + n.toFixed(2);
}

export function formatTokens(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(n);
}

/** "claude-opus-4-8" → "Opus 4.8"; unknown ids are best-effort title-cased.
 *  Strips a trailing date snapshot (e.g. "-20251001") for clean labels. */
export function prettyModel(id: string): string {
  const parts = id.replace(/^claude-/, "").replace(/-\d{8}$/, "").split("-");
  if (parts.length === 0 || !parts[0]) return id;
  const name = parts[0][0].toUpperCase() + parts[0].slice(1);
  const ver = parts.slice(1).join(".");
  return ver ? `${name} ${ver}` : name;
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
