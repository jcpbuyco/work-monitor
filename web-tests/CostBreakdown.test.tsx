import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CostBreakdown } from "../src/web/components/CostBreakdown.tsx";
import type { Cost } from "../src/web/types.ts";

afterEach(cleanup);

const base = { perSession: {}, liveTotalUsd: 0, todayUsd: 0, byModelToday: [] };

const cost: Cost = {
  ...base,
  byProject: [
    { project: "alpha", costUsd: 12.5, tokens: 1_200_000 },
    { project: "beta", costUsd: 3.4, tokens: 400_000 },
  ],
  byBranch: [
    { project: "alpha", branch: "main", costUsd: 8.0, tokens: 900_000 },
    { project: "beta", branch: null, costUsd: 3.4, tokens: 400_000 },
  ],
};

describe("CostBreakdown", () => {
  it("renders project rows with cost and tokens", () => {
    render(<CostBreakdown cost={cost} />);
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByText("$12.50")).toBeTruthy();
    expect(screen.getByText("1.2M")).toBeTruthy();
  });

  it("labels branch rows as 'project · branch', with a dash for no branch", () => {
    render(<CostBreakdown cost={cost} />);
    expect(screen.getByText("alpha · main")).toBeTruthy();
    expect(screen.getByText("beta · —")).toBeTruthy();
  });

  it("renders nothing when there is no usage yet", () => {
    const { container } = render(<CostBreakdown cost={{ ...base, byProject: [], byBranch: [] }} />);
    expect(container.firstChild).toBeNull();
  });
});
