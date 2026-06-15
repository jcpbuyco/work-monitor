import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AppBar } from "../src/web/components/AppBar.tsx";
import type { State } from "../src/web/types.ts";

const state: State = {
  sessions: [
    { id: "s1", project: "a", status: "working", current_task: null, current_intent: null, attention_reason: null, active_tool: null, branch: null, started_at: 0, last_activity_at: 0 },
    { id: "s2", project: "b", status: "needs_you", current_task: null, current_intent: null, attention_reason: "x", active_tool: null, branch: null, started_at: 0, last_activity_at: 0 },
  ],
  todos: [
    { id: "t1", title: "t", note: "", for_who: null, status: "todo", origin_project: null, branch: null, links: null, position: 0, updated_at: 0 },
  ],
  activity: [],
  stats: [],
};

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("AppBar", () => {
  it("shows live counts derived from state", () => {
    render(<AppBar state={state} />);
    expect(screen.getByText("1 working")).toBeDefined();
    expect(screen.getByText("1 needs you")).toBeDefined();
    expect(screen.getByText("1 to do")).toBeDefined();
  });

  it("toggles the dark class when the theme button is clicked", () => {
    localStorage.setItem("am-theme", "light");
    render(<AppBar state={state} />);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    fireEvent.click(screen.getByLabelText("Toggle theme"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
