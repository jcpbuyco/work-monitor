import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within, waitFor } from "@testing-library/react";
import { CostDailyPage } from "../src/web/components/CostDailyPage.tsx";

const ROWS = [
  { project: "alpha", branch: "main", day: "2026-06-16", costUsd: 2.0, tokens: 100, harness: "claude" },
  { project: "beta", branch: null, day: "2026-06-15", costUsd: 9.0, tokens: 900, harness: "claude" },
];

function mockFetch(rows: unknown) {
  const fn = vi.fn().mockResolvedValue({ json: async () => ({ rows }) });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

afterEach(cleanup);
beforeEach(() => vi.restoreAllMocks());

describe("CostDailyPage", () => {
  it("fetches and renders rows with formatted cost, day and tokens", async () => {
    mockFetch(ROWS);
    render(<CostDailyPage />);
    expect(await screen.findByText("alpha")).toBeTruthy();
    expect(screen.getByText("beta")).toBeTruthy();
    expect(screen.getAllByText("-").length).toBeGreaterThanOrEqual(1); // null branch → dash cell
    // "$9.00" also appears in beta's lone-row day subtotal (§5.3) -- both are
    // legitimate matches, not a duplication bug.
    expect(screen.getAllByText("$9.00").length).toBe(2);
    expect(screen.getByText("Jun 16")).toBeTruthy();
  });

  it("sorts by cost descending WITHIN a day group when the Cost header is clicked (§5.3 day grouping)", async () => {
    // Day-grouping is now a fixed structural feature of the page: a column
    // sort only reorders rows WITHIN a day, while days themselves stay
    // newest-first. Both rows here share a day so the sort is observable.
    const sameDay = [
      { project: "alpha", branch: "main", day: "2026-06-16", costUsd: 2.0, tokens: 100, harness: "claude" },
      { project: "beta", branch: null, day: "2026-06-16", costUsd: 9.0, tokens: 900, harness: "claude" },
    ];
    mockFetch(sameDay);
    render(<CostDailyPage />);
    await screen.findByText("alpha");
    fireEvent.click(screen.getByRole("button", { name: /^cost$/i }));
    const rows = screen.getAllByTestId("cost-row"); // data rows only, no header
    expect(within(rows[0]).getByText("$9.00")).toBeTruthy(); // beta (9.0) now first
  });

  it("refetches with the window's since param when the range changes", async () => {
    const fn = mockFetch(ROWS);
    render(<CostDailyPage />);
    await screen.findByText("alpha");
    expect(String(fn.mock.calls[0][0])).toContain("since="); // default 14d
    fireEvent.click(screen.getByRole("button", { name: /^all$/i }));
    await waitFor(() => expect(String(fn.mock.calls.at(-1)![0])).not.toContain("since=")); // all → no bound
  });

  it("renders a null (unpriced) cost row as text, instead of crashing the page (§2.3, finding)", async () => {
    mockFetch([{ project: "gamma", branch: null, day: "2026-06-14", costUsd: null, tokens: 50, harness: "claude" }]);
    render(<CostDailyPage />);
    expect(await screen.findByText("gamma")).toBeTruthy();
    // Both the row's own cost AND its (lone-row) day subtotal read "unpriced".
    expect(screen.getAllByText("unpriced").length).toBe(2);
  });

  it("shows an empty state when there is no usage", async () => {
    mockFetch([]);
    render(<CostDailyPage />);
    expect(await screen.findByText(/no usage/i)).toBeTruthy();
  });

  it("shows an error state when the fetch fails", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("boom")) as unknown as typeof fetch;
    render(<CostDailyPage />);
    expect(await screen.findByText(/couldn.t load/i)).toBeTruthy();
  });

  it("exposes exactly one button whose name matches /cost/i - the column header", async () => {
    mockFetch(ROWS);
    render(<CostDailyPage />);
    await screen.findByText("alpha");
    expect(screen.getAllByRole("button", { name: /cost/i }).length).toBe(1);
    // §5.2: the shared AppBar replaces the old standalone "← Dashboard" link -
    // its home (logo) link is the way back now.
    expect(screen.getByText("agent-monitor").closest("a")!.getAttribute("href")).toBe("#/");
    expect(screen.getByText("Cost by day").tagName).toBe("SPAN");
  });

  it("renders the AppBar, with the Cost nav link marked current (§5.2)", async () => {
    mockFetch(ROWS);
    render(<CostDailyPage />);
    expect(screen.getByText("Cost").closest("a")!.getAttribute("aria-current")).toBe("page");
  });

  it("announces the loading state to assistive tech", () => {
    mockFetch(ROWS);
    render(<CostDailyPage />);
    const loading = screen.getByText("Loading…");
    expect(loading.getAttribute("role")).toBe("status");
    expect(loading.getAttribute("aria-live")).toBe("polite");
  });

  it("shows the shared reconnecting bar when disconnected, same as the board (§5.2 finding fix)", () => {
    // The banner used to live on Board alone, so this page - sharing the
    // exact same App-level SSE subscription - looked falsely healthy while
    // the stream was actually stale.
    mockFetch(ROWS);
    render(<CostDailyPage connected={false} lastMessageAt={Date.now() - 120_000} />);
    expect(screen.getByTestId("reconnecting-bar").textContent).toContain("Reconnecting");
  });
});

