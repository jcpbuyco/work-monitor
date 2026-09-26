import { useId, useState, type ReactNode } from "react";
import { Segmented, Skeleton } from "../primitives.tsx";

export type ChartView = "chart" | "table";

/** ~22rem: a table view's generous height cap (finding: the old fixed body
 *  height clipped even a short 7-row table mid-row; a table with hundreds of
 *  rows -- the lifetime calendar's days, say -- still needs SOME cap so
 *  flipping to Table doesn't turn the card into a page-length scroller). */
const TABLE_VIEW_MIN_CAP = 352;

/** The one card shell every Insights chart mounts inside (§4/§8): title +
 *  metric subtitle, a Chart|Table Segmented toggle, an optional legend row, a
 *  body sized to fit its content (skeleton while first loading, dimmed while
 *  refetching, or a one-line empty message), and an optional footer source
 *  note. */
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
  keepRightInTable = false,
  unboundedTable = false,
}: {
  title: string;
  subtitle?: string;
  legend?: ReactNode;
  /** A pixel BUDGET, not a hard box: the chart view uses it as a `min-height`
   *  floor (never a clip -- rem text or a taller sibling in an `lg:grid` row
   *  can always push the body taller instead of overflowing past the card's
   *  own border, the reported bug) and the table view uses it as the floor
   *  for its own scroll cap (`TABLE_VIEW_MIN_CAP` at minimum). */
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
  /** Most cards' `right` control (a metric Segmented) only changes the CHART
   *  -- the table already shows every metric's exact numbers in its own
   *  columns, so leaving the control visible in Table view suggests it does
   *  something there when it doesn't (finding). A card whose table content
   *  genuinely depends on `right` (Monthly spend by model's Cost/Tokens/
   *  Output toggle picks which column set the table renders) opts back in. */
  keepRightInTable?: boolean;
  /** A card whose "chart" IS a table already (C12, Projects by month --
   *  40 projects is past the categorical color cap, so it's a `HeatTable` in
   *  both views, just with shading toggled off in Table view) opts out of the
   *  generic table view's own scroll cap: that cap exists so an actual
   *  chart's much-taller tabular expansion doesn't turn into a page-length
   *  scroller, but applied here it re-created the exact nested-vertical-
   *  scroll bug the cap was built to avoid on the one card that's a table by
   *  construction (reviewer finding, B3). The table keeps its own horizontal
   *  scroll (a sticky first column) regardless. */
  unboundedTable?: boolean;
  /** Extra content rendered AFTER the body, at its own natural height -- for
   *  a block whose size depends on the data (C9's calendar summary, stacked
   *  under the grid below `lg`) rather than something pre-sizeable to a
   *  budget without either overflowing (content taller than the budget) or
   *  wasting space (content shorter). Not sized, not dimmed on refetch, not
   *  part of the loading skeleton -- purely supplementary. */
  below?: ReactNode;
}) {
  const titleId = useId();
  const isTable = view === "table";
  const tableCap = Math.max(height, TABLE_VIEW_MIN_CAP);
  return (
    <figure className="flex h-full flex-col rounded-lg border-hairline border-border bg-surface-1 p-4" aria-labelledby={titleId}>
      {/* `flex-wrap` decided by an actual WIDTH floor on the title block, not
          a viewport `sm:` breakpoint (regression found while re-verifying:
          `sm:flex-row` forced a single row at any viewport >=640px even
          inside an `lg:grid-cols-2` pair, where the CARD itself can still be
          under 500px -- the title block was squeezed to a ~24px sliver next
          to two wide Segmented controls, wrapping its subtitle one word per
          line). `min-w-[10rem]` on the title, `flex-1` so it claims the rest
          of the row when there's room, and plain `flex-wrap` on the header:
          together, the controls drop to their own full-width row exactly
          when the CARD is too narrow for both, at any viewport width,
          matching the reviewer's B1/A11 fix intent without needing a
          container query.

          `ml-auto` on the controls block, not `justify-between` on this
          outer row -- `justify-between` distributes space PER FLEX LINE, so
          a lone control group wrapped onto its own second line (nothing else
          sharing that line) sat at the line's START, i.e. LEFT-aligned,
          while a card whose controls still fit the FIRST line (next to the
          title) read as right-aligned -- two different alignments for the
          exact same "controls" block depending on incidental wrapping, on
          the same page (reviewer finding, O1). `ml-auto` consumes a wrapped
          line's own leftover space as margin, so the controls sit flush
          right whether they share the title's line or not -- one consistent
          placement, matching the intended "controls top-right" convention at
          every card width. The `right`/Segmented divider is gone in favour
          of a plain `gap-3`: a 1px rule with no content of its own could
          itself end up the lone, orphaned item on a wrapped line (O1). */}
      <div className="mb-1 flex flex-wrap items-start gap-2">
        <div className="min-w-[10rem] flex-1">
          <figcaption id={titleId} className="text-sm font-semibold text-ink">
            {title}
          </figcaption>
          {subtitle && <p className="text-2xs text-ink-3">{subtitle}</p>}
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
          {(!isTable || keepRightInTable) && right}
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
      {legend && !isTable && <div className="mb-2">{legend}</div>}
      <div
        data-testid="chart-card-body"
        style={
          isTable
            ? { maxHeight: unboundedTable ? undefined : tableCap, minHeight: unboundedTable ? height : undefined, opacity: refetching ? 0.6 : 1 }
            : { minHeight: height, opacity: refetching ? 0.6 : 1 }
        }
        // min-w-0: defense in depth against the grid/flex "auto-track" trap
        // (an ancestor `lg:grid-cols-N` with no base track constraint let a
        // chart's initial fixed-width SVG stretch the WHOLE page wider than
        // the viewport below `lg` -- see InsightsPage's grid containers,
        // fixed at the source, but this stays as a second line of defense
        // matching Board.tsx's own `min-w-0` on its two-column layout).
        //
        // `unboundedTable` drops the CAP (no `maxHeight`, so the table isn't
        // trapped in a nested vertical scroller) but still needs its own
        // HORIZONTAL scroll -- `overflow-auto` was replaced with nothing at
        // all for this case, so the table (which has no scroll wrapper of
        // its own in Table view) broke straight out of the card past the
        // viewport's right edge and the whole PAGE scrolled sideways
        // (reviewer finding, R2). `overflow-x-auto` keeps the vertical axis
        // free (the table grows the card, per `unboundedTable`'s own
        // contract) while still containing it sideways.
        className={`relative min-w-0 flex-1 transition-opacity duration-base ease-quad ${isTable ? (unboundedTable ? "overflow-x-auto" : "overflow-auto") : ""}`}
      >
        {loading ? (
          <div className="flex h-full flex-col justify-end gap-2 pb-6" aria-hidden="true">
            <Skeleton w="w-full" className="h-full" />
          </div>
        ) : empty ? (
          <div className="flex h-full items-center justify-center text-xs text-ink-3">Nothing to show yet.</div>
        ) : isTable ? (
          table
        ) : (
          children
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
