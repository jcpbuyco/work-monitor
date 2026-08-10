import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkflowRunCard } from "../src/web/components/WorkflowRunCard.tsx";
import { WorkflowsSection } from "../src/web/components/WorkflowsSection.tsx";
import type { LiveWorkflow } from "../src/web/types.ts";

const agent = (over: Partial<LiveWorkflow["agents"][number]>): LiveWorkflow["agents"][number] => ({
  agent_id: "a1", label: null, phase_index: null, phase_title: null, idx: null, model: null,
  state: "running", attempt: 1, last_tool: null, last_tool_summary: null, prompt_preview: null,
  started_at: null, ended_at: null, duration_ms: null, tool_calls: null, tokens: 0, costUsd: 0,
  ...over,
});

const live = (over: Partial<LiveWorkflow> = {}): LiveWorkflow => ({
  run_id: "wf_abc", session_id: "s1", project: "alpha", branch: "feat/x", name: "research",
  status: null, state: "running", started_at: Date.now() - 185_000, phase: null, schema_ok: true,
  costUsd: 1.25, tokens: 512_000,
  agents: [agent({ agent_id: "a1", label: "map-codebase", model: "claude-sonnet-5", tokens: 300_000, costUsd: 1 })],
  ...over,
});

beforeEach(() => localStorage.clear());

describe("WorkflowRunCard", () => {
  it("shows the workflow name, project/branch, live cost and tokens", () => {
    render(<WorkflowRunCard w={live()} />);
    expect(screen.getByText("research")).toBeTruthy();
    expect(screen.getByText("alpha · feat/x")).toBeTruthy();
    expect(screen.getByText("$1.25")).toBeTruthy();
    expect(screen.getByText("512K tok")).toBeTruthy();
  });

  it("falls back to the run id when the workflow has no name", () => {
    render(<WorkflowRunCard w={live({ name: null })} />);
    expect(screen.getByText("wf_abc")).toBeTruthy();
  });

  it("says 'phases resolve on completion' when no phase is known", () => {
    // Not a bug to engineer away: the manifest is written once, at terminal
    // state, so a live run genuinely has no label->phase mapping.
    render(<WorkflowRunCard w={live({ phase: null })} />);
    expect(screen.getByText("phases resolve on completion")).toBeTruthy();
  });

  it("renders the 1-based phase pill verbatim when a phase is known", () => {
    render(<WorkflowRunCard w={live({ phase: { index: 2, total: 4, title: "Judge" } })} />);
    expect(screen.getByText("Phase 2/4 · Judge")).toBeTruthy();
  });

  it("falls back to the agentId when an agent has no label (the common live case)", () => {
    render(<WorkflowRunCard w={live({ agents: [agent({ agent_id: "ad673b79", label: null })] })} />);
    expect(screen.getByText("ad673b79")).toBeTruthy();
  });

  it("renders an unknown status without rejecting it, marked as unknown", () => {
    render(<WorkflowRunCard w={live({ status: "brand-new-status" })} />);
    expect(screen.getByText("brand-new-status").getAttribute("data-status-known")).toBe("false");
  });

  it("shows the structure-unavailable badge when the manifest parsed to zero agents", () => {
    render(<WorkflowRunCard w={live({ schema_ok: false })} />);
    expect(screen.getByText("structure unavailable")).toBeTruthy();
  });

  it("collapses the per-agent rows and remembers it per run", () => {
    render(<WorkflowRunCard w={live()} />);
    expect(screen.getByText("map-codebase")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /research/ }));
    expect(screen.queryByText("map-codebase")).toBeNull();
    expect(localStorage.getItem("am-wf-wf_abc")).toBe("true");
  });
});

describe("WorkflowsSection", () => {
  it("renders nothing at all when there are no live runs (zero vertical footprint)", () => {
    const { container } = render(<WorkflowsSection workflows={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders a card per live run behind a collapsible header", () => {
    render(<WorkflowsSection workflows={[live(), live({ run_id: "wf_two", name: "spec-plan" })]} />);
    expect(screen.getByRole("button", { name: /Workflows \(2\)/ })).toBeTruthy();
    expect(screen.getByText("research")).toBeTruthy();
    expect(screen.getByText("spec-plan")).toBeTruthy();
  });
});
