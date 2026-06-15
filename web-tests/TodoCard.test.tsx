import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { TodoCard } from "../src/web/components/TodoCard.tsx";
import type { Todo } from "../src/web/types.ts";

const deleteTodo = vi.fn();
vi.mock("../src/web/api.ts", () => ({ deleteTodo: (...a: any[]) => deleteTodo(...a) }));

const todo: Todo = {
  id: "t1", title: "Card Title", note: "a clamped note", for_who: "Sam",
  status: "todo", origin_project: "p", branch: "b", links: null, position: 0,
};

beforeEach(() => deleteTodo.mockClear());

function renderCard() {
  const onOpen = vi.fn();
  render(<DndContext><TodoCard t={todo} onOpen={onOpen} /></DndContext>);
  return onOpen;
}

describe("TodoCard", () => {
  it("clicking the card opens the todo", () => {
    const onOpen = renderCard();
    fireEvent.click(screen.getByText("Card Title"));
    expect(onOpen).toHaveBeenCalledWith(todo);
  });

  it("clicking delete deletes and does not open the todo", () => {
    const onOpen = renderCard();
    fireEvent.click(screen.getByLabelText("Delete"));
    expect(deleteTodo).toHaveBeenCalledWith("t1");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("clamps the note to 4 lines", () => {
    renderCard();
    expect(screen.getByText("a clamped note").className).toContain("line-clamp-4");
  });
});
