import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

const EMPTY_STATE = {
  sessions: [], todos: [], activity: [], stats: [],
  cost: { perSession: {}, liveTotalUsd: 0, todayUsd: 0, byModelToday: [], byProject: [], byBranch: [] },
};

let handlers: any = null;
// Overridable per test (default: resolves immediately, matching the old
// fixed-fixture mock) - §5.2's ready/connected tests need to control exactly
// when the first response lands.
let fetchStateImpl = () => Promise.resolve(EMPTY_STATE);

vi.mock("../src/web/api.ts", () => ({
  fetchState: () => fetchStateImpl(),
  subscribe: (h: any) => {
    handlers = h;
    return () => {};
  },
}));

afterEach(cleanup);
beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({ json: async () => ({ rows: [], runs: [] }) }) as unknown as typeof fetch;
  fetchStateImpl = () => Promise.resolve(EMPTY_STATE);
  handlers = null;
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

  it("routes a session row's workflow-chip deep link (#/workflows?run=<id>) to the workflows page, not the board", async () => {
    window.location.hash = "#/workflows?run=wf_abc";
    const App = (await import("../src/web/App.tsx")).default;
    render(<App />);
    expect(await screen.findByText("Workflow runs")).toBeTruthy();
  });

  it("routes #/cost?<anything> to the cost page the same way", async () => {
    window.location.hash = "#/cost?foo=bar";
    const App = (await import("../src/web/App.tsx")).default;
    render(<App />);
    expect(await screen.findByText("Cost by day")).toBeTruthy();
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

describe("App §5.2: ready state", () => {
  it("shows … counts (not ready) until the first /api/state response lands", async () => {
    window.location.hash = "#/";
    let resolveFetch: (v: typeof EMPTY_STATE) => void = () => {};
    fetchStateImpl = () => new Promise((resolve) => (resolveFetch = resolve));
    const App = (await import("../src/web/App.tsx")).default;
    render(<App />);

    expect(await screen.findByTestId("appbar-count-working")).toHaveProperty("textContent", "… working");

    await act(async () => {
      resolveFetch(EMPTY_STATE);
      await Promise.resolve();
    });
    expect(screen.getByTestId("appbar-count-working").textContent).toBe("0 working");
  });

  it("a workflows SSE tick alone does not mark the app ready - only /api/state does", async () => {
    window.location.hash = "#/";
    fetchStateImpl = () => new Promise(() => {}); // never resolves
    const App = (await import("../src/web/App.tsx")).default;
    render(<App />);
    await screen.findByTestId("appbar-count-working");
    act(() => handlers.onWorkflows([]));
    // ready is still gated on /api/state specifically (a workflows tick alone
    // is not "the board has real session data") -- still pending.
    expect(screen.getByTestId("appbar-count-working").textContent).toBe("… working");
  });
});

describe("App §5.2: connection staleness", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows the reconnecting bar once the stream has been silent past the staleness window", async () => {
    window.location.hash = "#/";
    const App = (await import("../src/web/App.tsx")).default;
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("reconnecting-bar")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(95_000);
    });
    expect(screen.getByTestId("reconnecting-bar")).toBeTruthy();
  });

  it("clears the reconnecting bar again once a new message arrives", async () => {
    window.location.hash = "#/";
    const App = (await import("../src/web/App.tsx")).default;
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(95_000);
    });
    expect(screen.getByTestId("reconnecting-bar")).toBeTruthy();

    act(() => handlers.onWorkflows([]));
    expect(screen.queryByTestId("reconnecting-bar")).toBeNull();
  });

  it("never shows the reconnecting bar on an idle-but-open stream kept alive by server pings (§5.2 fix)", async () => {
    window.location.hash = "#/";
    const App = (await import("../src/web/App.tsx")).default;
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });

    // Simulate the server's SseHub keepalive (a `ping` every 30s) via the
    // same `onOpen` handler api.ts wires it through -- no real state or
    // workflows traffic at all, for well past the 90s staleness window.
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      act(() => handlers.onOpen());
    }
    expect(screen.queryByTestId("reconnecting-bar")).toBeNull();
  });

  it("flags disconnected immediately on the EventSource's own error/close, not after the staleness window", async () => {
    window.location.hash = "#/";
    const App = (await import("../src/web/App.tsx")).default;
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("reconnecting-bar")).toBeNull();

    act(() => handlers.onClose());
    expect(screen.getByTestId("reconnecting-bar")).toBeTruthy();
  });
});
