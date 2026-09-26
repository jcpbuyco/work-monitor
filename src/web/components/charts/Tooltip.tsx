import type { TooltipState } from "./useTooltip.ts";

/** Fixed-position tooltip, clamped to the viewport. `fixed` positioning (not a
 *  React portal) already escapes any card's `overflow`/clipping, which is the
 *  property a portal exists to buy here -- avoids the extra machinery for the
 *  same visible result. Value first (text-1 semibold), label second (text-3),
 *  per §8. */
export function Tooltip({ state }: { state: TooltipState }) {
  if (!state.open || state.content == null) return null;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const x = Math.min(Math.max(state.x, 90), vw - 90);
  const y = Math.max(state.y, 8);
  return (
    <div
      role="tooltip"
      data-testid="chart-tooltip"
      className="pointer-events-none fixed z-40 max-w-[15rem] -translate-x-1/2 -translate-y-full rounded-md border-hairline border-border bg-surface-1 px-2.5 py-1.5 text-2xs shadow-pop"
      style={{ left: x, top: y }}
    >
      {state.content}
    </div>
  );
}

/** Shared row shape inside a tooltip: a swatch/line key, a label in text-3,
 *  and a value in text-1 (never the series color on text). */
export function TooltipRow({ swatch, label, value, indent = false }: { swatch?: string; label: string; value: string; indent?: boolean }) {
  return (
    <div className={`flex items-center gap-1.5 ${indent ? "pl-3" : ""}`}>
      {swatch && <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-sm" style={{ background: swatch }} />}
      <span className="min-w-0 flex-1 truncate text-ink-3">{label}</span>
      <span className="shrink-0 whitespace-nowrap tabular-nums slashed-zero font-medium text-ink">{value}</span>
    </div>
  );
}
