import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { CostDailyPage } from "../src/web/components/CostDailyPage.tsx";

const ROWS = [
  { project: "alpha", branch: "main", day: "2026-06-16", costUsd: 2.0, tokens: 100 },
  { project: "beta", branch: null, day: "2026-06-15", costUsd: 9.0, tokens: 900 },
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
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1); // null branch → dash cell
    expect(screen.getByText("$9.00")).toBeTruthy();
    expect(screen.getByText("Jun 16")).toBeTruthy();
  });

  it("sorts by cost descending when the Cost header is clicked", async () => {
    mockFetch(ROWS);
    render(<CostDailyPage />);
    await screen.findByText("alpha");
    fireEvent.click(screen.getByRole("button", { name: /cost/i }));
    const rows = screen.getAllByRole("row"); // [header, ...data]
    expect(within(rows[1]).getByText("$9.00")).toBeTruthy(); // beta (9.0) now first
  });

  it("refetches with the window's since param when the range changes", async () => {
    const fn = mockFetch(ROWS);
    render(<CostDailyPage />);
    await screen.findByText("alpha");
    expect(String(fn.mock.calls[0][0])).toContain("since="); // default 14d
    fireEvent.click(screen.getByRole("button", { name: /^all$/i }));
    expect(String(fn.mock.calls.at(-1)![0])).not.toContain("since="); // all → no bound
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
});
