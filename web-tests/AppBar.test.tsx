import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
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

describe("AppBar §5.2: ready state", () => {
  it("shows … instead of a confident zero before the first state arrives", () => {
    render(<AppBar state={state} ready={false} />);
    expect(screen.getByTestId("appbar-count-working").textContent).toContain("… working");
    expect(screen.getByTestId("appbar-count-needs-you").textContent).toContain("… needs you");
    expect(screen.getByTestId("appbar-count-todo").textContent).toContain("… to do");
    expect(screen.queryByText("0 working")).toBeNull();
  });

  it("never escalates a pending needs-you count, even with a nonzero real value underneath", () => {
    render(<AppBar state={state} ready={false} />);
    expect(screen.getByTestId("appbar-count-needs-you").className).not.toContain("text-attention");
  });

  it("shows real counts once ready (the default)", () => {
    render(<AppBar state={state} />);
    expect(screen.getByText("1 working")).toBeTruthy();
  });
});

describe("AppBar §5.2: active route highlight", () => {
  it("marks the board link current at '#/'", () => {
    render(<AppBar state={state} route="#/" />);
    expect(screen.getByText("agent-monitor").closest("a")!.getAttribute("aria-current")).toBe("page");
  });

  it("marks the Cost link current at '#/cost', and nothing else", () => {
    render(<AppBar state={state} route="#/cost" />);
    expect(screen.getByText("Cost").closest("a")!.getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("Workflows").closest("a")!.getAttribute("aria-current")).toBeNull();
  });

  it("marks the Workflows link current at '#/workflows'", () => {
    render(<AppBar state={state} route="#/workflows" />);
    expect(screen.getByText("Workflows").closest("a")!.getAttribute("aria-current")).toBe("page");
  });

  it("marks the Insights link current at '#/insights', and nothing else", () => {
    render(<AppBar state={state} route="#/insights" />);
    expect(screen.getByText("Insights").closest("a")!.getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("Cost").closest("a")!.getAttribute("aria-current")).toBeNull();
  });
});

describe("AppBar: Insights nav link", () => {
  it("appears between Cost and Workflows in the desktop cluster", () => {
    render(<AppBar state={state} route="#/" />);
    const links = screen.getAllByRole("link").map((a) => a.textContent ?? "");
    const cost = links.findIndex((t) => t.includes("Cost"));
    const insights = links.findIndex((t) => t.includes("Insights"));
    const workflows = links.findIndex((t) => t.includes("Workflows"));
    expect(cost).toBeGreaterThanOrEqual(0);
    expect(insights).toBeGreaterThan(cost);
    expect(workflows).toBeGreaterThan(insights);
  });

  it("also appears in the phone overflow panel", () => {
    render(<AppBar state={state} />);
    fireEvent.click(screen.getByLabelText("More controls"));
    const panel = screen.getByTestId("appbar-overflow-panel");
    expect(within(panel).getByText("Insights")).toBeTruthy();
  });
});

describe("AppBar §5.2: phone overflow menu", () => {
  it("keeps the overflow panel closed (and its controls out of the DOM) by default", () => {
    render(<AppBar state={state} />);
    expect(screen.queryByTestId("appbar-overflow-panel")).toBeNull();
    // exactly one "Toggle theme" control exists - no accidental duplicate
    expect(screen.getAllByLabelText("Toggle theme").length).toBe(1);
  });

  it("opens a panel with the same controls, reachable independently of the desktop cluster", () => {
    render(<AppBar state={state} />);
    fireEvent.click(screen.getByLabelText("More controls"));
    const panel = screen.getByTestId("appbar-overflow-panel");
    expect(within(panel).getByLabelText("Toggle theme")).toBeTruthy();
    expect(within(panel).getByText("Cost")).toBeTruthy();
    // now two exist in total (desktop cluster + open panel) - real browsers
    // hide the desktop one via CSS at this width; both are legitimately in the DOM.
    expect(screen.getAllByLabelText("Toggle theme").length).toBe(2);
  });

  it("toggles closed again on a second click", () => {
    render(<AppBar state={state} />);
    const btn = screen.getByLabelText("More controls");
    fireEvent.click(btn);
    expect(screen.getByTestId("appbar-overflow-panel")).toBeTruthy();
    fireEvent.click(btn);
    expect(screen.queryByTestId("appbar-overflow-panel")).toBeNull();
  });
});
