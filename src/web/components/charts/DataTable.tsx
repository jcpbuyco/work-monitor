import type { ReactNode } from "react";

export interface DataTableColumn<T> {
  key: string;
  label: string;
  numeric?: boolean;
  render: (row: T) => ReactNode;
}

/** The table-view twin every chart card offers (§4: "Every card has a Chart |
 *  Table toggle"). Plain HTML table, tabular numbers, no shading -- shading
 *  belongs to HeatTable, the one card (C12) that IS a table by default. */
export function DataTable<T>({ columns, rows, caption, rowKey }: { columns: DataTableColumn<T>[]; rows: T[]; caption: string; rowKey: (row: T, i: number) => string }) {
  return (
    <table className="w-full border-collapse font-mono text-2xs">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          {columns.map((c) => (
            <th
              key={c.key}
              className={`sticky top-0 border-b border-border bg-surface-1 px-2 py-1 text-left font-normal text-3xs uppercase tracking-caps text-ink-4 ${c.numeric ? "text-right" : ""}`}
            >
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={rowKey(row, i)} className="border-b border-border-weak">
            {columns.map((c) => (
              <td key={c.key} className={`px-2 py-1 tabular-nums slashed-zero text-ink-2 ${c.numeric ? "text-right" : ""}`}>
                {c.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
