import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within, waitFor, act } from "@testing-library/react";
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

afterEach(() => {
  cleanup();
  window.location.hash = "";
  vi.useRealTimers();
});
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

  it("sorts by cost descending WITHIN a day group when the Cost header is clicked (§5.3 day grouping)", async () => {
    // Day-grouping is now a fixed structural feature of the page (§5.3): a
    // column sort other than "When" only reorders rows WITHIN a day, while
    // the days themselves stay newest-first. Both rows here share a day so the
    // sort is observable without a day boundary confusing it.
    const sameDay: WorkflowRunSummary[] = [
      { ...RUNS[0], run_id: "wf_x", name: "cheap-run", costUsd: 2, started_at: T },
      { ...RUNS[0], run_id: "wf_y", name: "pricey-run", costUsd: 9, started_at: T + 60_000 },
    ];
    mockFetch(sameDay);
    render(<WorkflowsPage />);
    await screen.findByText("cheap-run");
    fireEvent.click(screen.getByRole("button", { name: /^cost$/i }));
    const rows = screen.getAllByTestId("wf-row");
    expect(within(rows[0]).getByText("$9.00")).toBeTruthy(); // pricey-run first
  });

  it("refetches with the window's since param when the range changes", async () => {
    const fn = mockFetch(RUNS);
    render(<WorkflowsPage />);
    await screen.findByText("research");
    expect(String(fn.mock.calls[0][0])).toContain("since="); // default 14d
    fireEvent.click(screen.getByRole("button", { name: /^all$/i }));
    await waitFor(() => expect(String(fn.mock.calls.at(-1)![0])).not.toContain("since="));
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

  it("shows the shared reconnecting bar when disconnected, same as the board (§5.2 finding fix)", async () => {
    // The banner used to live on Board alone, so this page - sharing the
    // exact same App-level SSE subscription - looked falsely healthy while
    // the stream was actually stale.
    mockFetch(RUNS);
    render(<WorkflowsPage connected={false} lastMessageAt={Date.now() - 120_000} />);
    expect(screen.getByTestId("reconnecting-bar").textContent).toContain("Reconnecting");
  });
});

describe("WorkflowsPage §5.3: search and project filter", () => {
  it("filters via the server's ?q= param, debounced so it doesn't refetch on every keystroke", async () => {
    const fn = mockFetch(RUNS);
    render(<WorkflowsPage />);
    await screen.findByText("research");
    const before = fn.mock.calls.length;
    fireEvent.change(screen.getByPlaceholderText(/search workflows/i), { target: { value: "resea" } });
    expect(fn.mock.calls.length).toBe(before); // not yet -- debounced
    await waitFor(() => expect(fn.mock.calls.some((c) => String(c[0]).includes("q=resea"))).toBe(true));
  });

  it("filters via the server's ?project= param, applied immediately (no debounce needed for a select)", async () => {
    const fn = mockFetch(RUNS);
    render(
      <WorkflowsPage
        state={{
          sessions: [], todos: [], activity: [], stats: [],
          cost: {
            perSession: {}, liveTotalUsd: 0, todayUsd: 0, byModelToday: [],
            byProject: [{ project: "alpha", costUsd: 1, tokens: 1 }, { project: "beta", costUsd: 1, tokens: 1 }],
            byBranch: [],
          },
        }}
      />
    );
    await screen.findByText("research");
    fireEvent.change(screen.getByLabelText(/filter by project/i), { target: { value: "beta" } });
    await waitFor(() => expect(String(fn.mock.calls.at(-1)![0])).toContain("project=beta"));
  });

  it("lists distinct projects from state.cost.byProject as filter options", async () => {
    mockFetch(RUNS);
    render(
      <WorkflowsPage
        state={{
          sessions: [], todos: [], activity: [], stats: [],
          cost: {
            perSession: {}, liveTotalUsd: 0, todayUsd: 0, byModelToday: [],
            byProject: [{ project: "zeta", costUsd: 1, tokens: 1 }, { project: "alpha", costUsd: 1, tokens: 1 }],
            byBranch: [],
          },
        }}
      />
    );
    await screen.findByText("research");
    const select = screen.getByLabelText(/filter by project/i) as HTMLSelectElement;
    const options = [...select.options].map((o) => o.value);
    expect(options).toEqual(["", "alpha", "zeta"]); // "All projects" first, then alphabetical
  });
});

describe("WorkflowsPage §5.3: keyboard-accessible expander", () => {
  it("exposes the expander as a real <button aria-expanded>, toggled by click", async () => {
    mockFetch(RUNS);
    render(<WorkflowsPage />);
    const btn = await screen.findByRole("button", { name: /research/ });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    await screen.findByText("map-codebase");
  });
});

