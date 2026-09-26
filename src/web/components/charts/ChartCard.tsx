import { useId, useState, type ReactNode } from "react";
import { Segmented, Skeleton } from "../primitives.tsx";

export type ChartView = "chart" | "table";

/** The one card shell every Insights chart mounts inside (§4/§8): title +
 *  metric subtitle, a Chart|Table Segmented toggle, an optional legend row, a
 *  fixed-height body (skeleton while first loading, dimmed while refetching,
 *  or a one-line empty message), and an optional footer source note. */
export function ChartCard({
  title,
  subtitle,
  legend,
  height,
  loading,
  refetching,
  empty,
  footer,
  view,
  onViewChange,
  children,
  table,
  right,
  below,
}: {
  title: string;
  subtitle?: string;
  legend?: ReactNode;
  height: number;
  loading?: boolean;
  refetching?: boolean;
  empty?: boolean;
  footer?: string;
  view: ChartView;
  onViewChange: (v: ChartView) => void;
  children: ReactNode;
  table: ReactNode;
  right?: ReactNode;
  /** Extra content rendered AFTER the fixed-height body, at its own natural
   *  height -- for a block whose size depends on the data (C9's calendar
   *  summary, stacked under the grid below `lg`) rather than something that
   *  can be pre-sized to fit a fixed pixel box without risking either
   *  overflow (content taller than the box) or wasted space (content
   *  shorter). Not sized, not dimmed on refetch, not part of the loading
   *  skeleton -- purely supplementary. */
  below?: ReactNode;
}) {
  const titleId = useId();
  return (
    <figure className="rounded-lg border-hairline border-border bg-surface-1 p-4" aria-labelledby={titleId}>
      <div className="mb-1 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <figcaption id={titleId} className="text-sm font-semibold text-ink">
            {title}
          </figcaption>
          {subtitle && <p className="text-2xs text-ink-3">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {right}
          <Segmented
            value={view}
            onChange={onViewChange}
            options={[
              { value: "chart", label: "Chart" },
              { value: "table", label: "Table" },
            ]}
          />
        </div>
      </div>
      {legend && <div className="mb-2">{legend}</div>}
      <div
        data-testid="chart-card-body"
        style={{ height, opacity: refetching ? 0.6 : 1 }}
        // min-w-0: defense in depth against the grid/flex "auto-track" trap
        // (an ancestor `lg:grid-cols-N` with no base track constraint let a
        // chart's initial fixed-width SVG stretch the WHOLE page wider than
        // the viewport below `lg` -- see InsightsPage's grid containers,
        // fixed at the source, but this stays as a second line of defense
        // matching Board.tsx's own `min-w-0` on its two-column layout).
        className="relative min-w-0 transition-opacity duration-base ease-quad"
      >
        {loading ? (
          <div className="flex h-full flex-col justify-end gap-2 pb-6" aria-hidden="true">
            <Skeleton w="w-full" className="h-full" />
          </div>
        ) : empty ? (
          <div className="flex h-full items-center justify-center text-xs text-ink-3">Nothing to show yet.</div>
        ) : view === "chart" ? (
          children
        ) : (
          <div className="h-full overflow-auto">{table}</div>
        )}
      </div>
      {footer && <p className="mt-2 text-3xs text-ink-4">{footer}</p>}
      {below}
    </figure>
  );
}

/** Local per-card Chart/Table view state -- every card owns its own, since the
 *  spec's toggle is per-card, not page-wide. */
export function useChartView(initial: ChartView = "chart") {
  return useState<ChartView>(initial);
}
