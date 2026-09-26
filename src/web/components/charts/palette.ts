import type { Family } from "../../../shared/modelFamily.ts";

/** Model family -> categorical slot, fixed order, never cycled (§5). */
export const FAMILY_VAR: Record<Family, string> = {
  Fable: "var(--viz-s1)",
  Opus: "var(--viz-s2)",
  Sonnet: "var(--viz-s3)",
  Other: "var(--viz-other)",
};

export const FAMILY_ORDER: Family[] = ["Fable", "Opus", "Sonnet", "Other"];

export type WorkKind = "main" | "subagent" | "workflow";

/** Who-does-the-work ordinal ramp: no delegation -> orchestrated (§6, C6). */
export const KIND_VAR: Record<WorkKind, string> = {
  main: "var(--viz-other)",
  subagent: "var(--viz-s1-soft)",
  workflow: "var(--viz-s1)",
};
export const KIND_ORDER: WorkKind[] = ["main", "subagent", "workflow"];
export const KIND_LABEL: Record<WorkKind, string> = {
  main: "Main session",
  subagent: "Task subagents",
  workflow: "Workflow agents",
};

export type TokenClass = "cacheRead" | "cacheWrite" | "output" | "input";

/** Cost-by-token-class encoding (§6, C5). Cache read/write -- the two
 *  context steps this card exists to call out -- share one ramp (two steps of
 *  the page's own sequential language, not the categorical s1/s2 slots) so
 *  this card's blue no longer reads as the SAME entity as C3's Fable directly
 *  above it (reviewer finding, B20: "the blue bottom segment reads as the
 *  same entity" between two vertically stacked cards). Output keeps a
 *  categorical slot since it is the one segment users compare against other
 *  charts' "output" meaning; uncached input (usually sub-pixel) stays
 *  neutral. */
export const TOKEN_CLASS_VAR: Record<TokenClass, string> = {
  cacheRead: "var(--viz-seq-4)",
  cacheWrite: "var(--viz-seq-2)",
  output: "var(--viz-s2)",
  input: "var(--viz-other)",
};
export const TOKEN_CLASS_ORDER: TokenClass[] = ["cacheRead", "cacheWrite", "output", "input"];
export const TOKEN_CLASS_LABEL: Record<TokenClass, string> = {
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  output: "Output",
  input: "Uncached input",
};

/** The 5-step sequential ramp shared by the lifetime calendar (C9) and the
 *  weekly rhythm grid (C10) -- "one sequential language on the page" (§6). */
export const SEQ_VARS = ["var(--viz-seq-1)", "var(--viz-seq-2)", "var(--viz-seq-3)", "var(--viz-seq-4)", "var(--viz-seq-5)"];
export const EMPTY_VAR = "var(--viz-empty)";

/** The same ramp's raw hex per theme (styles.css's `--viz-seq-*`), duplicated
 *  here ONLY so `HeatTable`'s in-cell ink picker can compute real contrast --
 *  dark mode's ramp runs light-to-dark in the OPPOSITE direction from
 *  light mode's (§5: "more = darker in light, more = lighter in dark"), so a
 *  single "high bin -> white text" rule is backwards in one theme or the
 *  other; see `inkForFill`. */
export const SEQ_HEX: Record<"light" | "dark", string[]> = {
  light: ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#104281"],
  dark: ["#184f95", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4"],
};

/** WCAG relative luminance of a `#rrggbb` hex color. */
function relativeLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const DARK_INK_LUMINANCE = relativeLuminance("#131826"); // light theme's text-1
const WHITE_LUMINANCE = 1;

function contrast(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** The higher-contrast ink ("#ffffff" or the light theme's near-black text-1)
 *  for text filling a `SEQ_HEX[mode][binIndex]` swatch -- computed from the
 *  real color, not a hardcoded "high bin = light background" assumption that
 *  only holds in one theme (§5: "a label inside a filled mark picks text-1 of
 *  the light theme or #ffffff, whichever has higher contrast"). */
export function inkForFill(mode: "light" | "dark", binIndex: number): string {
  const L = relativeLuminance(SEQ_HEX[mode][binIndex] ?? SEQ_HEX[mode][SEQ_HEX[mode].length - 1]);
  return contrast(L, WHITE_LUMINANCE) > contrast(L, DARK_INK_LUMINANCE) ? "#ffffff" : "#131826";
}
