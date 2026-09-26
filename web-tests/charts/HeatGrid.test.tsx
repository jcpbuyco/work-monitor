import { describe, it, expect, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { HeatGrid, type HeatCellData } from "../../src/web/components/charts/HeatGrid.tsx";

afterEach(cleanup);

function grid(): HeatCellData[] {
  const cells: HeatCellData[] = [];
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 2; col++) {
      cells.push({ row, col, key: `${row}-${col}`, colorVar: null, tooltip: `${row},${col}`, ariaLabel: `${row},${col}` });
    }
  }
  return cells;
}

describe("HeatGrid", () => {
  it("starts with exactly one tabbable cell (roving tabindex)", () => {
    const { container } = render(<HeatGrid cells={grid()} cols={2} rows={2} cellSize={14} />);
    const tabbable = [...container.querySelectorAll('[tabindex="0"]')];
    expect(tabbable.length).toBe(1);
  });

  it("moves focus (and the roving tabindex) with the arrow keys", () => {
    const { container, getByLabelText } = render(<HeatGrid cells={grid()} cols={2} rows={2} cellSize={14} />);
    const first = container.querySelector('[tabindex="0"]') as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    const nowTabbable = container.querySelector('[tabindex="0"]') as HTMLElement;
    expect(nowTabbable).not.toBe(first);
    expect(document.activeElement).toBe(nowTabbable);
  });

  it("does not move focus past the grid edge", () => {
    const { container } = render(<HeatGrid cells={grid()} cols={2} rows={2} cellSize={14} activeKey="0-0" />);
    const el = container.querySelector('[id="heatcell-0-0"]') as HTMLElement;
    el.focus();
    fireEvent.keyDown(el, { key: "ArrowUp" }); // already at the top row
    fireEvent.keyDown(el, { key: "ArrowLeft" }); // already at the left column
    expect(document.activeElement).toBe(el);
  });
});
