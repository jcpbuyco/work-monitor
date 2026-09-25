import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CostPanel } from "../src/web/components/CostPanel.tsx";
import type { Cost } from "../src/web/types.ts";

afterEach(cleanup);

const cost: Cost = {
  perSession: {},
  liveTotalUsd: 3.71,
  todayUsd: 12.4,
  byModelToday: [
    { model: "claude-opus-4-8", costUsd: 10.9 },
    { model: "claude-haiku-4-5", costUsd: 1.5 },
  ],
  byProject: [],
  byBranch: [],
};

describe("CostPanel", () => {
  it("renders open sessions, today (local), and per-model rows (§5.2 relabels)", () => {
    render(<CostPanel cost={cost} />);
    expect(screen.getByText("open sessions")).toBeTruthy();
    expect(screen.getByText("$3.71")).toBeTruthy();
    expect(screen.getByText("today (local)")).toBeTruthy();
    expect(screen.getByText("$12.40")).toBeTruthy();
    expect(screen.getByText("Opus 4.8")).toBeTruthy();
    expect(screen.getByText("$10.90")).toBeTruthy();
  });

  it("relabels API-equiv as ≈ API list price, on screen rather than tooltip-only", () => {
    render(<CostPanel cost={cost} />);
    expect(screen.getByText("≈ API list price")).toBeTruthy();
  });

  it("lists all-time unpriced models with a token count, distinct from today's per-model rows", () => {
    render(<CostPanel cost={{ ...cost, unpricedModels: [{ model: "gpt-5.5", tokens: 12_300_000 }] }} />);
    expect(screen.getByText("GPT-5.5 · unpriced · all-time · 12.3M tok")).toBeTruthy();
  });

  it("does not duplicate a model that is unpriced both today and all-time (finding fix)", () => {
    render(
      <CostPanel
        cost={{
          ...cost,
          byModelToday: [...cost.byModelToday, { model: "mystery-model-9", costUsd: null }],
          unpricedModels: [{ model: "mystery-model-9", tokens: 503_000 }],
        }}
      />
    );
    // today's row still reads "unpriced" (never a fabricated $0.00) -
    // the all-time row for the SAME model is dropped, not shown a second time.
    expect(screen.getAllByText(/unpriced/).length).toBe(1);
    expect(screen.queryByText(/all-time/)).toBeNull();
  });

  it("renders nothing when there is no cost yet", () => {
    const { container } = render(
      <CostPanel cost={{ perSession: {}, liveTotalUsd: 0, todayUsd: 0, byModelToday: [], byProject: [], byBranch: [] }} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("reads as a 2-up grid with today primary and live total one step back", () => {
    render(<CostPanel cost={cost} />);
    expect(screen.getByTestId("cost-today").textContent).toBe("$12.40");
    expect(screen.getByTestId("cost-live-total").textContent).toBe("$3.71");
    expect(screen.getByTestId("cost-today").className).toContain("text-ink");
    expect(screen.getByTestId("cost-live-total").className).toContain("text-ink-3");
  });

  it("renders a null today/model cost as text, instead of crashing the dashboard (§2.3, finding)", () => {
    render(
      <CostPanel
        cost={{
          perSession: {},
          liveTotalUsd: 3.71,
          todayUsd: null,
          byModelToday: [{ model: "totally-unknown-model", costUsd: null }],
          byProject: [],
          byBranch: [],
        }}
      />
    );
    expect(screen.getByTestId("cost-today").textContent).toBe("unpriced");
    expect(screen.getAllByText("unpriced").length).toBe(2); // the today tile AND the per-model row
  });

  it("still renders nothing when both today and live total are genuinely nothing (null today, zero live)", () => {
    const { container } = render(
      <CostPanel cost={{ perSession: {}, liveTotalUsd: 0, todayUsd: null, byModelToday: [], byProject: [], byBranch: [] }} />
    );
    expect(container.firstChild).toBeNull();
  });
});
