import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SessionCard } from "../src/web/components/SessionCard.tsx";
import type { Session } from "../src/web/types.ts";

const base: Session = {
  id: "s1", project: "myrepo", status: "working", current_task: null,
  current_intent: null, attention_reason: null, active_tool: null, branch: null,
  started_at: 0, last_activity_at: Date.now(),
};

describe("SessionCard", () => {
  it("shows the branch when present", () => {
    render(<SessionCard s={{ ...base, branch: "feat/x" }} />);
    expect(screen.getByText("⎇ feat/x")).toBeDefined();
  });
  it("omits the branch when null", () => {
    render(<SessionCard s={base} />);
    expect(screen.queryByText(/⎇/)).toBeNull();
  });
  it("shows the active tool (with spinner) while a tool is running", () => {
    render(<SessionCard s={{ ...base, active_tool: "Bash" }} />);
    expect(screen.getByText("Bash…")).toBeDefined();
  });
  it("falls back to the last completed tool when no tool is active", () => {
    render(<SessionCard s={base} latestTool="Read" latestDetail="db.ts" />);
    expect(screen.getByText(/Read/)).toBeDefined();
  });
});

describe("SessionCard cost line", () => {
  afterEach(cleanup);

  it("shows cost + tokens when provided", () => {
    render(<SessionCard s={base} cost={{ costUsd: 1.24, tokens: 312_000 }} />);
    expect(screen.getByText("$1.24 · 312K tok")).toBeTruthy();
  });

  it("omits the cost line when no cost is provided", () => {
    const { container } = render(<SessionCard s={base} />);
    expect(container.textContent).not.toContain("tok");
  });
});
