import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.ts";
import { Store } from "./store.ts";
import { SseHub } from "./sse.ts";
import { createApp, buildState, type AppDeps } from "./http.ts";
import { tailUsage } from "./usage.ts";
import { repriceFiveSeries, REPRICE_MARKER } from "./reprice.ts";
import { PORT, HOST, DB_PATH, STALE_MS, DEAD_MS, SWEEP_INTERVAL_MS } from "./config.ts";

const store = new Store(openDb(DB_PATH));
const sse = new SseHub();
const pushState = () => sse.broadcast("state", buildState(store));
const onChange = pushState;

const deps: AppDeps = { store, sse, mcp: { store, onChange } };
const app = createApp(deps);

// Serve built dashboard from dist/web if present (production).
const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, "..", "..", "dist", "web");

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const apiish =
    url.pathname.startsWith("/api") ||
    url.pathname === "/events" ||
    url.pathname === "/mcp";
  if (!apiish && existsSync(webDir)) {
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const target = resolve(webDir, rel);
    if (!target.startsWith(resolve(webDir))) {
      res.writeHead(403).end();
      return;
    }
    const file = Bun.file(target);
    if (await file.exists()) {
      res.writeHead(200, { "content-type": file.type || "application/octet-stream" });
      res.end(Buffer.from(await file.arrayBuffer()));
      return;
    }
    // SPA fallback
    const index = Bun.file(join(webDir, "index.html"));
    if (await index.exists()) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(Buffer.from(await index.arrayBuffer()));
      return;
    }
  }
  await app(req, res);
});

setInterval(() => {
  const affected = store.sweepStale(Date.now(), STALE_MS, DEAD_MS);
  let changed = affected.length > 0;
  for (const s of store.sessionsToTail()) {
    if (tailUsage(store, s)) changed = true;
  }
  if (changed) pushState();
}, SWEEP_INTERVAL_MS);

// One-shot: reprice the pre-existing $0.00 5-series rows (spec §0b). Gated behind
// AM_REPRICE=1 for the manual first run and guarded by a marker so a restart
// cannot re-run it.
if (process.env.AM_REPRICE === "1" && !store.getMeta(REPRICE_MARKER)) {
  const r = repriceFiveSeries(store, Date.now());
  console.log(`[reprice] sessions=${r.sessions} deleted=${r.deleted} re-tailed=${r.recorded}`);
}

server.listen(PORT, HOST, () => {
  console.log(`am-server listening on http://${HOST}:${PORT}`);
});
