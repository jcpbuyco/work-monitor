import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePersistedValue } from "../src/web/usePersistedValue.ts";

const isHarnessFilter = (v: unknown): v is "all" | "claude" => v === "all" || v === "claude";

beforeEach(() => localStorage.clear());

describe("usePersistedValue", () => {
  it("starts at the initial value when nothing is stored", () => {
    const { result } = renderHook(() => usePersistedValue("k", "all", isHarnessFilter));
    expect(result.current[0]).toBe("all");
  });

  it("reads a previously stored value on first render - no flicker", () => {
    localStorage.setItem("k", JSON.stringify("claude"));
    const { result } = renderHook(() => usePersistedValue("k", "all", isHarnessFilter));
    expect(result.current[0]).toBe("claude");
  });

  it("persists a new value and reflects it immediately", () => {
    const { result } = renderHook(() => usePersistedValue("k", "all", isHarnessFilter));
    act(() => result.current[1]("claude"));
    expect(result.current[0]).toBe("claude");
    expect(JSON.parse(localStorage.getItem("k")!)).toBe("claude");
  });

  it("falls back to initial when the stored value fails validation, never crashing", () => {
    localStorage.setItem("k", JSON.stringify("bogus"));
    const { result } = renderHook(() => usePersistedValue("k", "all", isHarnessFilter));
    expect(result.current[0]).toBe("all");
  });

  it("falls back to initial when storage holds unparsable JSON", () => {
    localStorage.setItem("k", "{not json");
    const { result } = renderHook(() => usePersistedValue("k", "all", isHarnessFilter));
    expect(result.current[0]).toBe("all");
  });
});
