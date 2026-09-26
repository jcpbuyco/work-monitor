import { useState } from "react";
import { SEQ_VARS, inkForFill } from "./palette.ts";
import { binOf } from "./scales.ts";

export interface HeatTableColumn {
  key: string;
  label: string;
  /** false excludes this column from heat shading even when the table as a
   *  whole is shaded -- for a non-dollar count column (sessions, active days)
   *  living alongside dollar month columns that DO get the ramp. Defaults to
   *  true. */
  shade?: boolean;
}

export interface HeatTableCellValue {
  value: number | null;
  display: string;
}

/** Heat-shaded HTML table (§6, C12 -- 40 projects is past the categorical
 *  cap, so this is a table, not a stack). Sortable headers, a sticky first
 *  column, and an inline lifetime bar in the Lifetime column. Shading is
 *  opt-out via `shaded=false` (the card's own Table toggle switches it off
 *  for print/screen-reader use, per the spec). */
export function HeatTable<T extends { key: string }>({
  columns,
  rows,
  cell,
  lifetimeBar,
  edges,
  format,
  shaded = true,
  dark = false,
  defaultSort,
  pinned,
  onCellHover,
  onCellLeave,
}: {
  columns: HeatTableColumn[];
  rows: T[];
  cell: (row: T, colKey: string) => HeatTableCellValue;
  lifetimeBar?: (row: T) => number; // 0..1 fraction of the top project
  edges: number[];
  format: (v: number) => string;
  shaded?: boolean;
  dark?: boolean;
  defaultSort?: { key: string; dir: "asc" | "desc" };
  /** Rows that stay below every sorted row, in their given order, whatever
   *  the sort (folded "Other" / "(no project)" buckets are not peers). */
  pinned?: (row: T) => boolean;
  /** Caller-owned tooltip hook: HeatTable has no `Tooltip` of its own (unlike
   *  HeatGrid/StackedColumns), since a table cell's tooltip content (§6, C12:
   *  "project, month, $, sessions, share of that month's spend") needs data
   *  this component doesn't have. */
  onCellHover?: (e: React.MouseEvent, row: T, colKey: string) => void;
  onCellLeave?: () => void;
}) {
  const [sort, setSort] = useState(defaultSort ?? { key: columns[0]?.key ?? "", dir: "desc" as "asc" | "desc" });
  const isPinned = pinned ?? (() => false);
  const sorted = [...rows.filter((r) => !isPinned(r))].sort((a, b) => {
    const av = cell(a, sort.key);
    const bv = cell(b, sort.key);
    // A text column (the Project name) has no numeric `value` at all -- the
    // old `(value ?? -Infinity) - (value ?? -Infinity)` compared -Infinity to
    // -Infinity for every row, a no-op sort that silently did nothing when a
    // user clicked that header (reviewer finding). Fall back to comparing the
    // rendered text for any column with no numbers to compare.
    const c = av.value == null && bv.value == null ? av.display.localeCompare(bv.display) : (av.value ?? -Infinity) - (bv.value ?? -Infinity);
    return sort.dir === "asc" ? c : -c;
  });
  sorted.push(...rows.filter(isPinned));

  return (
    <table className="w-full border-collapse font-mono text-2xs">
      <thead>
        <tr>
          {columns.map((c, i) => (
            <th
              key={c.key}
              aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
              className={`h-8 border-b border-border px-2 text-left font-normal text-3xs uppercase tracking-caps text-ink-4 ${
                i === 0 ? "sticky left-0 z-10 bg-surface-1" : "text-right"
              }`}
            >
              <button
                type="button"
                onClick={() => setSort((s) => (s.key === c.key ? { key: c.key, dir: s.dir === "asc" ? "desc" : "asc" } : { key: c.key, dir: "desc" }))}
                className="inline-flex items-center gap-1 hover:text-ink"
              >
                {c.label}
                {sort.key === c.key && <span aria-hidden="true">{sort.dir === "asc" ? "▲" : "▼"}</span>}
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((row) => (
          <tr key={row.key} className="border-b border-border-weak">
            {columns.map((c, i) => {
              const v = cell(row, c.key);
              const colShade = shaded && c.shade !== false;
              if (i === 0) {
                return (
                  <td key={c.key} className="sticky left-0 z-10 bg-surface-1 px-2 py-1 font-medium text-ink">
                    {v.display}
                  </td>
                );
              }
              if (c.key === "lifetime" && lifetimeBar) {
                const frac = lifetimeBar(row);
                return (
                  <td key={c.key} className="px-2 py-1 text-right text-ink-2">
                    <span className="inline-flex items-center justify-end gap-1.5">
                      <span aria-hidden="true" className="h-1.5 w-10 overflow-hidden rounded-sm bg-surface-3">
                        <span className="block h-full rounded-sm" style={{ width: `${Math.max(2, frac * 100)}%`, background: "var(--viz-s1)" }} />
                      </span>
                      <span className="tabular-nums slashed-zero">{v.display}</span>
                    </span>
                  </td>
                );
              }
              if (v.value == null) {
                return (
                  <td key={c.key} className="px-2 py-1 text-right tabular-nums slashed-zero text-ink-4">
                    -
                  </td>
                );
              }
              const bin = colShade ? binOf(v.value, edges) : -1;
              const bg = colShade ? SEQ_VARS[bin] : undefined;
              const ink = colShade ? inkForFill(dark ? "dark" : "light", bin) : undefined;
              return (
                <td
                  key={c.key}
                  onMouseEnter={(e) => onCellHover?.(e, row, c.key)}
                  onMouseMove={(e) => onCellHover?.(e, row, c.key)}
                  onMouseLeave={onCellLeave}
                  className="px-2 py-1 text-right tabular-nums slashed-zero"
                  style={bg ? { background: bg, color: ink } : undefined}
                >
                  {v.display}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
