import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SessionCard } from "../src/web/components/SessionCard.tsx";
import type { Session } from "../src/web/types.ts";

const base: Session = {
  id: "s1", project: "myrepo", status: "working", current_task: null,
  current_intent: null, attention_reason: null, active_tool: null, branch: null, idle_reason: null,
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
    expect(screen.getByTestId("cost-cell").textContent).toBe("$1.24 · 312K tok");
  });

  it("omits the cost line when no cost is provided", () => {
    const { container } = render(<SessionCard s={base} />);
    expect(container.textContent).not.toContain("tok");
  });
});

describe("SessionCard workflow badge", () => {
  afterEach(cleanup);

  it("shows a wf badge that deep-links to the run when the session owns a live run (§5.1)", () => {
    render(<SessionCard s={base} wfRunId="wf_abc" />);
    const badge = screen.getByTitle("owns a live workflow run");
    expect(badge.tagName).toBe("A");
    expect(badge.getAttribute("href")).toBe("#/workflows?run=wf_abc");
  });

  it("omits the badge by default", () => {
    render(<SessionCard s={base} />);
    expect(screen.queryByTitle("owns a live workflow run")).toBeNull();
  });
});

describe("SessionCard §5.1: A+ truncation order (P2-6)", () => {
  afterEach(cleanup);

  it("gives the task text a guaranteed min-width floor, not min-w-0 (which let it shrink to nothing)", () => {
    render(<SessionCard s={{ ...base, current_task: "a very long task description that could get squeezed out" }} />);
    const task = screen.getByTitle(/a very long task description/);
    expect(task.className).toContain("min-w-[6rem]");
    expect(task.className).not.toContain("min-w-0");
  });

  it("caps branch and cost with their own max-width so they give way before the task text does", () => {
    render(<SessionCard s={{ ...base, branch: "feat/x" }} cost={{ costUsd: 1.24, tokens: 312_000 }} />);
    expect(screen.getByTitle("⎇ feat/x").className).toContain("max-w-[9rem]");
    expect(screen.getByTestId("cost-cell").className).toContain("max-w-[11rem]");
  });

  it("weights branch and cost to shrink well before the task text (finding fix - was reversed)", () => {
    render(<SessionCard s={{ ...base, branch: "feat/x" }} cost={{ costUsd: 1.24, tokens: 312_000 }} />);
    const task = screen.getByTitle("-"); // base has no current_task/current_intent
    expect(screen.getByTitle("⎇ feat/x").className).toContain("shrink-[6]");
    expect(screen.getByTestId("cost-cell").className).toContain("shrink-[6]");
    // the task keeps plain `flex-1` (basis 0, so it gets none of the shrink
    // weight) instead of also being weighted like branch/cost.
    expect(task.className).not.toContain("shrink-[6]");
  });

  it("never truncates the cost cell's priced/partial/unpriced/n-a word - only the token suffix gives way", () => {
    render(<SessionCard s={base} cost={{ costUsd: null, tokens: 900, unpricedTokens: 900 }} />);
    const word = screen.getByText("unpriced");
    expect(word.className).toContain("shrink-0");
    expect(word.className).toContain("whitespace-nowrap");
  });
});

describe("SessionCard §5.1: harness mark and model pill", () => {
  afterEach(cleanup);

  it("shows a harness mark defaulting to claude when the field is absent (restart-skew)", () => {
    const { container } = render(<SessionCard s={base} />);
    expect(container.querySelector('[data-harness="claude"]')).toBeTruthy();
  });

  it("shows the harness mark for codex/cursor sessions, with version in the tooltip", () => {
    render(<SessionCard s={{ ...base, harness: "cursor", harness_version: "2026.08.11" }} />);
    expect(screen.getByTitle("Cursor 2026.08.11")).toBeTruthy();
  });

  it("shows a model pill using prettyModel when the session has a model", () => {
    render(<SessionCard s={{ ...base, model: "claude-opus-5-5" }} />);
    expect(screen.getByText("Opus 5.5")).toBeTruthy();
  });

  it("omits the model pill when the session has no model", () => {
    render(<SessionCard s={base} />);
    expect(screen.queryByTitle("claude-opus-5-5")).toBeNull();
  });
});

