import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const EMPTY_STATE = {
  sessions: [], todos: [], activity: [], stats: [],
  cost: { perSession: {}, liveTotalUsd: 0, todayUsd: 0, byModelToday: [], byProject: [], byBranch: [] },
};

vi.mock("../src/web/api.ts", () => ({
  fetchState: () => Promise.resolve(EMPTY_STATE),
  subscribe: () => () => {},
}));

afterEach(cleanup);
beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({ json: async () => ({ rows: [] }) }) as unknown as typeof fetch;
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
});
