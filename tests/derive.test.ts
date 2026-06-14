import { describe, it, expect } from "bun:test";
import { projectFromCwd, truncate, deriveCurrentTask } from "../src/server/derive.ts";

describe("projectFromCwd", () => {
  it("uses the basename of the cwd", () => {
    expect(projectFromCwd("/home/lunatic/projects/work/browns")).toBe("browns");
  });
  it("handles trailing slash", () => {
    expect(projectFromCwd("/home/lunatic/projects/work/browns/")).toBe("browns");
  });
  it("falls back to 'unknown' for empty", () => {
    expect(projectFromCwd("")).toBe("unknown");
  });
});

describe("truncate", () => {
  it("leaves short strings", () => {
    expect(truncate("hi", 10)).toBe("hi");
  });
  it("adds an ellipsis when over length", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("deriveCurrentTask", () => {
  it("returns null for no todos", () => {
    expect(deriveCurrentTask([])).toBeNull();
    expect(deriveCurrentTask(undefined)).toBeNull();
  });
  it("shows the in_progress item with a done count", () => {
    const todos = [
      { content: "Write schema", status: "completed" },
      { content: "Build API", status: "in_progress" },
      { content: "Add tests", status: "pending" },
    ];
    expect(deriveCurrentTask(todos)).toBe("Build API (1/3 done)");
  });
  it("when nothing is in_progress, summarises progress", () => {
    const todos = [
      { content: "a", status: "completed" },
      { content: "b", status: "completed" },
    ];
    expect(deriveCurrentTask(todos)).toBe("2/2 done");
  });
  it("ignores malformed entries", () => {
    expect(deriveCurrentTask([{ foo: "bar" } as unknown as { content: string; status: string }])).toBe("0/1 done");
  });
});
