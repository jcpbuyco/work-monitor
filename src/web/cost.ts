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