describe("WorkflowsPage §5.3: day grouping", () => {
  it("groups runs under a day header, newest day first by default", async () => {
    mockFetch(RUNS); // wf_a = Jun 16, wf_b = Jun 15
    render(<WorkflowsPage />);
    await screen.findByText("research");
    expect(screen.getByText("Jun 16")).toBeTruthy();
    expect(screen.getByText("Jun 15")).toBeTruthy();
    const rows = screen.getAllByTestId("wf-row");
    expect(within(rows[0]).getByText("research")).toBeTruthy(); // Jun 16's run comes first
  });
});

describe("WorkflowsPage §5.3: 50 per page with Load more", () => {
  function page(n: number, offset: number): WorkflowRunSummary[] {
    return Array.from({ length: n }, (_, i) => ({
      ...RUNS[0], run_id: `wf_${offset + i}`, name: `run-${offset + i}`, started_at: T - (offset + i) * 1000,
    }));
  }

  it("shows Load more when more runs exist than the current page, and appends the next page on click", async () => {
    const fn = vi.fn(async (url: string) => {
      const u = new URL(url, "http://x");
      const offset = Number(u.searchParams.get("offset") ?? 0);
      return { ok: true, json: async () => ({ runs: page(Math.min(50, 60 - offset), offset), total: 60 }) };
    });
    global.fetch = fn as unknown as typeof fetch;
    render(<WorkflowsPage />);
    await screen.findByText("run-0");
    expect(screen.getAllByTestId("wf-row").length).toBe(50);
    const more = screen.getByRole("button", { name: /load more/i });
    fireEvent.click(more);
    await waitFor(() => expect(screen.getAllByTestId("wf-row").length).toBe(60));
    expect(fn.mock.calls.some((c) => String(c[0]).includes("offset=50"))).toBe(true);
  });

  it("shows no Load more button once every run is loaded", async () => {
    mockFetch(RUNS); // total === runs.length
    render(<WorkflowsPage />);
    await screen.findByText("research");
    expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
  });
});

