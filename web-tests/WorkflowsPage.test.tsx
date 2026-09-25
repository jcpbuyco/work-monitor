import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { WorkflowsPage } from "../src/web/components/WorkflowsPage.tsx";
import type { WorkflowRun, WorkflowRunSummary } from "../src/web/types.ts";

const T = new Date(2026, 5, 16, 14, 3).getTime();

const agent = (over: Partial<WorkflowRun["agents"][number]>): WorkflowRun["agents"][number] => ({
  agent_id: "a1", label: null, phase_index: null, phase_title: null, idx: null, model: null,
  state: "done", attempt: 1, last_tool: null, last_tool_summary: null, prompt_preview: null,
  started_at: null, ended_at: null, duration_ms: null, tool_calls: null, tokens: 0, costUsd: 0,
  ...over,
});

/** §3: the list endpoint's shape -- no `agents`, an `agent_counts` rollup instead. */
const RUNS: WorkflowRunSummary[] = [
  {
    run_id: "wf_a", session_id: "s1", project: "alpha", branch: "main", name: "research",
    summary: null, status: "completed", state: "settled", error: null, started_at: T, ended_at: T + 1000,
    duration_ms: 185_000, agent_count: 2, phases: [{ title: "Explore", detail: null }],
    cc_version: "2.1.226", schema_ok: true, total_tokens_reported: 99, costUsd: 2, tokens: 100,
    agent_counts: { total: 2, done: 1, error: 0, running: 0, abandoned: 1, killed: 0 },
  },
  {
    run_id: "wf_b", session_id: "s2", project: "beta", branch: null, name: null,
    summary: null, status: "brand-new-status", state: "settled", error: null, started_at: T - 86_400_000,
    ended_at: null, duration_ms: null, agent_count: 1, phases: [], cc_version: null, schema_ok: false,
    total_tokens_reported: null, costUsd: 9, tokens: 900,
    agent_counts: { total: 1, done: 1, error: 0, running: 0, abandoned: 0, killed: 0 },
  },
];

/** Full detail (WITH agents) for wf_a, as GET /api/workflows/:runId returns it. */
const WF_A_DETAIL: WorkflowRun = {
  ...RUNS[0],
  agents: [
    agent({ agent_id: "a1", label: "map-codebase", phase_index: 1, phase_title: "Explore", model: "claude-sonnet-5", tokens: 60, costUsd: 1.5 }),
    agent({ agent_id: "a2", label: null, phase_index: null, state: "abandoned", tokens: 40, costUsd: 0.5 }),
  ],
};

const WF_B_DETAIL: WorkflowRun = { ...RUNS[1], agents: [agent({ agent_id: "b1" })] };

const DETAILS: Record<string, WorkflowRun> = { wf_a: WF_A_DETAIL, wf_b: WF_B_DETAIL };

/** The list endpoint and the per-run detail endpoint share one mocked `fetch`,
 *  dispatched by URL -- exactly how the real page calls them (§3: the list
 *  never carries agents; an expanded row fetches its own detail lazily). */
