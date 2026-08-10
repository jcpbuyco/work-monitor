import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

const EMPTY_STATE = {
  sessions: [], todos: [], activity: [], stats: [],
  cost: { perSession: {}, liveTotalUsd: 0, todayUsd: 0, byModelToday: [], byProject: [], byBranch: [] },
};

let handlers: any = null;
vi.mock("../src/web/api.ts", () => ({
  fetchState: () => Promise.resolve(EMPTY_STATE),
  subscribe: (h: any) => {
    handlers = h;
    return () => {};
  },
}));

afterEach(cleanup);
beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({ json: async () => ({ rows: [], runs: [] }) }) as unknown as typeof fetch;
});

describe("App routing", () => {
  it("renders the cost page at #/cost", async () => {
    window.location.hash = "#/cost";
    const App = (await import("../src/web/App.tsx")).default;
    render(<App />);
    expect(await screen.findByText("Cost by day")).toBeTruthy();
  });

  it("renders the dashboard otherwise", async () => {
    window.location.hash = "#/";
    const App = (await import("../src/web/App.tsx")).default;
    render(<App />);
    expect(await screen.findByText("agent-monitor")).toBeTruthy(); // AppBar title
  });

  it("renders the workflows page at #/workflows", async () => {
    window.location.hash = "#/workflows";
    const App = (await import("../src/web/App.tsx")).default;
    render(<App />);
    expect(await screen.findByText("Workflow runs")).toBeTruthy();
  });

  it("feeds the workflows SSE event into the board, outside the state blob", async () => {
    window.location.hash = "#/";
    const App = (await import("../src/web/App.tsx")).default;
    render(<App />);
    await screen.findByText("agent-monitor");
    expect(typeof handlers.onWorkflows).toBe("function");
    act(() =>
      handlers.onWorkflows([
        { run_id: "wf_abc", session_id: "s1", project: "p", branch: null, name: "research", status: null,
          state: "running", started_at: Date.now(), phase: null, schema_ok: true, costUsd: 0, tokens: 0, agents: [] },
      ])
    );
    expect(screen.getByRole("button", { name: /Workflows \(1\)/ })).toBeTruthy();
  });
});
