import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { WorkflowsSection } from "../src/web/components/WorkflowsSection.tsx";
import type { LastRun } from "../src/web/types.ts";

afterEach(cleanup);

const lastRun: LastRun = { run_id: "wf_x", name: "browns-coverage", status: "completed", ended_at: Date.now() - 2 * 3_600_000, costUsd: 4.39 };

describe("WorkflowsSection §5.2: last run line", () => {
  it("renders nothing when there is no live run and no last run", () => {
    const { container } = render(<WorkflowsSection workflows={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a one-line summary of the most recent settled run when nothing is live", () => {
    render(<WorkflowsSection workflows={[]} lastRun={lastRun} />);
    const line = screen.getByTestId("wf-last-run");
    expect(line.textContent).toContain("Last run: browns-coverage");
    expect(line.textContent).toContain("completed");
    expect(line.textContent).toContain("2h ago");
    expect(line.textContent).toContain("$4.39");
  });

  it("prefers the live strip over the last-run line when a run is live", () => {
    render(
      <WorkflowsSection
        lastRun={lastRun}
        workflows={[
          { run_id: "wf_y", session_id: "s1", project: "p", branch: null, name: "live-one", status: null,
            state: "running", started_at: Date.now(), phase: null, schema_ok: true, costUsd: 0, tokens: 0, agents: [] },
        ]}
      />
    );
    expect(screen.queryByTestId("wf-last-run")).toBeNull();
    expect(screen.getByText(/live-one/)).toBeTruthy();
  });
});
