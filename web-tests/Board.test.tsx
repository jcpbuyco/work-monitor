import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { Board } from "../src/web/components/Board.tsx";
import type { State } from "../src/web/types.ts";

beforeEach(() => localStorage.clear());

vi.mock("../src/web/api.ts", () => ({ patchTodo: vi.fn(), deleteTodo: vi.fn() }));

const state: State = {
  sessions: [
    { id: "s1", project: "browns", status: "working", current_task: "Refactor (1/3 done)", current_intent: null, attention_reason: null, active_tool: null, branch: null, idle_reason: null, started_at: Date.now(), last_activity_at: Date.now() },
    { id: "s2", project: "love-island", status: "needs_you", current_task: null, current_intent: "tests", attention_reason: "Run migration?", active_tool: null, branch: null, idle_reason: null, started_at: Date.now(), last_activity_at: Date.now() },
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
    render(
      <Board
        state={{ ...state, workflows_degraded: 3, workflows_degraded_run: { run_id: "wf_x", name: "research" } }}
      />
    );
    expect(screen.getByText(/workflow data looks off/i)).toBeTruthy();
  });

  it("does not warn when the server predates workflows_degraded (field absent)", () => {
    render(<Board state={state} />);
    expect(screen.queryByText(/workflow data looks off/i)).toBeNull();
  });

  it("does not warn from the process-lifetime counter alone, with no run to name (finding fix)", () => {
    // `workflows_degraded` sums a process-lifetime counter (never
    // 24h-windowed, never tied to a run) with the persisted per-run count.
    // Gating the banner on it directly used to show an unnamed, undismissable
    // banner whenever ONLY that counter was nonzero.
    render(<Board state={{ ...state, workflows_degraded: 3, workflows_degraded_run: null }} />);
    expect(screen.queryByText(/workflow data looks off/i)).toBeNull();
  });
});

describe("Board layout", () => {
  it("orders the session groups needs-you, working, idle", () => {
    const { container } = render(<Board state={state} />);
    const ids = [...container.querySelectorAll('[data-testid^="session-group-"]')].map((e) =>
      e.getAttribute("data-testid")
    );
    expect(ids).toEqual(["session-group-needs_you", "session-group-working", "session-group-idle"]);
  });

  it("still renders an empty group's header with a zero count — it is the board's legend", () => {
    render(<Board state={state} />);
    const idle = screen.getByTestId("session-group-idle");
    expect(within(idle).getByText("Idle / done")).toBeTruthy();
    expect(within(idle).getByText("0")).toBeTruthy();
  });

  it("puts the degraded banner first in main, above the sessions lane", () => {
    const { container } = render(
      <Board
        state={{ ...state, workflows_degraded: 3, workflows_degraded_run: { run_id: "wf_x", name: "research" } }}
      />
    );
    const main = container.querySelector("main")!;
    expect(main.firstElementChild!.textContent).toContain("workflow data looks off");
  });
});

describe("Board §5.2: degraded banner names the run and is dismissible per run id", () => {
  const degraded: State = { ...state, workflows_degraded: 1, workflows_degraded_run: { run_id: "wf_x", name: "browns-coverage" } };

  it("names the most recently degraded run", () => {
    render(<Board state={degraded} />);
    expect(screen.getByText(/browns-coverage/)).toBeTruthy();
  });

  it("dismisses the banner for that run id, persisted, and stays gone across a fresh render", () => {
    const { unmount } = render(<Board state={degraded} />);
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByText(/workflow data looks off/i)).toBeNull();
    unmount();
    render(<Board state={degraded} />);
    expect(screen.queryByText(/workflow data looks off/i)).toBeNull();
  });

  it("does not dismiss a LATER run degraded under a different run id", () => {
    const { unmount } = render(<Board state={degraded} />);
    fireEvent.click(screen.getByLabelText("Dismiss"));
    unmount();
    const laterDegraded: State = { ...state, workflows_degraded: 1, workflows_degraded_run: { run_id: "wf_y", name: "next-run" } };
    render(<Board state={laterDegraded} />);
    expect(screen.getByText(/next-run/)).toBeTruthy();
  });

  it("caps the persisted dismissed-run list rather than growing it forever (finding fix)", () => {
    const existing = Array.from({ length: 20 }, (_, i) => `wf_old_${i}`);
    localStorage.setItem("am-degraded-dismissed", JSON.stringify(existing));
    render(<Board state={degraded} />);
    fireEvent.click(screen.getByLabelText("Dismiss"));
    const stored = JSON.parse(localStorage.getItem("am-degraded-dismissed")!);
    expect(stored.length).toBe(20);
    expect(stored).toContain("wf_x"); // the just-dismissed run survives the cap
    expect(stored).not.toContain("wf_old_0"); // the oldest entry is the one dropped
  });
});