function mockFetch(runs: unknown, details: Record<string, WorkflowRun> = DETAILS) {
  const fn = vi.fn(async (url: string) => {
    const m = /\/api\/workflows\/([^/?]+)$/.exec(url);
    if (m) {
      const run = details[decodeURIComponent(m[1])];
      return run
        ? { ok: true, json: async () => run }
        : { ok: false, status: 404, json: async () => ({ error: "not found" }) };
    }
    return { ok: true, json: async () => ({ runs, total: Array.isArray(runs) ? runs.length : 0 }) };
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

afterEach(cleanup);
beforeEach(() => vi.restoreAllMocks());

describe("WorkflowsPage", () => {
  it("fetches and renders one row per run with formatted cells", async () => {
    mockFetch(RUNS);
    render(<WorkflowsPage />);
    expect(await screen.findByText("research")).toBeTruthy();
    expect(screen.getByText("wf_b")).toBeTruthy(); // name is null -> run_id fallback
    expect(screen.getByText("Jun 16 14:03")).toBeTruthy();
    expect(screen.getByText("3m 5s")).toBeTruthy();
    expect(screen.getByText("$9.00")).toBeTruthy();
  });

  it("renders an unknown status without rejecting it, marked as unknown", async () => {
    mockFetch(RUNS);
    render(<WorkflowsPage />);
    const cell = await screen.findByText("brand-new-status");
    expect(cell.getAttribute("data-status-known")).toBe("false");
    expect(screen.getByText("completed").getAttribute("data-status-known")).toBe("true");
  });

  it("shows a totals row summing agent_counts, tokens and cost", async () => {
    mockFetch(RUNS);
    render(<WorkflowsPage />);
    await screen.findByText("research");
    const totals = screen.getByTestId("wf-totals");
    expect(within(totals).getByText("3")).toBeTruthy(); // 2 + 1 agents
    expect(within(totals).getByText("$11.00")).toBeTruthy(); // 2 + 9
  });

  it("renders a null (unpriced) run cost as text, and excludes it from the totals sum, instead of crashing (§2.3, finding)", async () => {
    const unpriced: WorkflowRunSummary = { ...RUNS[0], run_id: "wf_u", name: "unpriced-run", costUsd: null };
    mockFetch([...RUNS, unpriced]);
    render(<WorkflowsPage />);
    await screen.findByText("unpriced-run");
    expect(screen.getAllByText("unpriced").length).toBeGreaterThanOrEqual(1);
    const totals = screen.getByTestId("wf-totals");
    expect(within(totals).getByText("$11.00")).toBeTruthy(); // unchanged: null contributes 0, not NaN
  });

  it("sorts by cost descending when the Cost header is clicked", async () => {
    mockFetch(RUNS);
    render(<WorkflowsPage />);
    await screen.findByText("research");
    fireEvent.click(screen.getByRole("button", { name: /cost/i }));
    const rows = screen.getAllByTestId("wf-row");
    expect(within(rows[0]).getByText("$9.00")).toBeTruthy(); // wf_b (9.0) first
  });

  it("refetches with the window's since param when the range changes", async () => {
    const fn = mockFetch(RUNS);
    render(<WorkflowsPage />);
    await screen.findByText("research");
    expect(String(fn.mock.calls[0][0])).toContain("since="); // default 14d
    fireEvent.click(screen.getByRole("button", { name: /^all$/i }));
    expect(String(fn.mock.calls.at(-1)![0])).not.toContain("since=");
  });

  it("expands a row into per-agent detail grouped under its phase, fetched lazily from GET /api/workflows/:runId (§3)", async () => {
    const fn = mockFetch(RUNS);
    render(<WorkflowsPage />);
    fireEvent.click(await screen.findByText("research"));
    expect(await screen.findByText("map-codebase")).toBeTruthy();
    expect(screen.getByText("Phase 1 · Explore")).toBeTruthy();
    expect(screen.getByText("unphased")).toBeTruthy(); // the NULL phase_index agent groups last
    expect(screen.getByText("a2")).toBeTruthy(); // agentId fallback when label is null
    expect(screen.getByText("Sonnet 5")).toBeTruthy(); // prettyModel
    // The list fetch, then exactly one detail fetch for the expanded run.
    expect(fn.mock.calls.some((c) => String(c[0]).endsWith("/api/workflows/wf_a"))).toBe(true);
  });

  it("shows a loading placeholder while a row's detail fetch is in flight, then fetches only once per run", async () => {
    let resolveDetail!: (run: WorkflowRun) => void;
    const fn = vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/workflows/wf_a")) {
        return new Promise((resolve) => {
          resolveDetail = (run) => resolve({ ok: true, json: async () => run });
        });
      }
      return { ok: true, json: async () => ({ runs: RUNS, total: RUNS.length }) };
    });
    global.fetch = fn as unknown as typeof fetch;
    render(<WorkflowsPage />);
    fireEvent.click(await screen.findByText("research"));
    expect(await screen.findByText(/loading agents/i)).toBeTruthy();
    resolveDetail(WF_A_DETAIL);
    expect(await screen.findByText("map-codebase")).toBeTruthy();
    // Collapsing and re-expanding must not re-fetch a detail already in hand.
    fireEvent.click(screen.getByText("research"));
    fireEvent.click(screen.getByText("research"));
    expect(await screen.findByText("map-codebase")).toBeTruthy();
    expect(fn.mock.calls.filter((c) => String(c[0]).endsWith("/api/workflows/wf_a")).length).toBe(1);
  });

  it("retries a per-row detail fetch that previously failed, on the next expand (§3 minor finding: 'error' must not stick forever)", async () => {
    let calls = 0;
    const fn = vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/workflows/wf_a")) {
        calls++;
        if (calls === 1) return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
        return { ok: true, json: async () => WF_A_DETAIL };
      }
      return { ok: true, json: async () => ({ runs: RUNS, total: RUNS.length }) };
    });
    global.fetch = fn as unknown as typeof fetch;
    render(<WorkflowsPage />);
    fireEvent.click(await screen.findByText("research"));
    expect(await screen.findByText(/couldn.t load agents/i)).toBeTruthy();
    // Collapse, then re-expand: a failed detail fetch is retryable, not stuck.
    fireEvent.click(screen.getByText("research"));
    fireEvent.click(screen.getByText("research"));
    expect(await screen.findByText("map-codebase")).toBeTruthy();
    expect(calls).toBe(2);
  });

  it("shows an empty state when there are no runs", async () => {
    mockFetch([]);
    render(<WorkflowsPage />);
    expect(await screen.findByText(/no workflow runs/i)).toBeTruthy();
  });

  it("shows an error state when the fetch fails", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("boom")) as unknown as typeof fetch;
    render(<WorkflowsPage />);
    expect(await screen.findByText(/couldn.t load/i)).toBeTruthy();
  });

  it("surfaces the newest run's Claude Code version so fixtures get re-checked after an upgrade", async () => {
    mockFetch(RUNS);
    render(<WorkflowsPage />);
    expect(await screen.findByText(/format last verified on 2\.1\.226/)).toBeTruthy();
  });

  it("marks each run with a glyph that agrees with its status label", async () => {
    mockFetch(RUNS);
    const { container } = render(<WorkflowsPage />);
    await screen.findByText("research");
    expect(container.querySelector('[data-glyph="ended"]')).toBeTruthy(); // completed
    expect(screen.getByText("completed").className).toContain("text-done");
  });

  it("keeps the totals row last in tbody with its 8 cells", async () => {
    mockFetch(RUNS);
    render(<WorkflowsPage />);
    await screen.findByText("research");
    const totals = screen.getByTestId("wf-totals");
    expect(totals.querySelectorAll("td").length).toBe(8);
    expect(totals.parentElement!.lastElementChild).toBe(totals);
    // the caret must carry no text, or findByText("research") stops resolving
    expect(screen.getAllByTestId("wf-row")[0].querySelector("svg")).toBeTruthy();
  });
});