describe("WorkflowsPage §5.3: deep link #/workflows?run=<id>", () => {
  it("auto-expands and scrolls to the linked run when it's already on the loaded page", async () => {
    window.location.hash = "#/workflows?run=wf_b";
    mockFetch(RUNS);
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    render(<WorkflowsPage />);
    const btn = await screen.findByRole("button", { name: /wf_b/ });
    await waitFor(() => expect(btn.getAttribute("aria-expanded")).toBe("true"));
    await screen.findByText("b1"); // wf_b's lone agent, from its auto-fetched detail
    expect(scrollSpy).toHaveBeenCalled();
  });

  it("never pins an ordinarily-expanded row -- expanding one, then searching, must not leak it into the filtered results (regression)", async () => {
    // No `run=` deep link at all here: a plain row expand must never trigger
    // the pinned-run merge, or the pinned row keeps reappearing in every
    // later search/project-filtered fetch even though it doesn't match.
    const fn = vi.fn(async (url: string) => {
      const m = /\/api\/workflows\/([^/?]+)$/.exec(url);
      if (m) return { ok: true, json: async () => DETAILS[decodeURIComponent(m[1])] };
      const q = new URL(url, "http://x").searchParams.get("q");
      const matched = q ? RUNS.filter((r) => (r.name ?? r.run_id).includes(q)) : RUNS;
      return { ok: true, json: async () => ({ runs: matched, total: matched.length }) };
    });
    global.fetch = fn as unknown as typeof fetch;
    render(<WorkflowsPage />);
    fireEvent.click(await screen.findByText("research")); // expand wf_a -- an ORDINARY click, no deep link
    await screen.findByText("map-codebase");
    fireEvent.change(screen.getByPlaceholderText(/search workflows/i), { target: { value: "wf_b" } });
    await waitFor(() => expect(fn.mock.calls.some((c) => String(c[0]).includes("q=wf_b"))).toBe(true));
    await screen.findByText("wf_b");
    // wf_a ("research") must be gone -- it does not match the "wf_b" search,
    // and the earlier expand must not have pinned it in place.
    expect(screen.queryByText("research")).toBeNull();
    const totals = screen.getByTestId("wf-totals");
    expect(within(totals).getByText("1 run")).toBeTruthy();
  });

  it("fetches and merges the linked run even when it isn't on the currently loaded page", async () => {
    window.location.hash = "#/workflows?run=wf_a";
    // The list never returns wf_a at all (e.g. it's outside the default
    // window or a different project) -- the deep link still has to work.
    mockFetch([RUNS[1]]);
    Element.prototype.scrollIntoView = vi.fn();
    render(<WorkflowsPage />);
    const btn = await screen.findByRole("button", { name: /research/ });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    await screen.findByText("map-codebase");
  });

  it("renders an off-page linked run in its own 'Linked run' block, and does NOT inflate the totals row, the runsCountLabel or Load-more's arithmetic (regression: '12 of 11 runs')", async () => {
    window.location.hash = "#/workflows?run=wf_a";
    // The server-side total is 1 (only wf_b matches the active filters);
    // wf_a is merged in purely for display via the deep link.
    mockFetch([RUNS[1]]);
    Element.prototype.scrollIntoView = vi.fn();
    render(<WorkflowsPage />);
    await screen.findByText("map-codebase"); // wf_a's detail, fetched via the deep link

    expect(screen.getByText("Linked run")).toBeTruthy();

    const totals = screen.getByTestId("wf-totals");
    // "1 run", never "2 of 1 runs" -- wf_a must not count towards the total.
    expect(within(totals).getByText("1 run")).toBeTruthy();
    // wf_b alone: agent_counts.total 1, tokens 900, cost $9 -- NOT wf_a's own
    // 2 agents / 100 tokens / $2 on top.
    expect(within(totals).getByText("1")).toBeTruthy();
    expect(within(totals).getByText("$9.00")).toBeTruthy();

    // Every run that matches the filters is already loaded (1 of 1) -- Load
    // more must not appear just because a linked run was merged in too.
    expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
  });

  it("keeps a pinned run's row out of the day-grouped list and Load-more count even when the loaded page is itself a full page (regression)", async () => {
    // 50 loaded, 60 total -- Load more must reflect exactly that, regardless
    // of a pinned run merged in on top.
    const page50 = Array.from({ length: 50 }, (_, i) => ({
      ...RUNS[0], run_id: `wf_p${i}`, name: `page-run-${i}`, started_at: T - i * 1000,
    }));
    window.location.hash = "#/workflows?run=wf_a";
    const fn = vi.fn(async (url: string) => {
      const m = /\/api\/workflows\/([^/?]+)$/.exec(url);
      if (m) return { ok: true, json: async () => DETAILS[decodeURIComponent(m[1])] };
      return { ok: true, json: async () => ({ runs: page50, total: 60 }) };
    });
    global.fetch = fn as unknown as typeof fetch;
    Element.prototype.scrollIntoView = vi.fn();
    render(<WorkflowsPage />);
    await screen.findByText("map-codebase");
    const totals = screen.getByTestId("wf-totals");
    expect(within(totals).getByText("50 of 60 runs")).toBeTruthy();
    expect(screen.getByRole("button", { name: /load more/i })).toBeTruthy();
  });

  it("targets the card's header, not the whole (possibly huge) expanded card, for the deep-link scroll on phones (regression: centring landed mid-agent-list on a large run)", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: true, // "(max-width: 767px)" -- below md
      media: q, addEventListener() {}, removeEventListener() {},
    }));
    window.location.hash = "#/workflows?run=wf_a";
    mockFetch(RUNS);
    Element.prototype.scrollIntoView = vi.fn();
    render(<WorkflowsPage />);
    await screen.findByText("map-codebase");
    const scrollTarget = document.querySelector('[data-run-id="wf_a"]') as HTMLElement;
    expect(scrollTarget).toBeTruthy();
    // The scroll target must NOT be (or contain) the huge expanded agent
    // list -- only the card's own header/name/status.
    expect(scrollTarget.textContent).not.toContain("map-codebase");
    expect(within(scrollTarget).getByText("research")).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