describe("SessionCard §5.1: cost cell priced/partial/unpriced/n-a semantics", () => {
  afterEach(cleanup);

  it("shows a plain $x.xx when every usage row is priced", () => {
    render(<SessionCard s={base} cost={{ costUsd: 1.24, tokens: 312_000, unpricedTokens: 0 }} />);
    expect(screen.getByTestId("cost-cell").textContent).toBe("$1.24 · 312K tok");
  });

  it("appends + with a tooltip when the session's usage is only partially priced", () => {
    render(<SessionCard s={base} cost={{ costUsd: 1.24, tokens: 312_000, unpricedTokens: 5_000 }} />);
    expect(screen.getByTestId("cost-cell").textContent).toBe("$1.24+ · 312K tok");
    expect(screen.getByTitle("some usage from unpriced models")).toBeTruthy();
  });

  it("shows 'unpriced' (never a fabricated $0.00) when nothing priced", () => {
    render(<SessionCard s={base} cost={{ costUsd: null, tokens: 900, unpricedTokens: 900 }} />);
    expect(screen.getByTestId("cost-cell").textContent).toBe("unpriced · 900 tok");
  });

  it("shows n/a with a Cursor-specific tooltip for a cursor session with no captured usage", () => {
    render(<SessionCard s={{ ...base, harness: "cursor" }} />);
    expect(screen.getByText("n/a")).toBeTruthy();
    expect(
      screen.getByTitle("Cursor records no usage locally; run headless sessions through am-cursor to capture tokens")
    ).toBeTruthy();
  });

  it("prices a cursor session once am-cursor has captured its usage, like any other harness", () => {
    render(<SessionCard s={{ ...base, harness: "cursor" }} cost={{ costUsd: 0.0305, tokens: 22941, unpricedTokens: 0 }} />);
    expect(screen.getByTestId("cost-cell").textContent).toBe("$0.03 · 23K tok");
  });

  it("shows 'unpriced' for captured cursor usage on a model without a rate (e.g. Auto)", () => {
    render(
      <SessionCard s={{ ...base, harness: "cursor" }} cost={{ costUsd: null, tokens: 22941, unpricedTokens: 22941 }} />
    );
    expect(screen.getByTestId("cost-cell").textContent).toBe("unpriced · 23K tok");
  });
});

describe("SessionCard §5.1: idle reason", () => {
  afterEach(cleanup);

  it("shows 'stopped <age> ago' for a Stop-hook idle session", () => {
    render(<SessionCard s={{ ...base, status: "idle", idle_reason: "stopped" }} />);
    expect(screen.getByText(/^stopped .+ ago$/)).toBeTruthy();
  });

  it("shows 'quiet <age>' (no 'ago') for a silence-swept idle session", () => {
    render(<SessionCard s={{ ...base, status: "idle", idle_reason: "quiet" }} />);
    expect(screen.getByText(/^quiet [^ ]+$/)).toBeTruthy();
  });

  it("renders 'quiet' as a duration, not ago()'s absolute-date fallback past 7 days (finding fix)", () => {
    // idle sessions are swept to `ended` well within an hour of silence
    // (§1.6), but the OLD `ago(...).replace(/ ago$/, "")` implementation
    // still leaked ago()'s "Mon D" absolute-date format whenever it ran past
    // that switchover, with no hint it was even a duration ("quiet Sep 3").
    render(
      <SessionCard
        s={{ ...base, status: "idle", idle_reason: "quiet", last_activity_at: Date.now() - 12 * 60 * 1000 }}
      />
    );
    expect(screen.getByText("quiet 12m")).toBeTruthy();
  });
});

