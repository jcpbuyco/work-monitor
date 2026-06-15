import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMotion } from "../src/web/useMotion.ts";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("wm-anim");
});

describe("useMotion", () => {
  it("defaults on and adds the wm-anim class", () => {
    const { result } = renderHook(() => useMotion());
    expect(result.current.on).toBe(true);
    expect(document.documentElement.classList.contains("wm-anim")).toBe(true);
  });

  it("toggles off, persists, and removes the class", () => {
    const { result } = renderHook(() => useMotion());
    act(() => result.current.toggle());
    expect(result.current.on).toBe(false);
    expect(localStorage.getItem("wm-motion")).toBe("off");
    expect(document.documentElement.classList.contains("wm-anim")).toBe(false);
  });

  it("reads a stored 'off' preference", () => {
    localStorage.setItem("wm-motion", "off");
    const { result } = renderHook(() => useMotion());
    expect(result.current.on).toBe(false);
  });
});
