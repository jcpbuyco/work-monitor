import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TodoCard } from "../src/web/components/TodoCard.tsx";
import type { Todo } from "../src/web/types.ts";

const patchTodo = vi.fn();
const deleteTodo = vi.fn();
vi.mock("../src/web/api.ts", () => ({
  patchTodo: (...a: any[]) => patchTodo(...a),
  deleteTodo: (...a: any[]) => deleteTodo(...a),
}));

const todo: Todo = {
  id: "t1", title: "Card Title", note: "a clamped note", for_who: "Sam",
  status: "todo", origin_project: "p", branch: "b", links: null, position: 0, updated_at: 0,
};

beforeEach(() => {
  patchTodo.mockClear();
  deleteTodo.mockClear();
});

function renderCard() {
  const onOpen = vi.fn();
  const r = render(<TodoCard t={todo} onOpen={onOpen} />);
  return { onOpen, ...r };
}

describe("TodoCard", () => {
  it("clicking the card opens the todo", () => {
    const { onOpen } = renderCard();
    fireEvent.click(screen.getByText("Card Title"));
    expect(onOpen).toHaveBeenCalledWith(todo);
  });

  it("clicking ✓ marks it done and does not open the todo", () => {
    const { onOpen } = renderCard();
    fireEvent.click(screen.getByLabelText("Mark done"));
    expect(patchTodo).toHaveBeenCalledWith("t1", { status: "done" });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("clicking delete deletes and does not open the todo", () => {
    const { onOpen } = renderCard();
    fireEvent.click(screen.getByLabelText("Delete"));
    expect(deleteTodo).toHaveBeenCalledWith("t1");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("clamps the note to a single line for a compact card", () => {
    renderCard();
    expect(screen.getByText("a clamped note").className).toContain("line-clamp-1");
  });

  it("is not draggable (no drag affordance)", () => {
    const { container } = renderCard();
    expect(container.querySelector(".cursor-grab")).toBeNull();
  });
});
