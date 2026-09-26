import type { CSSProperties } from "react";

/** Two chart text roles (finding: SVG labels were fixed at 9/10/11px with no
 *  role mapping, while every surrounding HTML label followed the A-/A+
 *  setting) -- both rem-based Tailwind tokens, so they scale exactly like the
 *  rest of the page's text instead of needing their own px math.
 *
 *  "tick": axis ticks, month/weekday row labels, second lines, scale-legend
 *  captions -- text-3xs (0.625rem = 10px @16, matching the old 9/10px sizes).
 *  "value": direct/cap/end labels that carry a number the reader is meant to
 *  read at a glance -- text-2xs font-medium (0.6875rem = 11px @16, matching
 *  the old 10/11px "value" sizes). */
export const TICK_CLASS = "fill-ink-4 text-3xs tabular-nums";
export const VALUE_CLASS = "fill-ink-2 text-2xs font-medium tabular-nums";

/** The rem sizes above, in px at the default 16px root -- fed to
 *  `measureText` (which needs a real px size, not a class name) after scaling
 *  by the current root size. */
export const TICK_PX_AT_16 = 10; // text-3xs, 0.625rem
export const VALUE_PX_AT_16 = 11; // text-2xs, 0.6875rem

/** rootPx -> the multiplier every hand-computed pixel offset (axis gutters,
 *  label baselines, minimum cell sizes) should scale by, so chart geometry
 *  keeps pace with the text-size setting the same way rem-based HTML already
 *  does. 1 at the default 16px root. */
export function scaleOf(rootPx: number): number {
  return rootPx / 16;
}

/** The px band a chart needs below its plot for one or two lines of x-axis
 *  text (a month tick, plus an optional second line -- a MoM delta, a run
 *  count) at the CURRENT root size -- not a flat constant, which fit only the
 *  old fixed 9/10px labels. At a larger text size, two lines of now-larger
 *  text no longer fit the old fixed band and painted into the card's own
 *  bottom padding below the SVG (reviewer finding, R5). Callers use this both
 *  for the chart's own SVG height AND for the `height` budget they pass their
 *  `ChartCard` (so the card's floor grows in step with the axis band it has
 *  to make room for -- otherwise `ChartCard`'s `min-height` floor stays put
 *  while the chart draws past it). */
export function xAxisBandPx(rootPx: number, lines: 1 | 2 = 1): number {
  const scale = scaleOf(rootPx);
  return (lines === 2 ? 30 : 14) * scale + 6 * scale;
}

/** A surface-colour halo behind a label that can sit over a data mark (a
 *  gridline, a step line, another dot) -- `paint-order: stroke` draws the
 *  stroke UNDER the fill, so the glyph itself stays crisp while its
 *  background is punched out just enough to read against whatever crosses
 *  it (finding: axis and end labels struck through by their own line/mark). */
export const LABEL_HALO: CSSProperties = {
  paintOrder: "stroke",
  stroke: "hsl(var(--surface-1))",
  strokeWidth: 3,
  strokeLinejoin: "round",
};
