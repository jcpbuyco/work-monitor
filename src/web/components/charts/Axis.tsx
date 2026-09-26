import { compactUsd, compactTokens } from "./format.ts";
import { measureText } from "./measureText.ts";
import { useRootPx } from "../../useRootPx.ts";
import { TICK_CLASS, TICK_PX_AT_16, VALUE_CLASS, LABEL_HALO, scaleOf } from "./typography.ts";

/** The left gutter a `YAxis` needs to show its widest tick label without
 *  drawing over the plot's own data marks -- `x0` on `YAxis` and the caller's
 *  own band/linear x-range both start here instead of at 0 (finding: ticks at
 *  x=0 sat directly on top of column caps and step lines starting at the same
 *  x). Callers compute this BEFORE laying out their x scale, since the scale
 *  itself needs to start after it. */
export function yAxisGutter(ticks: number[], format: ((v: number) => string) | undefined, rootPx: number): number {
  const fmt = format ?? ((v: number) => compactUsd(v));
  const scale = scaleOf(rootPx);
  const widest = ticks.length ? Math.max(...ticks.map((t) => measureText(fmt(t), TICK_PX_AT_16 * scale))) : 0;
  return Math.ceil(widest) + 6 * scale;
}

/** Value (y) axis: hairline gridlines at each tick, a solid baseline at 0,
 *  tabular tick labels in text-4, right-aligned in the `x0` gutter. One axis
 *  only -- every chart in this package plots a single measure against it
 *  (§5's dual-axis ban). */
export function YAxis({
  ticks,
  y,
  width,
  format,
  x0 = 0,
}: {
  ticks: number[];
  y: (v: number) => number;
  width: number;
  format?: (v: number) => string;
  /** Left edge of the plotted data, reserved for this axis's own tick labels
   *  -- see `yAxisGutter`. Defaults to 0 (the pre-gutter behaviour) for any
   *  caller that hasn't opted in yet. */
  x0?: number;
}) {
  const rootPx = useRootPx();
  const scale = scaleOf(rootPx);
  const fmt = format ?? ((v: number) => compactUsd(v));
  return (
    <g aria-hidden="true">
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={x0}
            x2={width}
            y1={y(t)}
            y2={y(t)}
            className={t === 0 ? "stroke-border" : "stroke-border-weak"}
            strokeWidth={1}
          />
          {/* Centred on its own gridline (never "4px above it", which used to
              be the one tick that broke the pattern every other tick already
              followed -- reviewer finding) and right-aligned INSIDE the
              gutter, never over the plot's own marks. */}
          <text x={x0 - 6 * scale} y={y(t)} dominantBaseline="central" textAnchor="end" className={TICK_CLASS} style={LABEL_HALO}>
            {fmt(t)}
          </text>
        </g>
      ))}
    </g>
  );
}

export function tokenAxisFormat(v: number): string {
  return compactTokens(v);
}

/** Band (x) axis: one tick label per band, optionally a second line under it
 *  (C6's "7 runs / 46 runs / 160 runs" row, C11's active-hour count). Labels
 *  clamp to stay inside [0, width] instead of bleeding into the card's own
 *  padding at either edge (finding, A18). */
export function XAxisBand({
  labels,
  at,
  bandwidth,
  y,
  width,
  second,
  currentIndex,
}: {
  labels: string[];
  at: (key: string) => number;
  bandwidth: number;
  y: number;
  /** Plot width, to clamp the first/last label's anchor so it never bleeds
   *  past either edge. Optional -- omitted, labels anchor at their band
   *  centre exactly as before. */
  width?: number;
  second?: string[];
  currentIndex?: number;
}) {
  const rootPx = useRootPx();
  const scale = scaleOf(rootPx);
  const clampX = (x: number) => (width == null ? x : Math.min(Math.max(x, 0), width));
  return (
    <g>
      {labels.map((label, i) => (
        <g key={label + i}>
          <text
            x={clampX(at(label) + bandwidth / 2)}
            y={y + 14 * scale}
            textAnchor="middle"
            className={`text-3xs ${i === currentIndex ? "fill-ink-2 font-medium" : "fill-ink-4"}`}
            style={LABEL_HALO}
          >
            {label}
          </text>
          {second && (
            <text x={clampX(at(label) + bandwidth / 2)} y={y + 26 * scale} textAnchor="middle" className={TICK_CLASS} style={LABEL_HALO}>
              {second[i]}
            </text>
          )}
        </g>
      ))}
    </g>
  );
}

/** Thin a row of x-axis band labels when the row is too narrow for every one
 *  of them at the current (scaled) text size -- e.g. "Aug" and "Sep MTD"
 *  reading as one garbled "AuSep MTD" once text scaled up on a phone-width
 *  axis (reviewer finding, R4: this collision handling existed only in
 *  `StackedColumns`, not the OTHER band-x-axis chart on the page, `Leverage`'s
 *  own `Panel`).
 *
 *  Always keeps the first, the last, and the current index, but NOT by
 *  unconditionally showing every Nth label and then separately forcing those
 *  three on top -- a modulo-selected label landing one column before a
 *  forced one (Aug at a step of 2, immediately before a force-shown Sep MTD)
 *  still collided with it, recreating the exact garble this function exists
 *  to prevent (reviewer finding, regression found while re-verifying).
 *  Instead: a left-to-right greedy pass shows a label once it's at least
 *  `minStep` columns past the last SHOWN one (forced indices always show and
 *  reset that counter), then a right-to-left cleanup pass drops any
 *  non-forced label that ended up too close to a LATER forced one. */
export function thinBandLabels(labels: string[], currentIndex: number | undefined, pitchPx: number, px: number, scale: number): (string | null)[] {
  const n = labels.length;
  if (n <= 1) return labels;
  const gap = 4 * scale;
  const widest = Math.max(...labels.map((l) => measureText(l, px)));
  const minStep = Math.max(1, Math.ceil((widest + gap) / pitchPx));
  const forced = new Set<number>([0, n - 1]);
  if (currentIndex != null && currentIndex >= 0) forced.add(currentIndex);

  const shown = new Array<boolean>(n).fill(false);
  let lastShown = -Infinity;
  for (let i = 0; i < n; i++) {
    if (forced.has(i) || i - lastShown >= minStep) {
      shown[i] = true;
      lastShown = i;
    }
  }
  for (let i = n - 2; i >= 0; i--) {
    if (!shown[i] || forced.has(i)) continue;
    let j = i + 1;
    while (j < n && !shown[j]) j++;
    if (j < n && j - i < minStep) shown[i] = false;
  }
  return labels.map((l, i) => (shown[i] ? l : null));
}

export { VALUE_CLASS };
