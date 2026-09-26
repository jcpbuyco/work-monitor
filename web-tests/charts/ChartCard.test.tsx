import { useState } from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { ChartCard, type ChartView } from "../../src/web/components/charts/ChartCard.tsx";

afterEach(cleanup);

function Card({
  view: viewProp,
  onViewChange,
  ...rest
}: Partial<Omit<Parameters<typeof ChartCard>[0], "title" | "table" | "children">> & { view?: ChartView }) {
  const [view, setView] = useState<ChartView>(viewProp ?? "chart");
  return (
    <ChartCard
      title="Test card"
      height={200}
      view={viewProp ?? view}
      onViewChange={onViewChange ?? setView}
      table={<div data-testid="table-content">table</div>}
      {...rest}
    >
      <div data-testid="chart-content">chart</div>
    </ChartCard>
  );
}

describe("ChartCard body sizing (A1/B1/B6: fixed height overflowed rem text)", () => {
  it("uses min-height, not a fixed height, for the chart-view body", () => {
    render(<Card />);
    const body = screen.getByTestId("chart-card-body");
    expect(body.style.minHeight).toBe("200px");
    expect(body.style.height).toBe("");
  });

  it("floors the table-view cap at TABLE_VIEW_MIN_CAP even for a card with a small `height` budget", () => {
    render(<Card height={40} view="table" />);
    const body = screen.getByTestId("chart-card-body");
    // 40px would clip a real table almost immediately -- the cap always
    // floors at the generous constant, never the card's own (possibly tiny)
    // chart-height budget.
    expect(Number(body.style.maxHeight.replace("px", ""))).toBeGreaterThanOrEqual(352);
  });

  it("lets a large `height` budget raise the table-view cap past the floor", () => {
    render(<Card height={500} view="table" />);
    const body = screen.getByTestId("chart-card-body");
    expect(body.style.maxHeight).toBe("500px");
  });

  it("unboundedTable drops the scroll cap entirely and uses `height` as a floor instead (B3: no nested vertical scroll on a table-shaped card)", () => {
    render(<Card view="table" unboundedTable height={280} />);
    const body = screen.getByTestId("chart-card-body");
    expect(body.style.maxHeight).toBe("");
    expect(body.style.minHeight).toBe("280px");
    expect(body.className).not.toContain("overflow-auto");
  });

  it("unboundedTable still scrolls HORIZONTALLY (regression, R2: dropping the scroll cap entirely left a wide table with no scroll wrapper of its own, breaking the whole page out sideways)", () => {
    render(<Card view="table" unboundedTable height={280} />);
    const body = screen.getByTestId("chart-card-body");
    expect(body.className).toContain("overflow-x-auto");
  });

  it("a bounded table (not unboundedTable) still scrolls both axes", () => {
    render(<Card view="table" height={200} />);
    const body = screen.getByTestId("chart-card-body");
    expect(body.className).toContain("overflow-auto");
    expect(body.className).not.toContain("overflow-x-auto");
  });
});

describe("ChartCard right control in table view (finding: a chart-only control implied it did something in Table)", () => {
  it("hides `right` in table view by default", () => {
    render(<Card view="table" right={<button>Metric</button>} />);
    expect(screen.queryByText("Metric")).toBeNull();
  });

  it("shows `right` in chart view regardless of keepRightInTable", () => {
    render(<Card view="chart" right={<button>Metric</button>} />);
    expect(screen.getByText("Metric")).toBeTruthy();
  });

  it("keepRightInTable keeps `right` visible in table view (MonthlyByModel: the toggle picks the table's own columns)", () => {
    render(<Card view="table" keepRightInTable right={<button>Metric</button>} />);
    expect(screen.getByText("Metric")).toBeTruthy();
  });
});

describe("ChartCard view switching", () => {
  it("renders chart children in chart view and the table in table view", () => {
    render(<Card />);
    expect(screen.getByTestId("chart-content")).toBeTruthy();
    expect(screen.queryByTestId("table-content")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(screen.getByTestId("table-content")).toBeTruthy();
    expect(screen.queryByTestId("chart-content")).toBeNull();
  });

  it("hides the legend in table view (finding: a chart-only legend, e.g. isolate buttons, did nothing to the table)", () => {
    render(<Card view="table" legend={<div data-testid="legend">legend</div>} />);
    expect(screen.queryByTestId("legend")).toBeNull();
  });

  it("shows the legend in chart view", () => {
    render(<Card view="chart" legend={<div data-testid="legend">legend</div>} />);
    expect(screen.getByTestId("legend")).toBeTruthy();
  });
});
