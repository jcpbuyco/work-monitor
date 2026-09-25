import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMediaQuery } from "../src/web/useMediaQuery.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubMatchMedia(initiallyMatches: boolean) {
  let matches = initiallyMatches;
  let listener: (() => void) | null = null;
  const mql = {
    get matches() {
      return matches;
    },
    media: "",
    addEventListener: (_: string, l: () => void) => {
      listener = l;
    },
    removeEventListener: () => {
      listener = null;
    },
  };
  vi.stubGlobal("matchMedia", () => mql);
  return {
    fire(next: boolean) {
      matches = next;
      listener?.();
    },
  };
}

describe("useMediaQuery", () => {
  it("defaults to false when matchMedia isn't implemented (plain jsdom)", () => {
    const { result } = renderHook(() => useMediaQuery("(max-width: 767px)"));
    expect(result.current).toBe(false);
  });

  it("reflects matchMedia's initial value when it is available", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery("(max-width: 767px)"));
    expect(result.current).toBe(true);
  });

  it("updates live when the media query's match state changes", () => {
    const media = stubMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery("(max-width: 767px)"));
    expect(result.current).toBe(false);
    act(() => media.fire(true));
    expect(result.current).toBe(true);
  });
});
