import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActivityFeed } from "../src/web/components/ActivityFeed.tsx";
import type { Activity, Session } from "../src/web/types.ts";

const session = (id: string, project: string): Session => ({
  id, project, status: "working", current_task: null, current_intent: null,
  attention_reason: null, active_tool: null, branch: null, started_at: 0, last_activity_at: 0,
});

const act = (id: number, session_id: string, tool: string, detail: string | null = null): Activity => ({
  id, session_id, tool, detail, at: Date.now(),
});

describe("ActivityFeed", () => {
  it("lists tool calls with their session's project", () => {
    render(
      <ActivityFeed
        activity={[act(2, "s1", "Bash"), act(1, "s1", "Read")]}
        sessions={[session("s1", "oxygenrx")]}
      />
    );
    expect(screen.getByText("Bash")).toBeDefined();
    expect(screen.getByText("Read")).toBeDefined();
    expect(screen.getAllByText("oxygenrx").length).toBe(2);
  });

  it("shows the per-call detail line", () => {
    render(
      <ActivityFeed
        activity={[act(1, "s1", "Edit", "Board.tsx")]}
        sessions={[session("s1", "p")]}
      />
    );
    expect(screen.getByText("Board.tsx")).toBeDefined();
  });

  it("shortens verbose mcp tool names", () => {
    render(
      <ActivityFeed
        activity={[act(1, "s1", "mcp__plugin_chrome-devtools-mcp_chrome-devtools__navigate_page")]}
        sessions={[session("s1", "p")]}
      />
    );
    expect(screen.getByText("navigate_page")).toBeDefined();
  });

  it("shows an empty state when there is no activity", () => {
    render(<ActivityFeed activity={[]} sessions={[]} />);
    expect(screen.getByText("Waiting for tool activity…")).toBeDefined();
  });
});
