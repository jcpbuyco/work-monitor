import { SEQ_VARS, EMPTY_VAR } from "./palette.ts";

/** "Less [5 swatches] More" scale key, with bin-edge values on hover (§6, C9/
 *  C10/C12 -- the one sequential ramp shared by every heat-shaded surface). */
export function ScaleLegend({ edges, format }: { edges: number[]; format: (v: number) => string }) {
  return (
    <div className="flex items-center gap-1 text-2xs text-ink-4">
      <span>Less</span>
      <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: EMPTY_VAR }} title="No activity" />
      {SEQ_VARS.map((v, i) => (
        <span
          key={v}
          aria-hidden="true"
          className="inline-block h-2.5 w-2.5 rounded-sm"
          style={{ background: v }}
          title={edges.length > i + 1 ? `${format(edges[i])} - ${format(edges[i + 1])}` : undefined}
        />
      ))}
      <span>More</span>
    </div>
  );
}
