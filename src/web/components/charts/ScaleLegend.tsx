import { SEQ_VARS, EMPTY_VAR } from "./palette.ts";

/** "Less [5 swatches] More" scale key, with bin-edge values on hover (§6, C9/
 *  C10/C12 -- the one sequential ramp shared by every heat-shaded surface). */
export function ScaleLegend({ edges, format }: { edges: number[]; format: (v: number) => string }) {
  // 8px swatches in text-ink-3 -- the same convention `Legend` uses, not this
  // component's own 10px/text-ink-4 (reviewer finding, B19: the page's two
  // legend kinds read at two different sizes/shades with nothing to justify
  // the difference).
  return (
    <div className="flex items-center gap-1 text-2xs text-ink-3">
      <span>Less</span>
      <span aria-hidden="true" className="inline-block h-2 w-2 rounded-sm" style={{ background: EMPTY_VAR }} title="No activity" />
      {SEQ_VARS.map((v, i) => (
        <span
          key={v}
          aria-hidden="true"
          className="inline-block h-2 w-2 rounded-sm"
          style={{ background: v }}
          title={edges.length > i + 1 ? `${format(edges[i])} - ${format(edges[i + 1])}` : undefined}
        />
      ))}
      <span>More</span>
    </div>
  );
}
