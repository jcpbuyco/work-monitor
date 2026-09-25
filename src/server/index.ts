import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.ts";
import { Store } from "./store.ts";
import { SseHub } from "./sse.ts";
import { createApp, createStateScheduler, type AppDeps } from "./http.ts";
import { tailUsage } from "./usage.ts";
import { repriceFiveSeries, REPRICE_MARKER } from "./reprice.ts";
import {
  PORT,
  HOST,
  DB_PATH,
  STALE_MS,
  DEAD_MS,
  NEEDS_YOU_DEAD_MS,
  SWEEP_INTERVAL_MS,
  EVENTS_RETENTION_MS,
  RETENTION_SWEEP_INTERVAL_MS,
  WF_TICK_MS,
  WORKFLOWS_ENABLED,
} from "./config.ts";
import { backfillWorkflows, logOnce, bumpDegraded, workflowTick } from "./workflows.ts";
import { backfillEventsColumns } from "./events-migrate.ts";
import { retentionSweep, runPendingVacuum } from "./retention.ts";

const store = new Store(openDb(DB_PATH));
const sse = new SseHub();
// ONE shared throttle (§1.1): every mutation path below passes this same
// instance so a burst across POST /events, todo CRUD, MCP onChange, and the
// 60s sweep still coalesces into a single broadcast per window.
const scheduleState = createStateScheduler(store, sse);
const onChange = scheduleState;

const deps: AppDeps = { store, sse, scheduleState, mcp: { store, onChange } };
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
  const affected = store.sweepStale(Date.now(), STALE_MS, DEAD_MS, NEEDS_YOU_DEAD_MS);
  let changed = affected.length > 0;
  for (const s of store.sessionsToTail()) {
    if (tailUsage(store, s)) changed = true;
  }
  if (changed) scheduleState();
}, SWEEP_INTERVAL_MS);

// Hourly retention sweep (§1.4): prune events older than 30 days. The first
// ever prune to actually delete something triggers a one-time safety backup
// (VACUUM INTO) before anything destructive runs, and marks that the deferred
// one-time VACUUM (below, at the NEXT startup) has work to do. Wrapped in
// try/catch: this runs inside a bare setInterval callback, so an uncaught
// throw here (a wedged VACUUM INTO target, a locked DB) would otherwise be an
// uncaught exception for the whole process every hour.
setInterval(() => {
  try {
    const deleted = retentionSweep(store, DB_PATH, Date.now(), EVENTS_RETENTION_MS);
    if (deleted > 0) console.log(`[retention] pruned ${deleted} events older than 30 days`);
  } catch (err) {
    if (logOnce("retention-sweep", err)) bumpDegraded();
  }
}, RETENTION_SWEEP_INTERVAL_MS);

// A SECOND interval, deliberately separate from the 60s sweep: a live run must
// feel live. This tick must NEVER call scheduleState()/pushState() - a 5s
// full-state broadcast would burn CPU permanently even at buildState()'s new
// sub-50ms warm cost (§1.3). Usage it records
// therefore does not reach the cost panels until the next 60s sweep; that
// asymmetry is accepted. The scan-then-diff-then-broadcast logic itself lives in
// workflowTick() (workflows.ts), where it can be exercised by a test without
// importing this file (see tests/workflows.test.ts's "workflowTick" suite).
if (WORKFLOWS_ENABLED) {
  setInterval(() => workflowTick(store, sse, Date.now()), WF_TICK_MS);
}

// One-shot: reprice the pre-existing $0.00 5-series rows (spec §0b). Gated behind
// AM_REPRICE=1 for the manual first run and guarded by a marker so a restart
// cannot re-run it.
if (process.env.AM_REPRICE === "1" && !store.getMeta(REPRICE_MARKER)) {
  const r = repriceFiveSeries(store, Date.now());
  console.log(`[reprice] sessions=${r.sessions} deleted=${r.deleted} re-tailed=${r.recorded}`);
}

if (WORKFLOWS_ENABLED) {
  try {
    const t0 = Date.now();
    const { runs } = backfillWorkflows(store, t0);
    console.log(`[wf-backfill] runs=${runs} in ${Date.now() - t0}ms`);
  } catch (err) {
    if (logOnce("wf-backfill", err)) bumpDegraded();
  }
}

// One-shot: populate the new `events` columns for historic rows and rebuild
// `tool_stats` from them (§1.2). Guarded by app_meta `events_columns_v1`.
{
  const t0 = Date.now();
  const { updated } = backfillEventsColumns(store, t0);
  if (updated > 0) console.log(`[events-backfill] columns backfilled for ${updated} rows in ${Date.now() - t0}ms`);
}

// One-time (per boot) retention prune, run synchronously at startup rather
// than waiting for the first hourly interval tick: a long-running systemd
// service could otherwise sit on 30+ days of stale events for up to an hour
// after every restart before the first prune (and the VACUUM below, which
// depends on it) ever runs. The hourly interval above still owns steady-state
// pruning after this.
{
  const t0 = Date.now();
  try {
    const deleted = retentionSweep(store, DB_PATH, Date.now(), EVENTS_RETENTION_MS);
    if (deleted > 0) console.log(`[retention] startup prune: ${deleted} events older than 30 days in ${Date.now() - t0}ms`);
  } catch (err) {
    if (logOnce("retention-sweep", err)) bumpDegraded();
  }
}

// Deferred one-time VACUUM (§1.4): only runs once a retention sweep has
// actually pruned something (across any past run of the server, including the
// startup prune just above), and only here at startup - never inside the
// sweep's own interval, which must stay cheap.
{
  const t0 = Date.now();
  if (runPendingVacuum(store)) console.log(`[retention] one-time VACUUM after first prune, ${Date.now() - t0}ms`);
}

server.listen(PORT, HOST, () => {
  console.log(`am-server listening on http://${HOST}:${PORT}`);
});
