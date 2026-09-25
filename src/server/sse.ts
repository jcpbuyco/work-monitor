import type { ServerResponse } from "node:http";

export class SseHub {
  private clients = new Set<ServerResponse>();
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  add(res: ServerResponse): void {
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }

  broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  /** §5.2 fix: on a quiet server (no hook traffic, no live workflow run),
   *  NOTHING else ever writes to an open stream - `state` broadcasts only on
   *  change (§1.1) and `workflows` only on a diff (workflowTick). Without
   *  this, a perfectly healthy, connected client looks identical to a dropped
   *  one once the client's staleness window elapses, which is exactly the
   *  false "Reconnecting…" the board must never show. A bare `ping` event
   *  (ignored by every handler except the one that resets that timer) is
   *  cheaper than a comment line: `EventSource` only exposes named events to
   *  `addEventListener`, not raw `:`-comment keepalives. Idempotent - a
   *  second call is a no-op rather than doubling the interval. */
  startKeepalive(ms: number): void {
    if (this.keepaliveTimer) return;
    this.keepaliveTimer = setInterval(() => this.broadcast("ping", {}), ms);
  }

  stopKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  get size(): number {
    return this.clients.size;
  }
}
