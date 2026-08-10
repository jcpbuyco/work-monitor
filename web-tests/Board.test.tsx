import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Board } from "../src/web/components/Board.tsx";
import type { State } from "../src/web/types.ts";

vi.mock("../src/web/api.ts", () => ({ patchTodo: vi.fn(), deleteTodo: vi.fn() }));

const state: State = {
  sessions: [
    { id: "s1", project: "browns", status: "working", current_task: "Refactor (1/3 done)", current_intent: null, attention_reason: null, active_tool: null, branch: null, started_at: Date.now(), last_activity_at: Date.now() },
    { id: "s2", project: "love-island", status: "needs_you", current_task: null, current_intent: "tests", attention_reason: "Run migration?", active_tool: null, branch: null, started_at: Date.now(), last_activity_at: Date.now() },
  ],
  todos: [
    { id: "t1", title: "Hand off spec", note: "branch feat/pay", for_who: "Maria", status: "todo", origin_project: "bov", branch: "feat/pay", links: null, position: 0, updated_at: Date.now() },
  ],
  activity: [],
  stats: [],
  cost: { perSession: {}, liveTotalUsd: 0, todayUsd: 0, byModelToday: [], byProject: [], byBranch: [] },
};

describe("Board", () => {
  it("renders sessions in the right status columns and a todo card", () => {
    render(<Board state={state} />);
    expect(screen.getByText("browns")).toBeDefined();
    expect(screen.getByText("Refactor (1/3 done)")).toBeDefined();
    expect(screen.getByText("⚠ Run migration?")).toBeDefined();
    expect(screen.getByText("Hand off spec")).toBeDefined();
    expect(screen.getByText("→ Maria")).toBeDefined();
    expect(screen.getByText(/Done \(0\)/)).toBeDefined();
  });

  it("renders the live activity feed with recent tool calls", () => {
    const withActivity: State = { ...state, activity: [{ id: 1, session_id: "s1", tool: "Bash", detail: "git status", dur: null, at: Date.now() }] };
    render(<Board state={withActivity} />);
    expect(screen.getByText("⚡ Live activity")).toBeDefined();
    // the Bash call shows in the feed and as the working session's current tool
    expect(screen.getAllByText("Bash").length).toBeGreaterThan(0);
  });
});

import type { LiveWorkflow } from "../src/web/types.ts";

const liveRun: LiveWorkflow = {
  run_id: "wf_abc", session_id: "s1", project: "browns", branch: "main", name: "research",
  status: null, state: "running", started_at: Date.now() - 1000, phase: null, schema_ok: true,
  costUsd: 1, tokens: 10, agents: [],
};

describe("Board workflows strip", () => {
  it("renders no workflows section when there are zero live runs", () => {
    render(<Board state={state} />);
    // The AppBar always carries a "Workflows" LINK, so scope this to the section
    // toggle BUTTON to avoid a false positive.
    expect(screen.queryByRole("button", { name: /Workflows \(/ })).toBeNull();
  });

  it("renders the strip and flags the owning session when a run is live", () => {
    render(<Board state={state} workflows={[liveRun]} />);
    expect(screen.getByRole("button", { name: /Workflows \(1\)/ })).toBeTruthy();
    expect(screen.getByTitle("owns a live workflow run")).toBeTruthy(); // the wf badge on s1
  });

  it("warns when workflow data looks degraded", () => {
    render(<Board state={{ ...state, workflows_degraded: 3 }} />);
    expect(screen.getByText(/workflow data looks off/i)).toBeTruthy();
  });

  it("does not warn when the server predates workflows_degraded (field absent)", () => {
    render(<Board state={state} />);
    expect(screen.queryByText(/workflow data looks off/i)).toBeNull();
  });
});
