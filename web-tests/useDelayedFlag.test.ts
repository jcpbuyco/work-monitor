import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDelayedFlag } from "../src/web/useDelayedFlag.ts";

afterEach(() => vi.useRealTimers());

describe("useDelayedFlag", () => {
  it("turns true only after the flag has stayed true for the delay", () => {
    vi.useFakeTimers();
    const { result } = renderHook(({ on }) => useDelayedFlag(on, 300), { initialProps: { on: true } });
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(299));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("never turns true when the flag clears before the delay (fast loads skip the skeleton)", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ on }) => useDelayedFlag(on, 300), { initialProps: { on: true } });
    act(() => vi.advanceTimersByTime(100));
    rerender({ on: false });
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(false);
  });

  it("drops back to false as soon as the flag clears", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ on }) => useDelayedFlag(on, 300), { initialProps: { on: true } });
    act(() => vi.advanceTimersByTime(300));
    expect(result.current).toBe(true);
    rerender({ on: false });
    expect(result.current).toBe(false);
  });
});