describe("CostDailyPage §5.3: day grouping and subtotals", () => {
  it("groups rows under a day header, newest day first by default", async () => {
    mockFetch(ROWS);
    render(<CostDailyPage />);
    await screen.findByText("alpha");
    expect(screen.getByText("Jun 16")).toBeTruthy();
    expect(screen.getByText("Jun 15")).toBeTruthy();
    const rows = screen.getAllByTestId("cost-row");
    expect(within(rows[0]).getByText("alpha")).toBeTruthy(); // Jun 16's row comes first
  });

  it("shows a per-day subtotal row summing that day's cost and tokens", async () => {
    const sameDay = [
      { project: "alpha", branch: "main", day: "2026-06-16", costUsd: 2.0, tokens: 100, harness: "claude" },
      { project: "beta", branch: null, day: "2026-06-16", costUsd: 9.0, tokens: 900, harness: "claude" },
    ];
    mockFetch(sameDay);
    render(<CostDailyPage />);
    await screen.findByText("alpha");
    const subtotal = screen.getByTestId("cost-subtotal");
    expect(within(subtotal).getByText("$11.00")).toBeTruthy();
    expect(within(subtotal).getByText("1K")).toBeTruthy(); // 1000 tokens
  });

  it("a day subtotal skips unpriced rows in the sum rather than treating them as $0", async () => {
    const sameDay = [
      { project: "alpha", branch: "main", day: "2026-06-16", costUsd: 2.0, tokens: 100, harness: "claude" },
      { project: "unpriced-model", branch: null, day: "2026-06-16", costUsd: null, tokens: 40, harness: "claude" },
    ];
    mockFetch(sameDay);
    render(<CostDailyPage />);
    await screen.findByText("alpha");
    const subtotal = screen.getByTestId("cost-subtotal");
    expect(within(subtotal).getByText("$2.00")).toBeTruthy(); // NOT $0.00 + $2.00 confused, and not "unpriced"
  });

  it("shows the window total in the header, summing every loaded row", async () => {
    mockFetch(ROWS); // 2.0 + 9.0
    render(<CostDailyPage />);
    expect(await screen.findByText("$11.00 total")).toBeTruthy();
  });

  it("marks a row that mixes priced and unpriced usage with '+' rather than a plain dollar figure that understates spend (regression, ui.md P0-1)", async () => {
    mockFetch([
      { project: "alpha", branch: "main", day: "2026-06-16", costUsd: 2.0, tokens: 100, unpricedTokens: 40, harness: "claude" },
    ]);
    render(<CostDailyPage />);
    await screen.findByText("alpha");
    // The row itself and its (lone-row) day subtotal both carry the marker;
    // the window total (in the sticky header) renders as one combined text
    // node ("$2.00+ total") so it's checked separately below.
    expect(screen.getAllByText("$2.00+").length).toBe(2);
    const row = screen.getByTestId("cost-row");
    expect(within(row).getByText("$2.00+").title).toBe("some usage from unpriced models");
    expect(await screen.findByText("$2.00+ total")).toBeTruthy();
  });

  it("does not mark a fully-priced row with '+' (no false positive)", async () => {
    mockFetch([{ project: "alpha", branch: "main", day: "2026-06-16", costUsd: 2.0, tokens: 100, harness: "claude" }]);
    render(<CostDailyPage />);
    await screen.findByText("alpha");
    expect(screen.queryByText(/\$2\.00\+/)).toBeNull();
    expect(screen.getAllByText("$2.00").length).toBe(2); // row + subtotal
    expect(await screen.findByText("$2.00 total")).toBeTruthy();
  });
});

