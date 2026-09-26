import { useState } from "react";
import type { ReactNode } from "react";
import { useTooltip } from "./useTooltip.ts";
import { Tooltip } from "./Tooltip.tsx";
import { EMPTY_VAR } from "./palette.ts";

export interface HeatCellData {
  row: number;
  col: number;
  key: string;
  /** A `--viz-seq-N` CSS value, or `null` for an empty/no-data cell. */
  colorVar: string | null;
  tooltip: ReactNode;
  ariaLabel?: string;
  ring?: boolean;
  onClick?: () => void;
}

/** Generic cell grid shared by the lifetime calendar (C9) and the weekly
 *  rhythm heatmap (C10): a roving-tabindex grid navigable with the arrow
 *  keys, hover/focus tooltips, and a ring-highlight API C2's records strip
 *  uses to point at a specific cell. */
export function HeatGrid({
  cells,
  cols,
  rows,
  cellSize,
  gap = 2,
  activeKey,
  onActiveKeyChange,
}: {
  cells: HeatCellData[];
  cols: number;
  rows: number;
  cellSize: number;
  gap?: number;
  /** Controlled active cell (so C2 can ring one from outside); falls back to
   *  internal state when omitted. */
  activeKey?: string | null;
  onActiveKeyChange?: (key: string) => void;
}) {
  const tooltip = useTooltip();
  const [internalActive, setInternalActive] = useState<string | null>(cells[0]?.key ?? null);
  const active = activeKey !== undefined ? activeKey : internalActive;
  const setActive = onActiveKeyChange ?? setInternalActive;
  const byPos = new Map(cells.map((c) => [`${c.row},${c.col}`, c]));
  const width = cols * (cellSize + gap);
  const height = rows * (cellSize + gap);
  const byRow = new Map<number, HeatCellData[]>();
  for (const c of cells) {
    const row = byRow.get(c.row) ?? [];
    row.push(c);
    byRow.set(c.row, row);
  }

  function moveFocus(from: HeatCellData, dRow: number, dCol: number) {
    let r = from.row;
    let c = from.col;
    for (let i = 0; i < Math.max(cols, rows) + 1; i++) {
      r += dRow;
      c += dCol;
      if (r < 0 || r >= rows || c < 0 || c >= cols) return;
      const next = byPos.get(`${r},${c}`);
      if (next) {
        setActive(next.key);
        document.getElementById(`heatcell-${next.key}`)?.focus();
        return;
      }
    }
  }

  return (
    <div className="relative">
      <svg width={width} height={height} role="grid" className="overflow-visible">
        {[...byRow.entries()].map(([row, rowCells]) => (
          <g key={row} role="row">
            {rowCells.map((cell) => {
              const x = cell.col * (cellSize + gap);
              const y = cell.row * (cellSize + gap);
              const isActive = active === cell.key;
              return (
                <rect
                  id={`heatcell-${cell.key}`}
                  key={cell.key}
                  data-testid="heat-cell"
                  x={x}
                  y={y}
                  width={cellSize}
                  height={cellSize}
                  rx={2}
                  fill={cell.colorVar ?? EMPTY_VAR}
                  tabIndex={isActive ? 0 : -1}
                  role="gridcell"
                  aria-label={cell.ariaLabel}
                  stroke={cell.ring ? "currentColor" : "none"}
                  strokeWidth={cell.ring ? 2 : 0}
                  className={cell.ring ? "text-ink cursor-pointer" : cell.onClick ? "cursor-pointer" : undefined}
                  onMouseEnter={(e) => tooltip.showFromEvent(e, cell.tooltip)}
                  onMouseMove={(e) => tooltip.showFromEvent(e, cell.tooltip)}
                  onMouseLeave={tooltip.hide}
                  onFocus={(e) => {
                    setActive(cell.key);
                    tooltip.showFromElement(e.currentTarget, cell.tooltip);
                  }}
                  onBlur={tooltip.hide}
                  onClick={cell.onClick}
                  onKeyDown={(e) => {
                    tooltip.onKeyDown(e);
                    if (e.key === "ArrowRight") {
                      e.preventDefault();
                      moveFocus(cell, 0, 1);
                    } else if (e.key === "ArrowLeft") {
                      e.preventDefault();
                      moveFocus(cell, 0, -1);
                    } else if (e.key === "ArrowDown") {
                      e.preventDefault();
                      moveFocus(cell, 1, 0);
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      moveFocus(cell, -1, 0);
                    } else if (e.key === "Enter" || e.key === " ") {
                      cell.onClick?.();
                    }
                  }}
                />
              );
            })}
          </g>
        ))}
      </svg>
      <Tooltip state={tooltip.state} />
    </div>
  );
}
