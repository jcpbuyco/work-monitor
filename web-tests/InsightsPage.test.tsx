import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { InsightsPage } from "../src/web/components/InsightsPage.tsx";
import type { InsightsResponse } from "../src/shared/insights.ts";

function baseResponse(overrides: Partial<InsightsResponse> = {}): InsightsResponse {
  return {
    meta: {
      generatedAt: Date.now(),
      computeMs: 5,
      stale: false,
      tz: "Europe/Berlin",
      firstAt: new Date(2026, 1, 20).getTime(),
      lastAt: Date.now(),
      usageRows: 3,
      unpricedRows: 0,
      unpricedTokens: 0,
    },
    months: ["2026-08", "2026-09"],
    currentMonth: "2026-09",
    kpi: {
      lifetimeUsd: 10800,
      lifetimeTokens: 14_790_000_000,
      inputTokens: 4_000_000,
      outputTokens: 69_900_000,
      cacheReadTokens: 14_000_000_000,
      cacheWriteTokens: 700_000_000,
      messages: 76_842,
      sessions: 259,
      projects: 40,
      activeDays: 93,
      workflowRuns: 213,
      workflowAgents: 1198,
      byHarness: [
        { harness: "claude", costUsd: 10786, tokens: 100 },
        { harness: "codex", costUsd: 14, tokens: 10 },
      ],
      mtdUsd: 4957,
      prevMonthUsd: 2982,
      prevMonthSamePointUsd: 2287,
      trailing7dUsd: 1575.7,
      projectedMonthEndUsd: 6050,
      cacheHitRate: 0.975,
      cacheSavingsUsdEst: 72000,
    },
    records: {
      biggestDay: { day: "2026-09-25", costUsd: 590, messages: 9108 },
      longestStreak: { from: "2026-08-30", to: "2026-09-19", days: 21 },
      currentStreakDays: 5,
      peakAgents: { at: Date.now(), agents: 79, runId: "wf_1", runName: "review-treatment-plan-spa" },
      priciestRun: { runId: "wf_1", name: "review-treatment-plan-spa", costUsd: 116.82, agentCount: 144, startedAt: Date.now() },
      longestSession: { sessionId: "s1", project: "lunatic", activeMs: 29 * 3_600_000, wallMs: 59.4 * 3_600_000, startedAt: Date.now() },
    },
    byMonthModel: [
      { month: "2026-08", model: "claude-sonnet-5", family: "Sonnet", costUsd: 640, tokens: 1000, outputTokens: 100, unpricedTokens: 0 },
      { month: "2026-09", model: "claude-sonnet-5", family: "Sonnet", costUsd: 572, tokens: 900, outputTokens: 90, unpricedTokens: 0 },
      { month: "2026-09", model: "claude-fable-5-1", family: "Fable", costUsd: 2042, tokens: 2000, outputTokens: 200, unpricedTokens: 0 },
    ],
    byMonthTokenClass: [
      { month: "2026-08", inputUsd: 5, outputUsd: 365, cacheReadUsd: 1945, cacheWriteUsd: 671, inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWrite5mTokens: 4, cacheWrite1hTokens: 5, unpricedTokens: 0 },
      { month: "2026-09", inputUsd: 3, outputUsd: 980, cacheReadUsd: 2131, cacheWriteUsd: 1843, inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWrite5mTokens: 4, cacheWrite1hTokens: 5, unpricedTokens: 0 },
    ],
    byMonthKind: [
      { month: "2026-08", kind: "main", costUsd: 1745, outputTokens: 10 },
      { month: "2026-08", kind: "subagent", costUsd: 475, outputTokens: 10 },
      { month: "2026-08", kind: "workflow", costUsd: 761, outputTokens: 10 },
      { month: "2026-09", kind: "main", costUsd: 2274, outputTokens: 10 },
      { month: "2026-09", kind: "subagent", costUsd: 317, outputTokens: 10 },
      { month: "2026-09", kind: "workflow", costUsd: 2366, outputTokens: 10 },
    ],
    days: [
      { day: "2026-09-25", costUsd: 590, messages: 9108, sessions: 2, topProject: "agent-monitor", peakAgents: 79 },
      { day: "2026-09-24", costUsd: 200, messages: 500, sessions: 1, topProject: "agent-monitor", peakAgents: 3 },
    ],
    weekHour: Array.from({ length: 7 * 24 }, (_, i) => ({ weekday: Math.floor(i / 24), hour: i % 24, activeDays: 0, costUsd: 0 })),
    weekdayCounts: [30, 30, 30, 30, 30, 30, 30],
    activity: [
      { month: "2026-08", activeMs: 80 * 3_600_000 },
      { month: "2026-09", activeMs: 150 * 3_600_000 },
    ],
    workflowRuns: [
      { runId: "wf_1", name: "review-treatment-plan-spa", status: "done", startedAt: Date.now(), month: "2026-09", agentCount: 144, durationMs: 3_600_000, costUsd: 116.82, outputTokens: 1000 },
    ],
    models: [
      { model: "claude-sonnet-5", family: "Sonnet", costUsd: 1212, outputTokens: 2_000_000, cacheUsd: 500, listOutputRate: 10, costUsd30d: 500, outputTokens30d: 1_000_000 },
    ],
    projects: [
      { project: "agent-monitor", kind: "project", lifetimeUsd: 495, sessions: 5, activeDays: 10, byMonth: { "2026-09": { costUsd: 495, sessions: 5 } } },
    ],
    ...overrides,
  };
}

