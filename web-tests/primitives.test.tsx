import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ListRow, Rail, SectionHeader, Chip, MeterRow, Segmented, PageHeader, ROW_TONE } from "../src/web/components/primitives.tsx";

describe("Rail", () => {
  it("is a fixed --rail-wide slot so every row's text starts at the same x", () => {
    const { container } = render(<Rail><b>x</b></Rail>);
    const cls = container.firstElementChild!.className;
    expect(cls).toContain("w-rail");
    expect(cls).toContain("shrink-0");
  });
});

describe("ListRow", () => {
  it("passes data-* through and applies exactly one hover background", () => {
    const { container } = render(<ListRow data-testid="r" tone="default">x</ListRow>);
    const cls = screen.getByTestId("r").className;
    expect(cls).toContain("hover:bg-surface-2");
    expect(cls).not.toContain("bg-attention");
    expect(container.firstElementChild!.tagName).toBe("DIV");
  });

  it("REPLACES the hover background for the attention tone, never appends", () => {
    render(<ListRow data-testid="r" tone="attention">x</ListRow>);
    const cls = screen.getByTestId("r").className;
    expect(cls).toContain("bg-attention/[0.05]");
    expect(cls).toContain("hover:bg-attention/[0.08]");
    // Two same-specificity hover:bg-* classes are resolved by stylesheet order,
    // not className order, so the default tint must be GONE, not overridden.
    expect(cls).not.toContain("hover:bg-surface-2");
    expect(ROW_TONE.attention).not.toContain("hover:bg-surface-2");
  });
});

describe("SectionHeader", () => {
  it("renders a button with aria-expanded when it can toggle", () => {
    const onToggle = vi.fn();
    render(<SectionHeader label="★ Todos (5)" collapsed={false} onToggle={onToggle} />);
    const btn = screen.getByRole("button", { name: /Todos/ });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalled();
  });

  it("keeps the whole label in ONE element so name regexes stay stable", () => {
    render(<SectionHeader label="⚙ Workflows (2)" collapsed onToggle={() => {}} />);
    expect(screen.getByText("⚙ Workflows (2)")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Workflows \(2\)/ })).toBeTruthy();
  });

  it("renders no button and no caret without onToggle", () => {
    const { container } = render(<SectionHeader label="⚡ Live activity" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByText("⚡ Live activity")).toBeTruthy();
  });
});

describe("Chip", () => {
  it("passes title and data-* through — both are test contracts elsewhere", () => {
    render(<Chip data-testid="wf-badge" tone="working" title="owns a live workflow run">wf</Chip>);
    expect(screen.getByTitle("owns a live workflow run")).toBeTruthy();
    expect(screen.getByTestId("wf-badge").textContent).toBe("wf");
  });

  it("emits exactly one font-size class", () => {
    render(<Chip data-testid="c" size="2xs">3</Chip>);
    const cls = screen.getByTestId("c").className;
    expect(cls).toContain("text-2xs");
    expect(cls).not.toContain("text-3xs");
  });
});

describe("MeterRow", () => {
  // MeterRow is an <li>; render it inside a <ul> so React's DOM-nesting
  // validation stays quiet.
  const meter = (frac: number) =>
    render(<ul><MeterRow frac={frac} label="Bash" a={<>492</>} b={<>avg 1.2s</>} /></ul>);

  it("floors the bar at 6% so a tiny row is still visible", () => {
    const { container } = meter(0.001);
    expect((container.querySelector("[data-meter-bar]") as HTMLElement).style.width).toBe("6%");
  });

  it("keeps label, a and b in separate elements", () => {
    meter(1);
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.getByText("492")).toBeTruthy();
    expect(screen.getByText("avg 1.2s")).toBeTruthy();
  });
});

describe("Segmented", () => {
  it("names each item exactly, so /^all$/i matches nothing else", () => {
    const onChange = vi.fn();
    render(
      <Segmented<string>
        value="14d"
        onChange={onChange}
        options={[{ value: "7d", label: "7d" }, { value: "14d", label: "14d" }, { value: "all", label: "All" }]}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^all$/i }));
    expect(onChange).toHaveBeenCalledWith("all");
  });
});

describe("PageHeader", () => {
  it("introduces no button whose accessible name contains 'cost'", () => {
    render(<PageHeader title="Cost by day" />);
    expect(screen.getByText("Cost by day")).toBeTruthy();
    expect(screen.getByText("← Dashboard").tagName).toBe("A"); // a link, never a button
    expect(screen.queryByRole("button", { name: /cost/i })).toBeNull();
  });
});
