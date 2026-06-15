import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolStats } from "../src/web/components/ToolStats.tsx";
import type { ToolStat } from "../src/web/types.ts";

const stats: ToolStat[] = [
  { tool: "Bash", calls: 492, totalMs: 128000, avgMs: 260 },
  { tool: "mcp__plugin_x__navigate_page", calls: 19, totalMs: 3600, avgMs: 188 },
];

beforeEach(() => localStorage.clear());

describe("ToolStats", () => {
  it("shows per-tool calls with the total in the header", () => {
    render(<ToolStats stats={stats} />);
    expect(screen.getByText(/Tool usage \(511\)/)).toBeDefined(); // 492 + 19
    expect(screen.getByText("Bash")).toBeDefined();
    expect(screen.getByText("492")).toBeDefined();
    expect(screen.getByText("navigate_page")).toBeDefined(); // mcp prefix shortened
  });

  it("collapses to just the header", () => {
    render(<ToolStats stats={stats} />);
    fireEvent.click(screen.getByRole("button", { name: /Tool usage/ }));
    expect(screen.queryByText("Bash")).toBeNull();
  });

  it("renders nothing when there is no usage yet", () => {
    const { container } = render(<ToolStats stats={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
