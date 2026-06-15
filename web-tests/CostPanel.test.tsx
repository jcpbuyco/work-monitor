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
};

describe("CostPanel", () => {
  it("renders live total, today, and per-model rows", () => {
    render(<CostPanel cost={cost} />);
    expect(screen.getByText("live total")).toBeTruthy();
    expect(screen.getByText("$3.71")).toBeTruthy();
    expect(screen.getByText("today")).toBeTruthy();
    expect(screen.getByText("$12.40")).toBeTruthy();
    expect(screen.getByText("Opus 4.8")).toBeTruthy();
    expect(screen.getByText("$10.90")).toBeTruthy();
  });

  it("renders nothing when there is no cost yet", () => {
    const { container } = render(
      <CostPanel cost={{ perSession: {}, liveTotalUsd: 0, todayUsd: 0, byModelToday: [] }} />
    );
    expect(container.firstChild).toBeNull();
  });
});
