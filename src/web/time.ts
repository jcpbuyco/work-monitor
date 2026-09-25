const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mon D" (no year) for a past epoch-ms timestamp, local time - the absolute
 *  fallback `ago()` switches to once a relative label would read as a vague
 *  number of weeks (§5.2). */
function absoluteDate(ts: number): string {
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** Relative "time ago" label for a past epoch-ms timestamp. Grows a unit at a
 *  time (s → m → h → d) and gives up on relative phrasing past a week - "4w
 *  ago" reads vaguer than the date it stands for, so `ago()` shows the date
 *  itself instead (§5.2). */
export function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  const days = Math.round(s / 86400);
  if (days < 7) return `${days}d ago`;
  return absoluteDate(ts);
}

/** A run/agent duration. Null or negative renders as an em dash; anything
 *  under 1s renders as "<1s" rather than a misleadingly precise "0s" (§5.2). */
export function formatDuration(ms: number | null): string {
  if (ms == null || ms < 0) return "—";
  if (ms < 1000) return "<1s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** An absolute instant as "Jun 16 14:03", local time. Null renders as an em dash. */
export function formatWhen(ms: number | null): string {
  if (ms == null) return "—";
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${hh}:${mm}`;
}
