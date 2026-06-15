import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionCard } from "../src/web/components/SessionCard.tsx";
import type { Session } from "../src/web/types.ts";

const base: Session = {
  id: "s1", project: "myrepo", status: "working", current_task: null,
  current_intent: null, attention_reason: null, branch: null,
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
});