describe("CostDailyPage §5.3: harness column and filter", () => {
  it("renders a harness mark per row", async () => {
    mockFetch([
      { project: "alpha", branch: "main", day: "2026-06-16", costUsd: 2.0, tokens: 100, harness: "claude" },
      { project: "beta", branch: null, day: "2026-06-16", costUsd: 1.0, tokens: 10, harness: "codex" },
    ]);
    const { container } = render(<CostDailyPage />);
    await screen.findByText("alpha");
    expect(container.querySelector('[data-harness="claude"]')).toBeTruthy();
    expect(container.querySelector('[data-harness="codex"]')).toBeTruthy();
  });

  it("treats a row with no harness field as claude (restart-skew gotcha, pre-B1 rows)", async () => {
    mockFetch([{ project: "alpha", branch: "main", day: "2026-06-16", costUsd: 2.0, tokens: 100 }]);
    const { container } = render(<CostDailyPage />);
    await screen.findByText("alpha");
    expect(container.querySelector('[data-harness="claude"]')).toBeTruthy();
  });

  it("filters via the server's ?harness= param when a harness is picked", async () => {
    const fn = mockFetch(ROWS);
    render(<CostDailyPage />);
    await screen.findByText("alpha");
    fireEvent.change(screen.getByLabelText(/filter by harness/i), { target: { value: "codex" } });
    await waitFor(() => expect(String(fn.mock.calls.at(-1)![0])).toContain("harness=codex"));
  });

  it("renders both harnesses' rows for the same project/branch/day as two phone cards, not one collapsed by a key collision (regression: mobile key must include harness, matching the desktop key)", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: true, // below md
      media: q, addEventListener() {}, removeEventListener() {},
    }));
    mockFetch([
      { project: "agent-monitor", branch: "main", day: "2026-06-16", costUsd: 164.22, tokens: 100, harness: "claude" },
      { project: "agent-monitor", branch: "main", day: "2026-06-16", costUsd: 1.94, tokens: 10, harness: "codex" },
    ]);
    render(<CostDailyPage />);
    await screen.findByText("$164.22");
    expect(screen.getAllByTestId("cost-row").length).toBe(2);
    expect(screen.getByText("$1.94")).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

describe("CostDailyPage §5.3: skeleton loading and responsive layout", () => {
  it("shows skeleton placeholder rows (not bare text) while the initial fetch is in flight", () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch; // never resolves
    const { container } = render(<CostDailyPage />);
    expect(container.querySelector(".am-pulse")).toBeTruthy();
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("renders the desktop table by default (matchMedia unavailable in plain jsdom)", async () => {
    mockFetch(ROWS);
    const { container } = render(<CostDailyPage />);
    await screen.findByText("alpha");
    expect(container.querySelector("table")).toBeTruthy();
  });

  it("renders stacked cards instead of the table when the md breakpoint doesn't match", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: true, // "(max-width: 767px)" -- below md
      media: q, addEventListener() {}, removeEventListener() {},
    }));
    mockFetch(ROWS);
    const { container } = render(<CostDailyPage />);
    await screen.findByText("alpha");
    expect(container.querySelector("table")).toBeNull();
    expect(screen.getAllByTestId("cost-row").length).toBe(2);
    vi.unstubAllGlobals();
  });
});
