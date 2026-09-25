import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { HarnessMark } from "../src/web/components/HarnessMark.tsx";

describe("HarnessMark", () => {
  it("renders a distinct aria-hidden svg per harness, tagged with the harness", () => {
    for (const h of ["claude", "codex", "cursor"] as const) {
      const { container } = render(<HarnessMark harness={h} />);
      const svg = container.querySelector("svg")!;
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(svg.getAttribute("data-harness")).toBe(h);
    }
  });

  it("gives every harness a visibly different path", () => {
    const paths = ["claude", "codex", "cursor"].map((h) => {
      const { container } = render(<HarnessMark harness={h as never} />);
      return container.querySelector("path")!.getAttribute("d");
    });
    expect(new Set(paths).size).toBe(3);
  });

  it("carries the harness label for screen readers, never as the visible glyph text", () => {
    render(<HarnessMark harness="codex" />);
    const svg = document.querySelector("svg")!;
    expect(svg.textContent).toBe("");
    expect(screen.getByText("Codex").className).toContain("sr-only");
  });

  it("shows the harness label as a hover title, with its version appended when known", () => {
    const { rerender } = render(<HarnessMark harness="cursor" />);
    expect(screen.getByTitle("Cursor")).toBeTruthy();
    rerender(<HarnessMark harness="cursor" version="2026.08.11" />);
    expect(screen.getByTitle("Cursor 2026.08.11")).toBeTruthy();
  });
});