describe("SessionCard §5.1: live subagents chip", () => {
  afterEach(cleanup);

  it("shows a count chip and omits it when there are none", () => {
    render(<SessionCard s={base} />);
    expect(screen.queryByRole("button", { name: /agents?/ })).toBeNull();
  });

  it("expands to list each subagent's label, model and last tool", () => {
    render(
      <SessionCard
        s={{
          ...base,
          subagents: [
            { agent_id: "a1", kind: "task", label: "map-codebase", agent_type: "explore", model: "claude-sonnet-5", last_tool: "Read", last_at: Date.now() },
          ],
        }}
      />
    );
    const chip = screen.getByRole("button", { name: "1 agent" });
    expect(screen.queryByText("map-codebase")).toBeNull(); // collapsed by default
    fireEvent.click(chip);
    expect(screen.getByText("map-codebase")).toBeTruthy();
    expect(screen.getByText("Sonnet 5")).toBeTruthy();
    fireEvent.click(chip);
    expect(screen.queryByText("map-codebase")).toBeNull(); // collapses again
  });

  it("expands the row inline, not as an absolutely-positioned popover (finding fix)", () => {
    // The old popover was `absolute` and lived inside the chip's own stacking
    // context (each row sets a view-transition-name), so the NEXT row's
    // content painted over it and intercepted its clicks. Expanding inline -
    // a plain sibling in normal flow - sidesteps that entirely.
    const { container } = render(
      <SessionCard
        s={{
          ...base,
          subagents: [
            { agent_id: "a1", kind: "task", label: "map-codebase", agent_type: null, model: null, last_tool: null, last_at: Date.now() },
          ],
        }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "1 agent" }));
    const list = screen.getByTestId("subagents-list");
    expect(list.className).not.toContain("absolute");
    expect(list.className).not.toContain("z-10");
    // it's a sibling of the identity row, inside the same card - not nested
    // under the chip button.
    expect(container.querySelector('[data-testid="session-row"]')!.contains(list)).toBe(true);
    expect(screen.getByRole("button", { name: "1 agent" }).contains(list)).toBe(false);
  });

  it("pluralizes the chip label for more than one agent", () => {
    render(
      <SessionCard
        s={{
          ...base,
          subagents: [
            { agent_id: "a1", kind: "task", label: null, agent_type: null, model: null, last_tool: null, last_at: Date.now() },
            { agent_id: "a2", kind: "workflow", label: null, agent_type: null, model: null, last_tool: null, last_at: Date.now() },
          ],
        }}
      />
    );
    expect(screen.getByRole("button", { name: "2 agents" })).toBeTruthy();
  });
});

describe("SessionCard row", () => {
  afterEach(cleanup);

  it("keeps status in the accessibility tree after the visible label is removed", () => {
    // The coloured uppercase status line is gone - the glyph is aria-hidden, so
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

  it("draws an idle row as one compact line - no tool line, no shimmer, no branch", () => {
    const { container } = render(
      <SessionCard s={{ ...base, status: "idle", branch: "feat/x" }} latestTool="Read" cost={{ costUsd: 0.02, tokens: 100 }} />
    );
    expect(container.querySelector(".am-shimmer")).toBeNull();
    expect(screen.queryByText(/Read/)).toBeNull();
    expect(screen.queryByText(/⎇/)).toBeNull();
    expect(screen.getByText("$0.02")).toBeTruthy(); // cost only, no "· … tok" suffix
    expect(container.textContent).not.toContain("tok");
  });

  it("still shows the model pill on a compact (idle/ended) row (§5.1 finding fix)", () => {
    render(<SessionCard s={{ ...base, status: "idle", model: "gpt-5.5" }} />);
    expect(screen.getByText("GPT-5.5")).toBeTruthy();
  });

  it("omits the model pill on a compact row with no model, same as the full row", () => {
    render(<SessionCard s={{ ...base, status: "idle", model: null }} />);
    expect(screen.queryByText("GPT-5.5")).toBeNull();
  });

  it("shimmers only while working", () => {
    const { container, rerender } = render(<SessionCard s={base} />); // working
    expect(container.querySelector(".am-shimmer")).toBeTruthy();
    rerender(<SessionCard s={{ ...base, status: "needs_you" }} />);
    expect(container.querySelector(".am-shimmer")).toBeNull();
  });
});
