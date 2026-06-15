import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTextSize } from "../src/web/useTextSize.ts";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.style.fontSize = "";
});

describe("useTextSize", () => {
  it("defaults to 16 and applies it to the root", () => {
    const { result } = renderHook(() => useTextSize());
    expect(result.current.size).toBe(16);
    expect(document.documentElement.style.fontSize).toBe("16px");
  });

  it("reads a valid stored size", () => {
    localStorage.setItem("wm-text-size", "20");
    const { result } = renderHook(() => useTextSize());
    expect(result.current.size).toBe(20);
    expect(document.documentElement.style.fontSize).toBe("20px");
  });

  it("ignores an invalid stored size", () => {
    localStorage.setItem("wm-text-size", "13");
    const { result } = renderHook(() => useTextSize());
    expect(result.current.size).toBe(16);
  });

  it("inc steps up, persists, and clamps at the max", () => {
    localStorage.setItem("wm-text-size", "20");
    const { result } = renderHook(() => useTextSize());
    act(() => result.current.inc());
    expect(result.current.size).toBe(22);
    expect(localStorage.getItem("wm-text-size")).toBe("22");
    expect(result.current.canInc).toBe(false);
    act(() => result.current.inc());
    expect(result.current.size).toBe(22);
  });

  it("dec steps down and clamps at the min", () => {
    localStorage.setItem("wm-text-size", "14");
    const { result } = renderHook(() => useTextSize());
    expect(result.current.canDec).toBe(false);
    act(() => result.current.dec());
    expect(result.current.size).toBe(14);
    act(() => result.current.inc());
    expect(result.current.size).toBe(16);
  });
});
