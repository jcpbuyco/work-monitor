import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TodoModal } from "../src/web/components/TodoModal.tsx";
import type { Todo } from "../src/web/types.ts";

const todo: Todo = {
  id: "t1", title: "Full Title", note: "Line one\nLine two", for_who: "Sam",
  status: "todo", origin_project: "proj", branch: "feat/x", links: ["docs/spec.md"], position: 0, updated_at: 0,
};

describe("TodoModal", () => {
  it("renders the todo's full content", () => {
    render(<TodoModal todo={todo} onClose={() => {}} />);
    expect(screen.getByText("Full Title")).toBeDefined();
    expect(screen.getByText(/Line one/)).toBeDefined();
    expect(screen.getByText("→ Sam")).toBeDefined();
    expect(screen.getByText("⎇ feat/x")).toBeDefined();
    expect(screen.getByText("proj")).toBeDefined();
    expect(screen.getByText("docs/spec.md")).toBeDefined();
  });

  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(<TodoModal todo={todo} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("renders no todo content when todo is null", () => {
    render(<TodoModal todo={null} onClose={() => {}} />);
    expect(screen.queryByText("Full Title")).toBeNull();
  });
});
