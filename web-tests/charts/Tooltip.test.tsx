import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useTooltip } from "../../src/web/components/charts/useTooltip.ts";
import { Tooltip } from "../../src/web/components/charts/Tooltip.tsx";

afterEach(cleanup);

function Harness() {
  const tooltip = useTooltip();
  return (
    <div>
      <button
        tabIndex={0}
        onFocus={(e) => tooltip.showFromElement(e.currentTarget, "hello")}
        onBlur={tooltip.hide}
        onKeyDown={tooltip.onKeyDown}
      >
        target
      </button>
      <Tooltip state={tooltip.state} />
    </div>
  );
}

describe("Tooltip / useTooltip", () => {
  it("opens on keyboard focus, not just hover", () => {
    render(<Harness />);
    expect(screen.queryByTestId("chart-tooltip")).toBeNull();
    fireEvent.focus(screen.getByText("target"));
    expect(screen.getByTestId("chart-tooltip")).toBeTruthy();
    expect(screen.getByTestId("chart-tooltip").textContent).toBe("hello");
  });

  it("closes on Escape", () => {
    render(<Harness />);
    const target = screen.getByText("target");
    fireEvent.focus(target);
    expect(screen.queryByTestId("chart-tooltip")).toBeTruthy();
    fireEvent.keyDown(target, { key: "Escape" });
    expect(screen.queryByTestId("chart-tooltip")).toBeNull();
  });
});
