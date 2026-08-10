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

describe("SessionCard workflow badge", () => {
  afterEach(cleanup);

  it("shows a wf badge when the session owns a live run", () => {
    render(<SessionCard s={base} wf />);
    expect(screen.getByTitle("owns a live workflow run")).toBeTruthy();
  });

  it("omits the badge by default", () => {
    render(<SessionCard s={base} />);
    expect(screen.queryByTitle("owns a live workflow run")).toBeNull();
  });
});

describe("SessionCard row", () => {
  afterEach(cleanup);

  it("keeps status in the accessibility tree after the visible label is removed", () => {
    // The coloured uppercase status line is gone — the glyph is aria-hidden, so
    // an sr-only label is the only thing carrying status to a screen reader.
    const { container } = render(<SessionCard s={{ ...base, status: "needs_you", attention_reason: "why?" }} />);
    expect(screen.getByText("Needs you").className).toContain("sr-only");
    expect(container.querySelector('[data-glyph="needs_you"]')).toBeTruthy();
  });

  it("tints the whole needs-you row instead of drawing a callout box", () => {
    render(<SessionCard s={{ ...base, status: "needs_you", attention_reason: "why?" }} />);
    const row = screen.getByTestId("session-row");
    expect(row.getAttribute("data-status")).toBe("needs_you");
    expect(row.className).toContain("bg-attention/[0.05]");
    expect(row.className).not.toContain("hover:bg-surface-2"); // tone replaces, never appends
  });

  it("draws an idle row as one compact line — no tool line, no shimmer, no branch", () => {
    const { container } = render(
      <SessionCard s={{ ...base, status: "idle", branch: "feat/x" }} latestTool="Read" cost={{ costUsd: 0.02, tokens: 100 }} />
    );
    expect(container.querySelector(".am-shimmer")).toBeNull();
    expect(screen.queryByText(/Read/)).toBeNull();
    expect(screen.queryByText(/⎇/)).toBeNull();
    expect(screen.getByText("$0.02")).toBeTruthy(); // cost only, no "· … tok" suffix
    expect(container.textContent).not.toContain("tok");
  });

  it("shimmers only while working", () => {
    const { container, rerender } = render(<SessionCard s={base} />); // working
    expect(container.querySelector(".am-shimmer")).toBeTruthy();
    rerender(<SessionCard s={{ ...base, status: "needs_you" }} />);
    expect(container.querySelector(".am-shimmer")).toBeNull();
  });
});
