import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isHeadless, rewriteArgs, StreamState, renderBuffered } from "../src/cli/am-cursor.ts";

const FIX = join(import.meta.dir, "fixtures", "cursor");
const lines = (name: string) => readFileSync(join(FIX, name), "utf8").split("\n");
const feed = (name: string) => {
  const s = new StreamState();
  for (const l of lines(name)) s.push(l);
  return s;
};

describe("isHeadless", () => {
  it("is true for -p / --print and false otherwise", () => {
    expect(isHeadless(["-p", "hi"])).toBe(true);
    expect(isHeadless(["--force", "--print", "hi"])).toBe(true);
    expect(isHeadless(["hi"])).toBe(false);
    expect(isHeadless(["--", "-p"])).toBe(false); // a prompt after `--`, not the flag
  });
});

describe("rewriteArgs", () => {
  it("forces stream-json and remembers the caller's format in both flag forms", () => {
    expect(rewriteArgs(["-p", "--output-format", "json", "hi"])).toEqual({
      args: ["--output-format", "stream-json", "-p", "hi"],
      requested: "json",
    });
    expect(rewriteArgs(["-p", "--output-format=stream-json", "hi"]).requested).toBe("stream-json");
  });

  it("defaults to text, and leaves everything after `--` untouched", () => {
    expect(rewriteArgs(["-p", "--", "--output-format", "json"])).toEqual({
      args: ["--output-format", "stream-json", "-p", "--", "--output-format", "json"],
      requested: "text",
    });
  });
});

describe("StreamState (real cursor-agent 2026.09.23 stream-json captures)", () => {
  it("captures session, request, init model and per-invocation usage", () => {
    const s = feed("simple.stream.jsonl");
    expect(s.sessionId).toBe("bf0ff3dc-127c-45e6-baf0-3c2bbbbc47fe");
    expect(s.requestId).toBe("3ccb3028-f3b3-4692-abd0-9efaa230cd13");
    expect(typeof s.model).toBe("string");
    expect(s.usage).toEqual({
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
      cacheReadTokens: expect.any(Number),
      cacheWriteTokens: expect.any(Number),
    });
  });

  it("renders text mode byte-for-byte: only the assistant text after the last tool call", () => {
    // Captured from `--output-format text` for the same prompt; the result
    // field itself concatenates every message ("Checking now.All done.").
    expect(renderBuffered("text", feed("tool-call.stream.jsonl"))).toBe(
      readFileSync(join(FIX, "tool-call.text.txt"), "utf8")
    );
  });

  it("renders json mode with json mode's own key order and trailing newline", () => {
    const jsonMode = readFileSync(join(FIX, "simple.json-mode.txt"), "utf8");
    const out = renderBuffered("json", feed("simple.stream.jsonl"))!;
    expect(out.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(out))).toEqual(Object.keys(JSON.parse(jsonMode)));
  });

  it("prints nothing when cursor-agent printed nothing (e.g. an invalid --model)", () => {
    expect(renderBuffered("text", new StreamState())).toBeNull();
    expect(renderBuffered("json", new StreamState())).toBeNull();
  });

  it("never swallows a non-JSON stdout line", () => {
    const s = new StreamState();
    s.push("some warning");
    for (const l of lines("simple.stream.jsonl")) s.push(l);
    expect(renderBuffered("text", s)).toBe("some warning\npong\n");
  });
});
