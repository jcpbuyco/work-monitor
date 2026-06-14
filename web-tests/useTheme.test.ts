import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTheme } from "../src/web/useTheme.ts";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useTheme", () => {
  it("resolves stored 'light' and leaves the dark class off", () => {
    localStorage.setItem("wm-theme", "light");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("resolves stored 'dark' and adds the dark class", () => {
    localStorage.setItem("wm-theme", "dark");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("falls back to system preference when nothing is stored", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: true, media: q, addEventListener() {}, removeEventListener() {},
    }));
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light"); // prefers-color-scheme: light matches
  });

  it("toggle flips theme, the dark class, and persists to localStorage", () => {
    localStorage.setItem("wm-theme", "light");
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggle());
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("wm-theme")).toBe("dark");
  });
});
