import { describe, it, expect } from "vitest";
import { statusClass, statusKnown, statusGlyphKind } from "../src/web/workflowStatus.ts";

describe("workflowStatus", () => {
  it("colours completed as done and failures as danger", () => {
    expect(statusClass("completed")).toBe("text-done"); // was text-working
    expect(statusClass("running")).toBe("text-working");
    expect(statusClass("failed")).toBe("text-danger"); // was text-attention
    expect(statusClass("killed")).toBe("text-danger");
    expect(statusClass("orphaned")).toBe("text-ink-4");
    expect(statusClass("settled")).toBe("text-ink-4");
  });

  it("stays a display hint, never a validator", () => {
    expect(statusKnown("brand-new-status")).toBe(false);
    expect(statusClass("brand-new-status")).toBe("text-ink-4"); // grey, never a throw
    expect(statusGlyphKind("brand-new-status")).toBe("idle"); // hollow ring
  });

  it("maps every known status to a glyph, with no key the class map lacks", () => {
    expect(statusGlyphKind("running")).toBe("working");
    expect(statusGlyphKind("completed")).toBe("ended");
    expect(statusGlyphKind("failed")).toBe("danger");
    expect(statusGlyphKind("killed")).toBe("danger");
    expect(statusGlyphKind("orphaned")).toBe("idle");
    expect(statusGlyphKind("settled")).toBe("idle");
    // The two maps must be edited together, or a run can get a text-danger
    // label under an idle ring.
    for (const k of ["completed", "running", "failed", "killed", "orphaned", "settled"]) {
      expect(statusKnown(k)).toBe(true);
    }
  });
});
