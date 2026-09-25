/** A clock abstraction `createThrottle` schedules through, instead of calling
 *  `Date.now`/`setTimeout` directly, so tests can drive it with a fully
 *  synthetic clock (no real waiting, no flakiness from real timer jitter). */
export interface ThrottleClock {
  now(): number;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: ThrottleClock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface Throttled {
  (): void;
  /** Drop a pending scheduled call, if any. Never fires it. */
  cancel(): void;
}

/** Trailing-edge throttle: coalesces a burst of calls into at most one `fn()`
 *  invocation per `ms` window.
 *
 *  - The first call after an idle period (no `fn()` in the last `ms`) fires on
 *    the next macrotask, not synchronously - so several synchronous calls in
 *    the same tick still collapse to one - while still feeling instant.
 *  - A call that lands inside an already-active window is deferred to exactly
 *    `lastFired + ms`.
 *  - Any call made while a fire is already scheduled is free: it collapses
 *    into that pending call rather than scheduling a second one. */
export function createThrottle(fn: () => void, ms: number, clock: ThrottleClock = realClock): Throttled {
  let lastFired = -Infinity;
  let timer: unknown = null;

  function fire(): void {
    timer = null;
    lastFired = clock.now();
    fn();
  }

  function trigger(): void {
    if (timer !== null) return; // a fire is already scheduled -- collapse into it
    const elapsed = clock.now() - lastFired;
    const delay = elapsed >= ms ? 0 : ms - elapsed;
    timer = clock.setTimeout(fire, delay);
  }

  trigger.cancel = (): void => {
    if (timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
    }
  };

  return trigger;
}
