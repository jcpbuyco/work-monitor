import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DoneDialog } from "../src/web/components/DoneDialog.tsx";
import type { Todo } from "../src/web/types.ts";

const mk = (id: string, updated_at: number): Todo => ({
  id, title: id, note: "", for_who: null, status: "done",
  origin_project: null, branch: null, links: null, position: 0, updated_at,
});

describe("DoneDialog", () => {
  it("renders done todos latest-first", () => {
    const done = [mk("old", 1000), mk("new", 3000), mk("mid", 2000)];
    render(<DoneDialog open done={done} onClose={() => {}} />);
    const titles = screen.getAllByText(/^(old|new|mid)$/).map((e) => e.textContent);
    expect(titles).toEqual(["new", "mid", "old"]);
  });

  it("paginates with Prev/Next bounds", () => {
    // 12 items; updated_at 1000..1011 so t11 is newest. Sorted desc: t11..t0.
    const done = Array.from({ length: 12 }, (_, i) => mk(`t${i}`, 1000 + i));
    render(<DoneDialog open done={done} onClose={() => {}} />);
    expect(screen.getByText("1–10 of 12")).toBeDefined();
    expect(screen.queryByText("t1")).toBeNull(); // t1, t0 are on page 2
    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByText("11–12 of 12")).toBeDefined();
    expect(screen.getByText("t1")).toBeDefined();
    expect(screen.getByText("t0")).toBeDefined();
  });

  it("shows an empty state when there are no done todos", () => {
    render(<DoneDialog open done={[]} onClose={() => {}} />);
    expect(screen.getByText("No completed todos yet.")).toBeDefined();
  });

  it("calls onClose when ✕ is clicked", () => {
    const onClose = vi.fn();
    render(<DoneDialog open done={[mk("a", 1)]} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalled();
  });
});
