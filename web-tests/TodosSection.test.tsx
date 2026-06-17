import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TodosSection } from "../src/web/components/TodosSection.tsx";
import type { Todo } from "../src/web/types.ts";

vi.mock("../src/web/api.ts", () => ({ patchTodo: vi.fn(), deleteTodo: vi.fn() }));

const mk = (id: string, status: Todo["status"]): Todo => ({
  id, title: id, note: "", for_who: null, status,
  origin_project: null, branch: null, links: null, position: 0, updated_at: 0,
});

const todos = [mk("open1", "todo"), mk("open2", "todo"), mk("gone", "done")];

beforeEach(() => localStorage.clear());

describe("TodosSection", () => {
  it("shows the open todos and a Done count, but renders no done cards", () => {
    render(<TodosSection todos={todos} />);
    expect(screen.getByText("open1")).toBeDefined();
    expect(screen.getByText("open2")).toBeDefined();
    expect(screen.queryByText("gone")).toBeNull();
    expect(screen.getByText(/Done \(1\)/)).toBeDefined();
  });

  it("caps the open list height with an inner scroll so the board stays visible", () => {
    render(<TodosSection todos={todos} />);
    const scroller = screen.getByText("open1").closest('[class*="overflow-y-auto"]');
    expect(scroller).not.toBeNull();
    expect(scroller!.className).toContain("max-h-[40vh]");
  });

  it("collapsing hides the open list", () => {
    render(<TodosSection todos={todos} />);
    fireEvent.click(screen.getByRole("button", { name: /Todos/ }));
    expect(screen.queryByText("open1")).toBeNull();
  });

  it("opening the Done link reveals the completed todo in the dialog", () => {
    render(<TodosSection todos={todos} />);
    expect(screen.queryByText("gone")).toBeNull();
    fireEvent.click(screen.getByText(/Done \(1\)/));
    expect(screen.getByText("gone")).toBeDefined();
  });
});
