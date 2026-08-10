import { describe, it, expect } from "vitest";
import { formatDuration, formatWhen } from "../src/web/time.ts";

describe("formatDuration", () => {
  it("formats sub-minute, sub-hour and multi-hour spans", () => {
    expect(formatDuration(950)).toBe("1s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(185_000)).toBe("3m 5s");
    expect(formatDuration(3_840_000)).toBe("1h 4m");
  });
  it("renders a dash for null or negative input", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
  });
});

describe("formatWhen", () => {
  it("formats an epoch-ms instant as 'Mon D HH:MM' in local time", () => {
    const t = new Date(2026, 5, 16, 14, 3).getTime();
    expect(formatWhen(t)).toBe("Jun 16 14:03");
  });
  it("renders a dash for null", () => {
    expect(formatWhen(null)).toBe("—");
  });
});
