import { compactUsd, compactTokens } from "./format.ts";

/** Value (y) axis: hairline gridlines at each tick, a solid baseline at 0,
 *  tabular tick labels in text-4. One axis only -- every chart in this
 *  package plots a single measure against it (§5's dual-axis ban). */
export function YAxis({
  ticks,
  y,
  width,
  format,
}: {
  ticks: number[];
  y: (v: number) => number;
  width: number;
  format?: (v: number) => string;
}) {
  const fmt = format ?? ((v: number) => compactUsd(v));
  return (
    <g aria-hidden="true">
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={0}
            x2={width}
            y1={y(t)}
            y2={y(t)}
            className={t === 0 ? "stroke-border" : "stroke-border-weak"}
            strokeWidth={1}
          />
          {/* clamp: a "nice" top tick sits exactly at the plot's y=0, and an
              unclamped label (drawn 4px ABOVE its gridline) would float above
              the SVG's own top edge and collide with the card header/subtitle
              sitting right above it (finding: pixel-picky visual check). */}
          <text x={0} y={Math.max(9, y(t) - 4)} className="fill-ink-4 text-[10px] tabular-nums">
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
 *  (C6's "7 runs / 46 runs / 160 runs" row, C11's active-hour count). */
export function XAxisBand({
  labels,
  at,
  bandwidth,
  y,
  second,
  currentIndex,
}: {
  labels: string[];
  at: (key: string) => number;
  bandwidth: number;
  y: number;
  second?: string[];
  currentIndex?: number;
}) {
  return (
    <g>
      {labels.map((label, i) => (
        <g key={label + i}>
          <text
            x={at(label) + bandwidth / 2}
            y={y + 14}
            textAnchor="middle"
            className={`text-[10px] ${i === currentIndex ? "fill-ink-2 font-medium" : "fill-ink-4"}`}
          >
            {label}
          </text>
          {second && (
            <text x={at(label) + bandwidth / 2} y={y + 26} textAnchor="middle" className="fill-ink-4 text-[9px] tabular-nums">
              {second[i]}
            </text>
          )}
        </g>
      ))}
    </g>
  );
}
