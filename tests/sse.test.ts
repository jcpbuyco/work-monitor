import { describe, it, expect } from "bun:test";
import { SseHub } from "../src/server/sse.ts";

/** A minimal stand-in for `ServerResponse`: just enough surface for `SseHub`
 *  (`write`, and the `on("close", ...)` it registers in `add`). */
function fakeResponse() {
  const writes: string[] = [];
  return {
    writes,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    on() {
      // `add` registers a close listener; nothing in this test ever fires it.
    },
  };
}

describe("SseHub.startKeepalive (§5.2 fix)", () => {
  it("periodically broadcasts a bare ping event to every open client", async () => {
    const hub = new SseHub();
    const client = fakeResponse();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hub.add(client as any);

    hub.startKeepalive(10);
    try {
      await new Promise((r) => setTimeout(r, 35));
    } finally {
      hub.stopKeepalive();
    }

    expect(client.writes.some((w) => w.startsWith("event: ping\n"))).toBe(true);
    expect(client.writes.length).toBeGreaterThanOrEqual(2); // ~35ms / 10ms interval
  });

  it("stopKeepalive halts further pings", async () => {
    const hub = new SseHub();
    const client = fakeResponse();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hub.add(client as any);

    hub.startKeepalive(10);
    await new Promise((r) => setTimeout(r, 15));
    hub.stopKeepalive();
    const countAtStop = client.writes.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(client.writes.length).toBe(countAtStop);
  });

  it("is idempotent - a second call does not double the interval", async () => {
    const hub = new SseHub();
    const client = fakeResponse();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hub.add(client as any);

    hub.startKeepalive(10);
    hub.startKeepalive(10);
    try {
      await new Promise((r) => setTimeout(r, 35));
    } finally {
      hub.stopKeepalive();
    }
    // ~3 pings expected at 10ms/35ms; a doubled interval would show ~6+.
    expect(client.writes.length).toBeLessThan(6);
  });
});
