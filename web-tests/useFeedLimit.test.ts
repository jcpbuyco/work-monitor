import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFeedLimit } from "../src/web/useFeedLimit.ts";

beforeEach(() => localStorage.clear());

describe("useFeedLimit", () => {
  it("defaults to 10", () => {
    const { result } = renderHook(() => useFeedLimit());
    expect(result.current.limit).toBe(10);
  });

  it("reads a valid stored limit", () => {
    localStorage.setItem("wm-feed-limit", "25");
    const { result } = renderHook(() => useFeedLimit());
    expect(result.current.limit).toBe(25);
  });

  it("ignores an out-of-range stored limit", () => {
    localStorage.setItem("wm-feed-limit", "999");
    const { result } = renderHook(() => useFeedLimit());
    expect(result.current.limit).toBe(10);
  });

  it("sets and persists a new limit", () => {
    const { result } = renderHook(() => useFeedLimit());
    act(() => result.current.setLimit(50));
    expect(result.current.limit).toBe(50);
    expect(localStorage.getItem("wm-feed-limit")).toBe("50");
  });
});
