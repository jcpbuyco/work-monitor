import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { StackedColumns } from "../../src/web/components/charts/StackedColumns.tsx";

afterEach(cleanup);

const series = [
  { id: "a", label: "A", color: "red" },
  { id: "b", label: "B", color: "blue" },
];

describe("StackedColumns", () => {
  it("draws every visible segment with a 2px gap between them and rounds only the topmost", () => {
    const { container } = render(
      <StackedColumns
        months={["2026-06"]}
        series={series}
        values={{ "2026-06": { a: 100, b: 50 } }}
        width={200}
        plotHeight={100}
        formatValue={(v) => String(v)}
      />
    );
    const paths = container.querySelectorAll("path");
    // The bottom segment (a, not topmost) is a plain rect path (no arc "q" commands).
    const bottom = [...paths].find((p) => p.getAttribute("fill") === "red");
    expect(bottom?.getAttribute("d")).not.toContain("q");
    // The top segment (b) is rounded -- its path contains an arc command.
    const top = [...paths].find((p) => p.getAttribute("fill") === "blue");
    expect(top?.getAttribute("d")).toContain("q");
  });

  it("leaves exactly a 2px surface gap between the bottom and top segments", () => {
    const { container } = render(
      <StackedColumns months={["2026-06"]} series={series} values={{ "2026-06": { a: 100, b: 50 } }} width={200} plotHeight={100} formatValue={(v) => String(v)} />
    );
    const paths = container.querySelectorAll("path");
    const bottom = [...paths].find((p) => p.getAttribute("fill") === "red")!;
    const top = [...paths].find((p) => p.getAttribute("fill") === "blue")!;
    // Bottom segment: "M{x},{y} h{w} v{h} h{-w} Z" -- y is its TOP edge, y+h its bottom (the baseline).
    const bm = /M([\d.]+),([\d.]+) h[\d.-]+ v([\d.]+)/.exec(bottom.getAttribute("d")!)!;
    const bottomTopY = Number(bm[2]);
    // Top segment's rounded path starts "M{x},{y+h}" (its own bottom-left corner).
    const tm = /M([\d.]+),([\d.]+)/.exec(top.getAttribute("d")!)!;
    const topBottomY = Number(tm[2]);
    // "top" (b) sits visually above "bottom" (a): its bottom edge is 2px
    // ABOVE (smaller y than) a's top edge, since SVG y grows downward.
    expect(bottomTopY - topBottomY).toBeCloseTo(2, 5);
  });

  it("draws nothing (no crash) for a month with every series at 0", () => {
    const { container } = render(
      <StackedColumns months={["2026-03"]} series={series} values={{ "2026-03": { a: 0, b: 0 } }} width={200} plotHeight={100} formatValue={(v) => String(v)} />
    );
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("draws a full-height bar when a segment's value equals the axis max (regression: v === niceMax read as \"zero-height\" and hid the whole bar)", () => {
    // A single series at 100, alone, makes the axis's own nice max exactly
    // 100 -- `scaleY(100)` sits at the plot's top (y=0), which the buggy
    // `plotHeight - scaleY(v) === plotHeight` check mistook for "this
    // segment is zero" (e.g. every single-kind month in C6's Share view,
    // which is always exactly 100%).
    const single = [{ id: "a", label: "A", color: "red" }];
    const { container } = render(
      <StackedColumns months={["2026-06"]} series={single} values={{ "2026-06": { a: 100 } }} width={200} plotHeight={100} formatValue={(v) => String(v)} />
    );
    const path = container.querySelector("path")!;
    const d = path.getAttribute("d")!;
    const vMatch = /v(-?[\d.]+)/.exec(d)!;
    // A collapsed (bugged) segment's rounded-rect degenerates to "v0"; a real
    // ~100px-tall bar's first vertical command is close to -96 (100 minus
    // the 4px corner radius).
    expect(Math.abs(Number(vMatch[1]))).toBeGreaterThan(50);
  });

  it("dims non-isolated segments to 15% opacity without changing their fill color", () => {
    const { container } = render(
      <StackedColumns
        months={["2026-06"]}
        series={series}
        values={{ "2026-06": { a: 100, b: 50 } }}
        width={200}
        plotHeight={100}
        formatValue={(v) => String(v)}
        isolated="b"
      />
    );
    const dimmed = [...container.querySelectorAll("g")].find((g) => g.querySelector(':scope > path[fill="red"]'));
    expect(dimmed?.getAttribute("style")).toContain("0.15");
    const dimmedPath = dimmed?.querySelector("path");
    expect(dimmedPath?.getAttribute("fill")).toBe("red"); // color itself never repainted
  });

  // B20 (reviewer finding): adjacent narrow columns' second lines used to run
  // into each other with no fitting logic at all ("46 runs163 runs").
  describe("secondLine fitting (B20)", () => {
    it("drops trailing words until the label fits the column's own bandwidth", () => {
      const { container } = render(
        <StackedColumns
          months={["2026-01", "2026-02"]}
          series={series}
          values={{ "2026-01": { a: 5, b: 2 }, "2026-02": { a: 5, b: 2 } }}
          width={140} // forces a narrow bandwidth per column (~39px, fits "163" but not "163 runs")
          plotHeight={100}
          formatValue={(v) => String(v)}
          secondLine={() => "163 runs"}
        />
      );
      const texts = [...container.querySelectorAll("text")].map((t) => t.textContent);
      // Never the untruncated "163 runs" at this width, and never empty --
      // the numeric prefix alone still fits and still carries information.
      expect(texts).not.toContain("163 runs");
      expect(texts.some((t) => t === "163")).toBe(true);
    });

    it("keeps the full label when the column is wide enough for it", () => {
      const { container } = render(
        <StackedColumns
          months={["2026-01"]}
          series={series}
          values={{ "2026-01": { a: 5, b: 2 } }}
          width={800}
          plotHeight={100}
          formatValue={(v) => String(v)}
          secondLine={() => "163 runs"}
        />
      );
      const texts = [...container.querySelectorAll("text")].map((t) => t.textContent);
      expect(texts).toContain("163 runs");
    });

    it("drops the label entirely rather than crashing when even the shortest word can't fit", () => {
      const { container } = render(
        <StackedColumns
          months={["2026-01"]}
          series={series}
          values={{ "2026-01": { a: 5, b: 2 } }}
          width={1} // pathological: no bandwidth at all
          plotHeight={100}
          formatValue={(v) => String(v)}
          secondLine={() => "163 runs"}
        />
      );
      expect(container.querySelector("svg")).toBeTruthy();
    });
  });
});
