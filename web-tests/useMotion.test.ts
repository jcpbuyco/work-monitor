import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMotion } from "../src/web/useMotion.ts";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("am-anim");
});

describe("useMotion", () => {
  it("defaults on and adds the am-anim class", () => {
    const { result } = renderHook(() => useMotion());
    expect(result.current.on).toBe(true);
    expect(document.documentElement.classList.contains("am-anim")).toBe(true);
  });

  it("toggles off, persists, and removes the class", () => {
    const { result } = renderHook(() => useMotion());
    act(() => result.current.toggle());
    expect(result.current.on).toBe(false);
    expect(localStorage.getItem("am-motion")).toBe("off");
    expect(document.documentElement.classList.contains("am-anim")).toBe(false);
  });

  it("reads a stored 'off' preference", () => {
    localStorage.setItem("am-motion", "off");
    const { result } = renderHook(() => useMotion());
    expect(result.current.on).toBe(false);
  });
});
