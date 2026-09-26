#!/usr/bin/env bun
// Benchmarks computeInsights() end to end on a REAL production-sized DB copy,
// to verify the Insights spec §7 budget (target: under 200ms on a ~77k-row
// usage table).
//
// Usage:
//   bun run scripts/bench-insights.ts <path-to-a-COPY-of-the-db>
//
// Opens the given path READ-ONLY ({ readonly: true }) -- never mutates it,
// never runs migrate() -- and never the live DB path (guarded below, same
// convention as scripts/profile-state.ts). Runs computeInsights() 5 times and
// prints min/median ms; no timing assertions belong in CI (they flake), so
// this script's output goes in the PR description by hand instead.
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { computeInsights } from "../src/server/insights.ts";
import { defaultDbPath } from "../src/server/config.ts";

function fail(msg: string): never {
  console.error(`[bench-insights] ${msg}`);
  process.exit(1);
}

const arg = process.argv[2];
if (!arg || arg.startsWith("--")) {
  fail("usage: bun run scripts/bench-insights.ts <path-to-a-copy-of-the-db>");
}
const path = resolve(arg);
const live = resolve(process.env.AM_DB_PATH ?? defaultDbPath());
if (path === live) {
  fail(`refusing to open the live DB (${live}) -- point this at a .backup COPY.`);
}

console.log(`[bench-insights] opening ${path} (readonly)`);
const db = new Database(path, { readonly: true });

const RUNS = 5;
const times: number[] = [];
let rows = 0;
for (let i = 0; i < RUNS; i++) {
  const t0 = performance.now();
  const result = computeInsights(db, Date.now());
  const ms = performance.now() - t0;
  times.push(ms);
  rows = result.meta.usageRows;
  console.log(`[bench-insights] run ${i + 1}/${RUNS}: ${ms.toFixed(1)}ms`);
}
times.sort((a, b) => a - b);
const min = times[0];
const median = times[Math.floor(times.length / 2)];
console.log(`[bench-insights] usageRows=${rows} min=${min.toFixed(1)}ms median=${median.toFixed(1)}ms`);