const readyState = {
  sessions: [], todos: [], activity: [], stats: [],
  cost: { perSession: {}, liveTotalUsd: 0, todayUsd: 0, byModelToday: [], byProject: [], byBranch: [] },
};

let fetchImpl: () => Promise<Response>;

beforeEach(() => {
  global.fetch = vi.fn(() => fetchImpl()) as unknown as typeof fetch;
  fetchImpl = () => Promise.resolve({ ok: true, json: async () => baseResponse() } as Response);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("InsightsPage", () => {
  it("renders the lifetime hero value from the fetched data", async () => {
    render(<InsightsPage state={readyState} />);
    expect(await screen.findByText("$10,800")).toBeTruthy();
  });

  it("shows the empty-database state when usageRows is 0", async () => {
    fetchImpl = () => Promise.resolve({ ok: true, json: async () => baseResponse({ meta: { ...baseResponse().meta, usageRows: 0 } }) } as Response);
    render(<InsightsPage state={readyState} />);
    expect(await screen.findByText(/No usage recorded yet/)).toBeTruthy();
  });

  it("shows an error state with a Retry button on a failed fetch, and recovers on retry", async () => {
    let calls = 0;
    fetchImpl = () => {
      calls++;
      return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve({ ok: true, json: async () => baseResponse() } as Response);
    };
    render(<InsightsPage state={readyState} />);
    expect(await screen.findByText("Couldn't load insights.")).toBeTruthy();
    fireEvent.click(screen.getByText("Retry"));
    expect(await screen.findByText("$10,800")).toBeTruthy();
  });

  it("each card's Table toggle renders a table containing a known value", async () => {
    render(<InsightsPage state={readyState} />);
    await screen.findByText("$10,800");
    const tableToggles = screen.getAllByText("Table");
    // Monthly spend by model's Table button -- flip it and look for a
    // known figure from the fixture (September's Sonnet spend).
    fireEvent.click(tableToggles[0]);
    const tables = screen.getAllByRole("table");
    expect(tables.length).toBeGreaterThan(0);
    expect(within(tables[0]).getByText("$572.00")).toBeTruthy();
  });

  it("Tokens view's table shows token counts, never a dollar figure (regression: the Y axis read \"$10000M\" and the table printed \"$33704423.00\" for a token count)", async () => {
    render(<InsightsPage state={readyState} />);
    await screen.findByText("$10,800");
    fireEvent.click(screen.getByText("Tokens")); // MonthlyByModel's metric Segmented -- unique label on the page
    const tableToggles = screen.getAllByText("Table");
    fireEvent.click(tableToggles[0]); // still the first card, MonthlyByModel
    const tables = screen.getAllByRole("table");
    // September's Fable tokens (2000, from the fixture) render as "2K" --
    // never re-formatted through the dollar formatter.
    expect(within(tables[0]).getByText("2K")).toBeTruthy();
    expect(within(tables[0]).queryByText(/^\$/)).toBeNull();
  });

  it("legend isolate dims the other entries, and a second click restores everyone (regression: a second click used to leave every entry dimmed)", async () => {
    render(<InsightsPage state={readyState} />);
    await screen.findByText("$10,800");
    const asButton = (label: string) =>
      screen
        .getAllByText(label)
        .map((el) => el.closest("button"))
        .find((b): b is HTMLButtonElement => !!b)!;
    const legendButton = asButton("Fable");
    const otherButton = asButton("Opus");

    fireEvent.click(legendButton);
    expect(legendButton.getAttribute("aria-pressed")).toBe("true");
    expect(legendButton.style.opacity).toBe("1");
    expect(otherButton.style.opacity).toBe("0.4"); // dimmed, not repainted -- no fill/color change asserted, per §5 "colors never change"

    fireEvent.click(legendButton); // second click: un-isolate
    expect(legendButton.getAttribute("aria-pressed")).toBe("false");
    expect(legendButton.style.opacity).toBe("1");
    expect(otherButton.style.opacity).toBe("1");
  });

  it('shows the "$x+" partial-unpriced convention on the hero when some usage is unpriced', async () => {
    fetchImpl = () =>
      Promise.resolve({
        ok: true,
        json: async () => baseResponse({ meta: { ...baseResponse().meta, unpricedTokens: 500 } }),
      } as Response);
    render(<InsightsPage state={readyState} />);
    expect(await screen.findByText("$10,800+")).toBeTruthy();
  });

  it("keeps the previous render visible (no skeleton), dimmed to 60% opacity, while a background refetch is pending", async () => {
    const { container } = render(<InsightsPage state={readyState} />);
    await screen.findByText("$10,800");
    let resolveSecond: (r: Response) => void;
    fetchImpl = () => new Promise((resolve) => { resolveSecond = resolve; });
    fireEvent.click(screen.getByText("Refresh"));
    // The old figure is still on screen while the refetch is in flight.
    expect(screen.getByText("$10,800")).toBeTruthy();
    expect(screen.queryByText("Loading insights…")).toBeNull();
    // Regression: `refetching` used to be computed by reading a ref at
    // render time, which a ref mutation alone never triggers -- so this
    // dim-while-refetching effect the spec asks for never actually happened.
    const bodies = [...container.querySelectorAll<HTMLElement>('[data-testid="chart-card-body"]')];
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) expect(b.style.opacity).toBe("0.6");
    await act(async () => {
      resolveSecond!({ ok: true, json: async () => baseResponse() } as Response);
      await Promise.resolve();
    });
    for (const b of bodies) expect(b.style.opacity).toBe("1");
  });

  it("never applies display:grid below its own lg breakpoint (regression: an unconstrained implicit grid track let a chart's fixed-width fallback SVG stretch the whole page wider than a 390px viewport)", async () => {
    const { container } = render(<InsightsPage state={readyState} />);
    await screen.findByText("$10,800");
    // Every two/three-column row must gate `grid` itself behind `lg:` (as
    // Board.tsx's own two-column layout does) rather than applying `grid`
    // unconditionally with only the COLUMN COUNT gated -- the latter has no
    // base `grid-template-columns` below `lg`, so a plain implicit column
    // sizes to its content's max-content instead of the viewport (jsdom does
    // no real layout, so this is asserted structurally: every element using
    // `lg:grid-cols-` also carries a bare, un-prefixed `grid` class only
    // together with `lg:grid`, never alone).
    const offenders = [...container.querySelectorAll('[class*="lg:grid-cols-"]')].filter((el) => {
      const cls = el.className.split(/\s+/);
      return cls.includes("grid") && !cls.includes("lg:grid");
    });
    expect(offenders).toEqual([]);
  });
});
