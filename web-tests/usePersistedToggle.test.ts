import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePersistedToggle } from "../src/web/usePersistedToggle.ts";

beforeEach(() => localStorage.clear());

describe("usePersistedToggle", () => {
  it("defaults to false", () => {
    const { result } = renderHook(() => usePersistedToggle("k"));
    expect(result.current[0]).toBe(false);
  });

  it("respects an explicit initial value", () => {
    const { result } = renderHook(() => usePersistedToggle("k", true));
    expect(result.current[0]).toBe(true);
  });

  it("reads a stored value over the initial", () => {
    localStorage.setItem("k", "true");
    const { result } = renderHook(() => usePersistedToggle("k", false));
    expect(result.current[0]).toBe(true);
  });

  it("toggles and persists", () => {
    const { result } = renderHook(() => usePersistedToggle("k"));
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    expect(localStorage.getItem("k")).toBe("true");
    act(() => result.current[1]());
    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem("k")).toBe("false");
  });
});
