#!/usr/bin/env bun
// Profiles buildState() end-to-end on a REAL production-sized DB, to verify
// spec §1.3's budget: buildState() must be under 50ms warm (usageVersion
// unchanged between calls, so the memoized cost aggregates and the
// incrementally-maintained `tool_stats` table both short-circuit their
// heavy, all-time full-table-scan queries).
//
// Usage:
//   bun run scripts/profile-state.ts <path-to-a-COPY-of-the-db> [--skip-backfill]
//
// This opens the given path READ-WRITE (openDb) and, unless --skip-backfill
// is given, runs the one-time events-columns/tool_stats backfill (§1.2) so the
// measurement reflects a fully-migrated production DB, not an empty
// tool_stats table. It refuses to run against the configured live DB path -
// point it at a copy (see the hard constraints in the task this script was
// written for: NEVER touch the live DB in place).
import { resolve } from "node:path";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import { buildState } from "../src/server/http.ts";
import { backfillEventsColumns } from "../src/server/events-migrate.ts";
import { defaultDbPath } from "../src/server/config.ts";

function fail(msg: string): never {
  console.error(`[profile-state] ${msg}`);
  process.exit(1);
}

const arg = process.argv[2];
if (!arg || arg.startsWith("--")) {
  fail("usage: bun run scripts/profile-state.ts <path-to-a-copy-of-the-db> [--skip-backfill]");
}
const path = resolve(arg);
const live = resolve(process.env.AM_DB_PATH ?? defaultDbPath());
if (path === live) {
  fail(`refusing to open the live DB (${live}) -- point this at a COPY.`);
}

console.log(`[profile-state] opening ${path}`);
const t0 = performance.now();
const store = new Store(openDb(path));
console.log(`[profile-state] openDb + migrate: ${(performance.now() - t0).toFixed(2)}ms`);

if (!process.argv.includes("--skip-backfill")) {
  const tb = performance.now();
  const { updated } = backfillEventsColumns(store, Date.now());
  console.log(`[profile-state] events-columns backfill: updated=${updated} rows in ${(performance.now() - tb).toFixed(2)}ms`);
} else {
  console.log("[profile-state] --skip-backfill given: tool_stats may be empty/incomplete");
}

const N = 8;
const timings: number[] = [];
for (let i = 0; i < N; i++) {
  const t = performance.now();
  buildState(store);
  timings.push(performance.now() - t);
}

console.log(`[profile-state] buildState() timings (ms): ${timings.map((t) => t.toFixed(2)).join(", ")}`);
console.log(`[profile-state] cold (call 1): ${timings[0].toFixed(2)}ms`);
const warm = timings.slice(1);
const avgWarm = warm.reduce((a, b) => a + b, 0) / warm.length;
const maxWarm = Math.max(...warm);
console.log(`[profile-state] warm (calls 2..${N}) avg: ${avgWarm.toFixed(2)}ms, max: ${maxWarm.toFixed(2)}ms`);
if (maxWarm < 50) {
  console.log("[profile-state] PASS: warm buildState() stays under 50ms (spec 1.3)");
} else {
  console.log("[profile-state] FAIL: warm buildState() exceeded 50ms (spec 1.3)");
  process.exit(1);
}