describe("WorkflowsPage §5.3: expanded run detail", () => {
  it("shows the manifest's summary line and error in a mono danger block", async () => {
    const detail: WorkflowRun = { ...WF_A_DETAIL, summary: "7 of 8 agents completed", error: "TypeError: boom" };
    mockFetch(RUNS, { wf_a: detail, wf_b: WF_B_DETAIL });
    render(<WorkflowsPage />);
    fireEvent.click(await screen.findByText("research"));
    expect(await screen.findByText("7 of 8 agents completed")).toBeTruthy();
    const err = await screen.findByText("TypeError: boom");
    expect(err.tagName).toBe("PRE");
    expect(err.className).toContain("text-danger");
  });

  it("appends a disambiguating idx only to agents whose label repeats within the run", async () => {
    const detail: WorkflowRun = {
      ...WF_A_DETAIL,
      agents: [
        agent({ agent_id: "v0", label: "verify", idx: 0 }),
        agent({ agent_id: "v1", label: "verify", idx: 1 }),
        agent({ agent_id: "u1", label: "unique-agent" }),
      ],
    };
    mockFetch(RUNS, { wf_a: detail, wf_b: WF_B_DETAIL });
    render(<WorkflowsPage />);
    fireEvent.click(await screen.findByText("research"));
    expect(await screen.findByText("verify · #0")).toBeTruthy();
    expect(screen.getByText("verify · #1")).toBeTruthy();
    expect(screen.getByText("unique-agent")).toBeTruthy(); // no suffix -- not a duplicate
  });

  it("shows 'attempt N' only when N > 1 -- no 'attempt 1' noise", async () => {
    const detail: WorkflowRun = {
      ...WF_A_DETAIL,
      agents: [agent({ agent_id: "a1", label: "one-shot", attempt: 1 }), agent({ agent_id: "a2", label: "retried", attempt: 3 })],
    };
    mockFetch(RUNS, { wf_a: detail, wf_b: WF_B_DETAIL });
    render(<WorkflowsPage />);
    fireEvent.click(await screen.findByText("research"));
    await screen.findByText("retried");
    expect(screen.getByText("attempt 3")).toBeTruthy();
    expect(screen.queryByText("attempt 1")).toBeNull();
  });

  it("styles last_tool_summary as live only while the run itself is running -- no live-blue on a settled run", async () => {
    const detail: WorkflowRun = {
      ...WF_A_DETAIL,
      state: "settled",
      agents: [agent({ agent_id: "a1", label: "quiet-now", last_tool_summary: "Edit foo.ts" })],
    };
    mockFetch(RUNS, { wf_a: detail, wf_b: WF_B_DETAIL });
    render(<WorkflowsPage />);
    fireEvent.click(await screen.findByText("research"));
    const tool = await screen.findByText("Edit foo.ts");
    expect(tool.className).not.toContain("text-working");
    expect(tool.textContent).toBe("Edit foo.ts"); // no live "▸ " prefix
  });

  it("keeps the live-blue arrow styling for a genuinely running run", async () => {
    const running: WorkflowRunSummary = { ...RUNS[0], run_id: "wf_r", name: "still-going", state: "running", status: "running" };
    const detail: WorkflowRun = {
      ...WF_A_DETAIL,
      run_id: "wf_r",
      state: "running",
      agents: [agent({ agent_id: "a1", label: "busy", state: "running", last_tool_summary: "Edit bar.ts" })],
    };
    mockFetch([running], { wf_r: detail });
    render(<WorkflowsPage />);
    fireEvent.click(await screen.findByText("still-going"));
    const tool = await screen.findByText(/Edit bar\.ts/);
    expect(tool.className).toContain("text-working");
    expect(tool.textContent).toContain("▸");
  });

  it("does not colour a 'running'/'progress' agent state working-blue when the OWNING run has already settled (regression: agent state must be gated on run liveness, same as last_tool_summary)", async () => {
    const detail: WorkflowRun = {
      ...WF_A_DETAIL,
      state: "orphaned",
      agents: [
        agent({ agent_id: "a1", label: "left-running", state: "running" }),
        agent({ agent_id: "a2", label: "left-in-progress", state: "progress" }),
      ],
    };
    mockFetch([{ ...RUNS[0], state: "orphaned" }, RUNS[1]], { wf_a: detail, wf_b: WF_B_DETAIL });
    render(<WorkflowsPage />);
    fireEvent.click(await screen.findByText("research"));
    await screen.findByText("left-running");
    expect(screen.getByText("running").className).not.toContain("text-working");
    expect(screen.getByText("progress").className).not.toContain("text-working");
  });

  it("keeps a 'running' agent state working-blue while its run is genuinely running (no regression from the settled-run gate above)", async () => {
    const running: WorkflowRunSummary = { ...RUNS[0], run_id: "wf_r", name: "still-going", state: "running", status: "running" };
    const detail: WorkflowRun = {
      ...WF_A_DETAIL,
      run_id: "wf_r",
      state: "running",
      agents: [agent({ agent_id: "a1", label: "busy", state: "running" })],
    };
    mockFetch([running], { wf_r: detail });
    render(<WorkflowsPage />);
    fireEvent.click(await screen.findByText("still-going"));
    await screen.findByText("busy");
    // Two "running" texts legitimately coexist here: the run's own STATUS
    // cell, and this agent's state -- both blue while the run is live.
    const states = screen.getAllByText("running");
    expect(states.length).toBe(2);
    expect(states[1].className).toContain("text-working"); // the agent row, after the status cell in DOM order
  });

  it("colours agent states error/killed distinctly from done/running (ui.md P1-8)", async () => {
    const detail: WorkflowRun = {
      ...WF_A_DETAIL,
      agents: [agent({ agent_id: "a1", label: "broke", state: "error" }), agent({ agent_id: "a2", label: "stopped", state: "killed" })],
    };
    mockFetch(RUNS, { wf_a: detail, wf_b: WF_B_DETAIL });
    render(<WorkflowsPage />);
    fireEvent.click(await screen.findByText("research"));
    await screen.findByText("broke");
    expect(screen.getAllByText("error")[0].className).toContain("text-danger");
    expect(screen.getAllByText("killed")[0].className).toContain("text-danger");
  });

  it("notes a fallback model when the manifest recorded one", async () => {
    const detail: WorkflowRun = {
      ...WF_A_DETAIL,
      agents: [agent({ agent_id: "a1", label: "fell-back", model: "claude-opus-5-5[1m]", fallback_model: "claude-opus-4-8" })],
    };
    mockFetch(RUNS, { wf_a: detail, wf_b: WF_B_DETAIL });
    render(<WorkflowsPage />);
    fireEvent.click(await screen.findByText("research"));
    expect(await screen.findByText("Opus 5.5 · 1M")).toBeTruthy();
    expect(screen.getByText(/Opus 4\.8/)).toBeTruthy();
    expect(screen.getByText(/fallback/i)).toBeTruthy();
  });
});

