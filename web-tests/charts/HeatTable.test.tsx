import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { HeatTable } from "../../src/web/components/charts/HeatTable.tsx";
import { inkForFill, SEQ_HEX } from "../../src/web/components/charts/palette.ts";

afterEach(cleanup);

interface Row {
  key: string;
  name: string;
  value: number;
}

const rows: Row[] = [
  { key: "a", name: "Alpha", value: 10 },
  { key: "b", name: "Beta", value: 50 },
  { key: "c", name: "Gamma", value: 30 },
];

function renderTable(defaultSort?: { key: string; dir: "asc" | "desc" }) {
  return render(
    <HeatTable
      columns={[{ key: "name", label: "Name" }, { key: "value", label: "Value" }]}
      rows={rows}
      cell={(r, key) => (key === "name" ? { value: null, display: r.name } : { value: r.value, display: String(r.value) })}
      edges={[0, 10, 20, 30, 40, 50]}
      format={(v) => String(v)}
      defaultSort={defaultSort}
    />
  );
}

describe("HeatTable", () => {
  it("sorts by a column on header click and marks aria-sort", () => {
    renderTable({ key: "name", dir: "asc" });
    const valueHeader = screen.getByRole("columnheader", { name: "Value" });
    expect(valueHeader.getAttribute("aria-sort")).toBe("none");
    fireEvent.click(screen.getByText("Value"));
    expect(valueHeader.getAttribute("aria-sort")).toBe("descending");
    const cells = screen.getAllByRole("row").slice(1).map((r) => r.textContent);
    // Descending by value: Beta(50), Gamma(30), Alpha(10).
    expect(cells[0]).toContain("Beta");
    expect(cells[1]).toContain("Gamma");
    expect(cells[2]).toContain("Alpha");
  });

  it("toggles sort direction on a second click of the same header", () => {
    renderTable({ key: "value", dir: "desc" });
    fireEvent.click(screen.getByText("Value"));
    expect(screen.getByRole("columnheader", { name: "Value" }).getAttribute("aria-sort")).toBe("ascending");
  });

  it("sorts a text column with no numeric value (regression: comparing -Infinity to -Infinity on every row made clicking it a no-op)", () => {
    renderTable({ key: "value", dir: "desc" });
    fireEvent.click(screen.getByText("Name"));
    const rowsText = screen.getAllByRole("row").slice(1).map((r) => r.textContent);
    // Descending alphabetically: Gamma, Beta, Alpha.
    expect(rowsText[0]).toContain("Gamma");
    expect(rowsText[1]).toContain("Beta");
    expect(rowsText[2]).toContain("Alpha");
  });

  it("excludes a column from heat shading when its own `shade` flag is false, even though the table is shaded (regression: Sessions/Active days columns were binned as if they were dollars)", () => {
    const { container } = render(
      <HeatTable
        columns={[{ key: "name", label: "Name" }, { key: "value", label: "Value" }, { key: "count", label: "Count", shade: false }]}
        rows={[{ key: "a", name: "Alpha", value: 50, count: 7 } as unknown as Row & { count: number }]}
        cell={(r, key) => (key === "name" ? { value: null, display: r.name } : { value: (r as any)[key], display: String((r as any)[key]) })}
        edges={[0, 10, 20, 30, 40, 50]}
        format={(v) => String(v)}
        shaded
      />
    );
    const cells = container.querySelectorAll("tbody td");
    const valueCell = cells[1] as HTMLElement;
    const countCell = cells[2] as HTMLElement;
    expect(valueCell.style.background).not.toBe("");
    expect(countCell.style.background).toBe("");
  });
});

describe("inkForFill", () => {
  // The dark-theme ramp runs light-to-dark in the OPPOSITE direction from the
  // light theme's (§5), so a fixed "high bin index = light background" rule
  // picks the wrong ink in one theme -- this pins the real, computed-from-hex
  // answer for both ramps' end steps instead (regression: white text used to
  // render on the dark ramp's lightest step, e.g. #9ec5f4).
  it("picks dark ink for the darkest LIGHT-theme step and the lightest DARK-theme step", () => {
    expect(inkForFill("light", 0)).toBe("#131826"); // light ramp step 0 is itself light
    expect(inkForFill("dark", 4)).toBe("#131826"); // dark ramp step 4 (#9ec5f4) is light too
  });

  it("picks white ink for the darkest step of EACH ramp", () => {
    expect(inkForFill("light", 4)).toBe("#ffffff"); // light ramp's darkest step
    expect(inkForFill("dark", 0)).toBe("#ffffff"); // dark ramp's darkest step
  });

  it("never returns an ink whose contrast is worse than the other option, for every step of both ramps", () => {
    function relLum(hex: string): number {
      const n = parseInt(hex.slice(1), 16);
      const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    function contrast(a: number, b: number): number {
      const [hi, lo] = a > b ? [a, b] : [b, a];
      return (hi + 0.05) / (lo + 0.05);
    }
    const darkInkLum = relLum("#131826");
    for (const mode of ["light", "dark"] as const) {
      SEQ_HEX[mode].forEach((hex, i) => {
        const bgLum = relLum(hex);
        const ink = inkForFill(mode, i);
        const chosenContrast = contrast(bgLum, ink === "#ffffff" ? 1 : darkInkLum);
        const otherContrast = contrast(bgLum, ink === "#ffffff" ? darkInkLum : 1);
        expect(chosenContrast).toBeGreaterThanOrEqual(otherContrast);
      });
    }
  });
});
