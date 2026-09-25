import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AppBar } from "../src/web/components/AppBar.tsx";
import type { State } from "../src/web/types.ts";

const state: State = {
  sessions: [
    { id: "s1", project: "a", status: "working", current_task: null, current_intent: null, attention_reason: null, active_tool: null, branch: null, idle_reason: null, started_at: 0, last_activity_at: 0 },
    { id: "s2", project: "b", status: "needs_you", current_task: null, current_intent: null, attention_reason: "x", active_tool: null, branch: null, idle_reason: null, started_at: 0, last_activity_at: 0 },
  ],
  todos: [
    { id: "t1", title: "t", note: "", for_who: null, status: "todo", origin_project: null, branch: null, links: null, position: 0, updated_at: 0 },
  ],
  activity: [],
  stats: [],
  cost: { perSession: {}, liveTotalUsd: 0, todayUsd: 0, byModelToday: [], byProject: [], byBranch: [] },
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

import type { LiveWorkflow } from "../src/web/types.ts";

const liveRun: LiveWorkflow = {
  run_id: "wf_abc", session_id: "s1", project: "p", branch: null, name: "research",
  status: null, state: "running", started_at: 0, phase: null, schema_ok: true,
  costUsd: 0, tokens: 0, agents: [],
};

describe("AppBar chrome", () => {
  it("leads each count with its status glyph and keeps '{n} {label}' in one element", () => {
    render(<AppBar state={state} />);
    expect(screen.getByTestId("appbar-count-working").querySelector('[data-glyph="working"]')).toBeTruthy();
    expect(screen.getByTestId("appbar-count-needs-you").querySelector('[data-glyph="needs_you"]')).toBeTruthy();
    expect(screen.getByTestId("appbar-count-todo").querySelector('[data-glyph="todo"]')).toBeTruthy();
    expect(screen.getByText("1 working").tagName).toBe("SPAN");
  });

  it("never spins a glyph in the chrome", () => {
    render(<AppBar state={state} />);
    expect(screen.getByTestId("appbar-count-working").innerHTML).not.toContain("am-spin");
  });

  it("escalates the needs-you group only while it is non-zero, and recedes zeroes", () => {
    render(<AppBar state={state} />);
    expect(screen.getByTestId("appbar-count-needs-you").className).toContain("text-attention");
    cleanup();
    const calm = { ...state, sessions: [state.sessions[0]], todos: [] };
    render(<AppBar state={calm} />);
    expect(screen.getByTestId("appbar-count-needs-you").className).toContain("text-ink-4");
    expect(screen.getByTestId("appbar-count-needs-you").className).not.toContain("text-attention");
  });

  it("shows the live workflow count chip only when a run is live", () => {
    render(<AppBar state={state} />);
    expect(screen.queryByTestId("appbar-wf-count")).toBeNull();
    cleanup();
    render(<AppBar state={state} workflows={[liveRun]} />);
    expect(screen.getByTestId("appbar-wf-count").textContent).toBe("1");
  });
});
