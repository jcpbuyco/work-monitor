import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ActivityFeed } from "../src/web/components/ActivityFeed.tsx";
import type { Activity, Session } from "../src/web/types.ts";

const session = (id: string, project: string): Session => ({
  id, project, status: "working", current_task: null, current_intent: null,
  attention_reason: null, active_tool: null, branch: null, idle_reason: null, started_at: 0, last_activity_at: 0,
});

const act = (
  id: number, session_id: string, tool: string, detail: string | null = null, dur: number | null = null
): Activity => ({ id, session_id, tool, detail, dur, at: Date.now() });

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

  it("shows a formatted call duration", () => {
    render(<ActivityFeed activity={[act(1, "s1", "Bash", null, 1234)]} sessions={[session("s1", "p")]} />);
    expect(screen.getByText("1.2s")).toBeDefined();
  });

  it("shows an empty state when there is no activity", () => {
    render(<ActivityFeed activity={[]} sessions={[]} />);
    expect(screen.getByText("Waiting for tool activity…")).toBeDefined();
  });

  it("draws rows as lines, not cards", () => {
    const { container } = render(
      <ActivityFeed activity={[act(1, "s1", "Bash", "git status", 1234)]} sessions={[session("s1", "p")]} />
    );
    const li = container.querySelector("li")!;
    expect(li.className).not.toContain("border");
    expect(li.className).not.toContain("shadow-card");
    expect(li.className).toContain("am-row-in");
    // the stagger is capped so a 100-row feed does not cascade for 3 seconds
    expect(li.style.animationDelay).toBe("0ms");
  });
});

describe("ActivityFeed §5.2: harness mark, session label, agent label", () => {
  it("shows the session_label and agent label instead of the bare project when present", () => {
    render(
      <ActivityFeed
        activity={[{ id: 1, session_id: "s1", tool: "Bash", detail: null, dur: null, at: Date.now(), harness: "codex", session_label: "browns - fix the login bug", label: "research:codex" }]}
        sessions={[session("s1", "browns")]}
      />
    );
    expect(screen.getByText("browns - fix the login bug")).toBeDefined();
    expect(screen.getByText("· research:codex")).toBeDefined();
    expect(document.querySelector('[data-harness="codex"]')).toBeTruthy();
  });

  it("keeps the agent label fully visible even behind a session label near its max length (finding fix)", () => {
    // §4.1's session_label is `project - intent`, intent truncated up to 60
    // chars server-side - long enough that the OLD single truncating span
    // ate the whole budget and the agent label (the one thing telling
    // sibling workflow-agent rows apart) never rendered at all.
    const longLabel = "a-very-long-project-name - " + "x".repeat(60);
    render(
      <ActivityFeed
        activity={[{ id: 1, session_id: "s1", tool: "Bash", detail: null, dur: null, at: Date.now(), session_label: longLabel, label: "impl:T3" }]}
        sessions={[session("s1", "a-very-long-project-name")]}
      />
    );
    const agentLabel = screen.getByText("· impl:T3");
    expect(agentLabel.className).toContain("shrink-0");
    expect(agentLabel.className).toContain("whitespace-nowrap");
  });

  it("falls back to the session's bare project when session_label is absent (restart-skew)", () => {
    render(<ActivityFeed activity={[act(1, "s1", "Bash")]} sessions={[session("s1", "oxygenrx")]} />);
    expect(screen.getByText("oxygenrx")).toBeDefined();
    expect(document.querySelector('[data-harness="claude"]')).toBeTruthy(); // default harness
  });
});

describe("ActivityFeed §5.2: session filter", () => {
  const twoSessions: Activity[] = [
    { id: 1, session_id: "s1", tool: "Bash", detail: null, dur: null, at: Date.now(), session_label: "alpha" },
    { id: 2, session_id: "s2", tool: "Read", detail: null, dur: null, at: Date.now(), session_label: "beta" },
  ];

  it("omits the session filter select when everything comes from one session", () => {
    render(<ActivityFeed activity={[act(1, "s1", "Bash")]} sessions={[session("s1", "p")]} />);
    expect(screen.queryByLabelText("Filter activity by session")).toBeNull();
  });

  it("filters the feed to the chosen session, and back to all", () => {
    render(<ActivityFeed activity={twoSessions} sessions={[session("s1", "alpha"), session("s2", "beta")]} />);
    expect(screen.getByText("Bash")).toBeDefined();
    expect(screen.getByText("Read")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Filter activity by session"), { target: { value: "s2" } });
    expect(screen.queryByText("Bash")).toBeNull();
    expect(screen.getByText("Read")).toBeDefined();
  });

  it("keeps the select visible (and pointed at a real option) once the filtered session's own rows age out (finding fix)", () => {
    // Filtering to "s2" and then having s2's own rows roll off the feed
    // entirely used to both hide the select (`sessionOptions.size > 1` no
    // longer held, once only s1's rows remained) AND leave its `value`
    // pointed at an option that no longer exists - stranding the user
    // mid-filter with no visible control to reset it.
    const { rerender } = render(
      <ActivityFeed activity={twoSessions} sessions={[session("s1", "alpha"), session("s2", "beta")]} />
    );
    fireEvent.change(screen.getByLabelText("Filter activity by session"), { target: { value: "s2" } });
    rerender(
      <ActivityFeed
        activity={[twoSessions[0]]} // only s1's row is left in the feed now
        sessions={[session("s1", "alpha"), session("s2", "beta")]}
      />
    );
    const select = screen.getByLabelText("Filter activity by session") as HTMLSelectElement;
    expect(select.value).toBe("s2");
    expect(screen.queryByText("Bash")).toBeNull(); // still filtered to (now-empty) s2
  });
});
