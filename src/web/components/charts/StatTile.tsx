import type { ReactNode } from "react";
import { useTooltip } from "./useTooltip.ts";
import { Tooltip } from "./Tooltip.tsx";

/** The 48px lifetime figure + sub-line + footnote (§6, C1). Not a chart. */
export function HeroFigure({ value, subline, footnote }: { value: string; subline?: string; footnote?: string }) {
  return (
    <div>
      <div className="text-[3rem] font-semibold leading-none tracking-tight text-ink">{value}</div>
      {subline && <p className="mt-2 text-xs text-ink-3">{subline}</p>}
      {footnote && <p className="mt-1 text-2xs text-ink-4">{footnote}</p>}
    </div>
  );
}

/** One KPI tile: label, value (proportional figures -- never tabular-nums, per
 *  §5), an optional neutral delta line, and an optional sparkline/meter slot. */
export function StatTile({
  label,
  value,
  deltas,
  info,
  children,
}: {
  label: string;
  value: string;
  deltas?: { text: string; title?: string }[];
  info?: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-lg border-hairline border-border bg-surface-1 p-3">
      <div className="flex min-w-0 items-center gap-1">
        {/* truncate + title, not free wrapping: a 2-line label ("Projected
           month end") used to push its OWN value a line lower than the
           other tiles in the same row, breaking the row's shared baseline
           (reviewer finding, A16). */}
        <span className="min-w-0 truncate text-2xs text-ink-3" title={label}>
          {label}
        </span>
        {info && (
          <span aria-hidden="true" title={info} className="shrink-0 cursor-help text-3xs text-ink-4">
            ⓘ
          </span>
        )}
      </div>
      <div className="mt-1 whitespace-nowrap text-xl font-semibold text-ink">{value}</div>
      {deltas && deltas.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {deltas.map((d, i) => (
            <p key={i} title={d.title} className="text-2xs text-ink-3">
              {d.text}
            </p>
          ))}
        </div>
      )}
      {children && <div className="mt-2">{children}</div>}
    </div>
  );
}

/** 64x20 sparkline: 1.5px accent stroke, no axes, a 4px end dot at the current
 *  month, hover/focus point tooltip (§6, C1). */
export function Sparkline({ points, labels }: { points: number[]; labels: string[] }) {
  const tooltip = useTooltip();
  if (points.length === 0) return null;
  const w = 64;
  const h = 20;
  const max = Math.max(1, ...points);
  const min = Math.min(0, ...points);
  const x = (i: number) => (points.length <= 1 ? w : (i / (points.length - 1)) * w);
  const y = (v: number) => h - ((v - min) / (max - min || 1)) * (h - 4) - 2;
  const path = points.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`).join(" ");
  return (
    <div className="relative inline-block">
      <svg width={w} height={h} className="overflow-visible">
        <path d={path} fill="none" stroke="var(--viz-s1)" strokeWidth={1.5} />
        {points.map((v, i) => (
          <circle
            key={i}
            cx={x(i)}
            cy={y(v)}
            r={i === points.length - 1 ? 2 : 5}
            fill={i === points.length - 1 ? "var(--viz-s1)" : "transparent"}
            tabIndex={0}
            role="img"
            aria-label={labels[i]}
            onMouseEnter={(e) => tooltip.showFromEvent(e, labels[i])}
            onFocus={(e) => tooltip.showFromElement(e.currentTarget, labels[i])}
            onMouseLeave={tooltip.hide}
            onBlur={tooltip.hide}
          />
        ))}
      </svg>
      <Tooltip state={tooltip.state} />
    </div>
  );
}

/** Cache-hit-rate meter: a soft track + accent fill, same ramp identity as the
 *  delegation pair (§6, C1). */
export function Meter({ frac, label }: { frac: number; label: string }) {
  return (
    <div className="mt-1.5" role="img" aria-label={label}>
      <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: "color-mix(in srgb, var(--viz-s1-soft) 35%, transparent)" }}>
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, frac * 100))}%`, background: "var(--viz-s1)" }} />
      </div>
    </div>
  );
}