describe("WorkflowsPage §5.3: Agents column", () => {
  it("shows a plain count when the manifest count matches the actual agent count", async () => {
    mockFetch(RUNS); // wf_a: agent_count 2, agent_counts.total 2
    render(<WorkflowsPage />);
    await screen.findByText("research");
    const rows = screen.getAllByTestId("wf-row");
    expect(within(rows[0]).getByText("2")).toBeTruthy();
  });

  it("shows 'N (M + K retried)' when the actual count exceeds the manifest's declared count", async () => {
    const retried: WorkflowRunSummary = {
      ...RUNS[0], run_id: "wf_retry", name: "retry-run", agent_count: 7,
      agent_counts: { total: 11, done: 7, error: 0, running: 0, abandoned: 0, killed: 4 },
    };
    mockFetch([retried]);
    render(<WorkflowsPage />);
    expect(await screen.findByText("11 (7 + 4 retried)")).toBeTruthy();
  });
});

describe("WorkflowsPage §5.3: live duration", () => {
  it("shows a running row's live duration, ticking as time passes", async () => {
    // Real timers throughout: useNow()'s interval is created (via the REAL
    // setInterval) during the initial render, so switching to fake timers
    // afterward wouldn't affect it -- this waits out one real tick instead.
    const running: WorkflowRunSummary = {
      ...RUNS[0], run_id: "wf_live", name: "live-one", state: "running", status: "running",
      started_at: Date.now() - 5000, duration_ms: null,
    };
    mockFetch([running]);
    render(<WorkflowsPage />);
    expect(await screen.findByText("5s")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 1300));
    await waitFor(() => expect(screen.getByText(/^[67]s$/)).toBeTruthy());
  });
});

describe("WorkflowsPage §5.3: skeleton loading and responsive layout", () => {
  it("shows skeleton placeholder rows (not bare text) while the initial fetch is in flight", () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch; // never resolves
    const { container } = render(<WorkflowsPage />);
    expect(container.querySelector(".am-pulse")).toBeTruthy();
    expect(screen.getByText("Loading…")).toBeTruthy(); // still announced to assistive tech
  });

  it("renders the desktop table by default (matchMedia unavailable in plain jsdom, same convention as useTheme)", async () => {
    mockFetch(RUNS);
    const { container } = render(<WorkflowsPage />);
    await screen.findByText("research");
    expect(container.querySelector("table")).toBeTruthy();
    expect(screen.queryAllByTestId("wf-card").length).toBe(0);
  });

  it("renders stacked cards instead of the table when the md breakpoint doesn't match", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: true, // "(max-width: 767px)" -- below md
      media: q, addEventListener() {}, removeEventListener() {},
    }));
    mockFetch(RUNS);
    const { container } = render(<WorkflowsPage />);
    await screen.findByText("research");
    expect(container.querySelector("table")).toBeNull();
    expect(screen.getAllByTestId("wf-card").length).toBe(2);
    vi.unstubAllGlobals();
  });
});
