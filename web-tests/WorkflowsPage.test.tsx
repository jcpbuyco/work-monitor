import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { WorkflowsPage } from "../src/web/components/WorkflowsPage.tsx";
import type { WorkflowRun } from "../src/web/types.ts";

const T = new Date(2026, 5, 16, 14, 3).getTime();

const agent = (over: Partial<WorkflowRun["agents"][number]>): WorkflowRun["agents"][number] => ({
  agent_id: "a1", label: null, phase_index: null, phase_title: null, idx: null, model: null,
  state: "done", attempt: 1, last_tool: null, last_tool_summary: null, prompt_preview: null,
  started_at: null, ended_at: null, duration_ms: null, tool_calls: null, tokens: 0, costUsd: 0,
  ...over,
});

const RUNS: WorkflowRun[] = [
  {
    run_id: "wf_a", session_id: "s1", project: "alpha", branch: "main", name: "research",
    summary: null, status: "completed", state: "settled", error: null, started_at: T, ended_at: T + 1000,
    duration_ms: 185_000, agent_count: 2, phases: [{ title: "Explore", detail: null }],
    cc_version: "2.1.226", schema_ok: true, total_tokens_reported: 99, costUsd: 2, tokens: 100,
    agents: [
      agent({ agent_id: "a1", label: "map-codebase", phase_index: 1, phase_title: "Explore", model: "claude-sonnet-5", tokens: 60, costUsd: 1.5 }),
      agent({ agent_id: "a2", label: null, phase_index: null, state: "abandoned", tokens: 40, costUsd: 0.5 }),
    ],
  },
  {
    run_id: "wf_b", session_id: "s2", project: "beta", branch: null, name: null,
    summary: null, status: "brand-new-status", state: "settled", error: null, started_at: T - 86_400_000,
    ended_at: null, duration_ms: null, agent_count: 1, phases: [], cc_version: null, schema_ok: false,
    total_tokens_reported: null, costUsd: 9, tokens: 900, agents: [agent({ agent_id: "b1" })],
  },
];

function mockFetch(runs: unknown) {
  const fn = vi.fn().mockResolvedValue({ json: async () => ({ runs }) });
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

  it("shows a totals row summing agents, tokens and cost", async () => {
    mockFetch(RUNS);
    render(<WorkflowsPage />);
    await screen.findByText("research");
    const totals = screen.getByTestId("wf-totals");
    expect(within(totals).getByText("3")).toBeTruthy(); // 2 + 1 agents
    expect(within(totals).getByText("$11.00")).toBeTruthy(); // 2 + 9
  });

  it("sorts by cost descending when the Cost header is clicked", async () => {
    mockFetch(RUNS);
    render(<WorkflowsPage />);
    await screen.findByText("research");
    fireEvent.click(screen.getByRole("button", { name: /cost/i }));
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]).getByText("$9.00")).toBeTruthy(); // wf_b (9.0) first
  });

  it("refetches with the window's since param when the range changes", async () => {
    const fn = mockFetch(RUNS);
    render(<WorkflowsPage />);
    await screen.findByText("research");
    expect(String(fn.mock.calls[0][0])).toContain("since="); // default 14d
    fireEvent.click(screen.getByRole("button", { name: /^all$/i }));
    expect(String(fn.mock.calls.at(-1)![0])).not.toContain("since=");
  });

  it("expands a row into per-agent detail grouped under its phase", async () => {
    mockFetch(RUNS);
    render(<WorkflowsPage />);
    fireEvent.click(await screen.findByText("research"));
    expect(screen.getByText("Phase 1 · Explore")).toBeTruthy();
    expect(screen.getByText("map-codebase")).toBeTruthy();
    expect(screen.getByText("unphased")).toBeTruthy(); // the NULL phase_index agent groups last
    expect(screen.getByText("a2")).toBeTruthy(); // agentId fallback when label is null
    expect(screen.getByText("Sonnet 5")).toBeTruthy(); // prettyModel
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
});
