import { describe, it, expect } from "bun:test";
import { createThrottle, type ThrottleClock } from "../src/server/throttle.ts";

/** A fully synthetic clock: `advance()` moves time forward and synchronously
 *  runs any timers that are now due (in the order they become due), so tests
 *  never wait on the real event loop. */
class FakeClock implements ThrottleClock {
  private t = 0;
  private nextId = 1;
  private timers: { id: number; at: number; cb: () => void }[] = [];

  now(): number {
    return this.t;
  }

  setTimeout(cb: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ id, at: this.t + ms, cb });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((tm) => tm.id !== handle);
  }

  advance(ms: number): void {
    this.t += ms;
    // Run everything due, earliest first; a fired callback may itself
    // schedule another timer, so re-scan until nothing is due.
    for (;;) {
      const due = this.timers.filter((tm) => tm.at <= this.t).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((tm) => tm.id !== due.id);
      due.cb();
    }
  }

  get pendingCount(): number {
    return this.timers.length;
  }
}

describe("createThrottle", () => {
  it("fires once, on the next macrotask, for a burst of synchronous calls while idle", () => {
    const clock = new FakeClock();
    let calls = 0;
    const throttled = createThrottle(() => calls++, 1000, clock);

    throttled();
    throttled();
    throttled();
    expect(calls).toBe(0); // not synchronous
    clock.advance(0); // next macrotask
    expect(calls).toBe(1);
  });

  it("collapses calls inside an active window into one fire at lastFired + ms", () => {
    const clock = new FakeClock();
    let calls = 0;
    const throttled = createThrottle(() => calls++, 1000, clock);

    throttled();
    clock.advance(0); // first fire at t=0
    expect(calls).toBe(1);

    clock.advance(200); // t=200, well inside the window
    throttled();
    clock.advance(300); // t=500, still calls again inside window
    throttled();
    expect(calls).toBe(1); // not yet -- scheduled for t=1000

    clock.advance(499); // t=999
    expect(calls).toBe(1);
    clock.advance(1); // t=1000 -- exactly lastFired + ms
    expect(calls).toBe(2);
  });

  it("fires on the next macrotask again once idle past ms", () => {
    const clock = new FakeClock();
    let calls = 0;
    const throttled = createThrottle(() => calls++, 1000, clock);

    throttled();
    clock.advance(0);
    expect(calls).toBe(1);

    clock.advance(5000); // long idle gap, no calls
    throttled();
    expect(calls).toBe(1); // still deferred to a macrotask
    clock.advance(0);
    expect(calls).toBe(2);
  });

  it("cancel() drops a pending fire without ever calling fn", () => {
    const clock = new FakeClock();
    let calls = 0;
    const throttled = createThrottle(() => calls++, 1000, clock);

    throttled();
    throttled.cancel();
    clock.advance(10_000);
    expect(calls).toBe(0);
    expect(clock.pendingCount).toBe(0);
  });

  it("a call after cancel schedules a fresh fire", () => {
    const clock = new FakeClock();
    let calls = 0;
    const throttled = createThrottle(() => calls++, 1000, clock);

    throttled();
    throttled.cancel();
    throttled();
    clock.advance(0);
    expect(calls).toBe(1);
  });

  it("uses the real clock by default (integration smoke test)", async () => {
    let calls = 0;
    const throttled = createThrottle(() => calls++, 20);
    throttled();
    throttled();
    throttled();
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(1);
  });
});
