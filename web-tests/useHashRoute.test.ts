import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useHashRoute } from "../src/web/useHashRoute.ts";

beforeEach(() => {
  window.location.hash = "";
});

describe("useHashRoute", () => {
  it("defaults to '#/' when there is no hash", () => {
    const { result } = renderHook(() => useHashRoute());
    expect(result.current).toBe("#/");
  });

  it("updates when the hash changes", () => {
    const { result } = renderHook(() => useHashRoute());
    act(() => {
      window.location.hash = "#/cost";
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(result.current).toBe("#/cost");
  });
});