describe("Board §5.2: last workflow run line", () => {
  it("shows it when nothing is live", () => {
    render(<Board state={state} lastRun={{ run_id: "wf_x", name: "research", status: "completed", ended_at: Date.now() - 7_200_000, costUsd: 4.39 }} />);
    expect(screen.getByText(/Last run: research/)).toBeTruthy();
  });

  it("omits it when there is no last run either", () => {
    render(<Board state={state} />);
    expect(screen.queryByText(/Last run:/)).toBeNull();
  });
});

describe("Board §5.2: ready / skeleton", () => {
  it("shows skeleton placeholders instead of the (empty) session lists before ready", () => {
    const { container } = render(<Board state={{ ...state, sessions: [] }} ready={false} />);
    // three columns, each with its own skeleton block
    expect(container.querySelectorAll(".am-pulse").length).toBeGreaterThan(0);
    expect(screen.queryByText("browns")).toBeNull();
  });

  it("renders real sessions once ready (the default)", () => {
    render(<Board state={state} />);
    expect(screen.getByText("browns")).toBeTruthy();
  });

  it("passes ready through to the AppBar's counts", () => {
    render(<Board state={state} ready={false} />);
    expect(screen.getByTestId("appbar-count-working").textContent).toContain("…");
  });

  it("shows … instead of a confident 0 in a session column's own header before ready (finding fix)", () => {
    render(<Board state={{ ...state, sessions: [] }} ready={false} />);
    const idle = screen.getByTestId("session-group-idle");
    expect(within(idle).getByText("…")).toBeTruthy();
    expect(within(idle).queryByText("0")).toBeNull();
  });

  it("shows … in the harness filter's counts before ready, not confident zeroes (finding fix)", () => {
    render(<Board state={{ ...state, sessions: [] }} ready={false} />);
    expect(screen.getByText("All (…)")).toBeTruthy();
    expect(screen.queryByText("All (0)")).toBeNull();
  });
});

describe("Board §5.2: reconnecting bar", () => {
  it("is absent while connected (the default)", () => {
    render(<Board state={state} />);
    expect(screen.queryByTestId("reconnecting-bar")).toBeNull();
  });

  it("shows a stale-data warning once disconnected", () => {
    render(<Board state={state} connected={false} lastMessageAt={Date.now() - 120_000} />);
    const bar = screen.getByTestId("reconnecting-bar");
    expect(bar.textContent).toContain("Reconnecting");
    expect(bar.textContent).toContain("2m ago");
  });
});

describe("Board §5.1: harness filter", () => {
  const mixed: State = {
    ...state,
    sessions: [
      { ...state.sessions[0], id: "c1", harness: "claude" },
      { ...state.sessions[0], id: "c2", harness: "codex", project: "codex-proj" },
      { ...state.sessions[0], id: "c3", harness: "cursor", project: "cursor-proj" },
    ],
  };

  it("shows every harness with counts by default", () => {
    render(<Board state={mixed} />);
    expect(screen.getByText("All (3)")).toBeTruthy();
    expect(screen.getByText("Claude (1)")).toBeTruthy();
    expect(screen.getByText("Codex (1)")).toBeTruthy();
    expect(screen.getByText("Cursor (1)")).toBeTruthy();
  });

  it("filters the session list to the selected harness and persists the choice", () => {
    render(<Board state={mixed} />);
    fireEvent.click(screen.getByRole("button", { name: "Codex (1)" }));
    expect(screen.getByText("codex-proj")).toBeTruthy();
    expect(screen.queryByText("cursor-proj")).toBeNull();
    expect(localStorage.getItem("am-session-harness-filter")).toBe(JSON.stringify("codex"));
  });

  it("treats a session with no harness field as claude (restart-skew)", () => {
    const legacy: State = { ...state, sessions: [{ ...state.sessions[0], id: "c1" }] };
    render(<Board state={legacy} />);
    expect(screen.getByText("Claude (1)")).toBeTruthy();
  });
});

describe("Board §5.1: nested child sessions", () => {
  it("nests a child under its parent, indented, within the same column", () => {
    const withChild: State = {
      ...state,
      sessions: [
        state.sessions[0],
        { ...state.sessions[0], id: "child1", project: "child-proj", parent_session_id: "s1" },
      ],
    };
    const { container } = render(<Board state={withChild} />);
    expect(screen.getByText("child-proj")).toBeTruthy();
    // the connector wrapper (same idiom as WorkflowsPage's phase tree)
    expect(container.querySelector(".border-l-hairline")).toBeTruthy();
  });

  it("shows a 'spawned by' hint for a child whose parent isn't in the same column", () => {
    const orphan: State = {
      ...state,
      sessions: [
        { ...state.sessions[0], id: "parent1", project: "orchestrator", status: "idle" },
        { ...state.sessions[0], id: "child1", project: "child-proj", status: "working", parent_session_id: "parent1" },
      ],
    };
    render(<Board state={orphan} />);
    expect(screen.getByText(/spawned by orchestrator/)).toBeTruthy();
  });
});
