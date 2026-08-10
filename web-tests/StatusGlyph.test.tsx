import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { StatusGlyph, type GlyphKind } from "../src/web/components/StatusGlyph.tsx";

const svgOf = (kind: GlyphKind, animate?: boolean) =>
  render(<StatusGlyph kind={kind} animate={animate} />).container.querySelector("svg")!;

describe("StatusGlyph", () => {
  it("renders one aria-hidden svg per kind, tagged with the kind", () => {
    for (const k of ["working", "needs_you", "idle", "ended", "todo", "danger"] as GlyphKind[]) {
      const svg = svgOf(k);
      expect(svg).toBeTruthy();
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(svg.getAttribute("data-glyph")).toBe(k);
      // The glyph is never the accessible name; textual status lives elsewhere.
      expect(svg.textContent).toBe("");
    }
  });

  it("scales with the text-size ladder rather than the width/height fallback", () => {
    const svg = svgOf("idle");
    expect(svg.getAttribute("class")).toContain("h-3.5");
    expect(svg.getAttribute("class")).toContain("w-3.5");
    expect(svg.getAttribute("width")).toBe("14"); // no-CSS fallback only
  });

  it("spins only the working glyph, and only when animate is on", () => {
    expect(svgOf("working").getAttribute("class")).toContain("am-spin");
    expect(svgOf("working", false).getAttribute("class")).not.toContain("am-spin");
    expect(svgOf("ended").getAttribute("class")).not.toContain("am-spin");
  });

  it("gives the todo glyph a hidden check for the .am-check hover reveal", () => {
    const svg = svgOf("todo");
    const check = svg.querySelector("[data-glyph-check]")!;
    expect(check).toBeTruthy();
    expect(check.getAttribute("opacity")).toBe("0");
  });

  it("takes its colour from the wrapper class, never from a hard-coded fill", () => {
    const svg = render(<StatusGlyph kind="needs_you" className="text-attention" />).container.querySelector("svg")!;
    expect(svg.getAttribute("class")).toContain("text-attention");
    // Knockouts are the only non-currentColor paint, and they are a surface token.
    for (const el of svg.querySelectorAll("[fill],[stroke]")) {
      const paint = `${el.getAttribute("fill") ?? ""}${el.getAttribute("stroke") ?? ""}`;
      expect(/currentColor|none|hsl\(var\(--surface-0\)\)/.test(paint)).toBe(true);
    }
  });
});
