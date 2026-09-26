import type { Database } from "bun:sqlite";
import { rateFor, type Rate, type Tokens } from "./pricing.ts";
import { familyOf, FAMILY_ORDER, type Family } from "../shared/modelFamily.ts";
import type {
  InsightsResponse,
  InsightsDay,
  InsightsKpi,
  InsightsRecords,
  ByMonthModel,
  ByMonthTokenClass,
  ByMonthKind,
  WeekHourCell,
  InsightsActivity,
  InsightsWorkflowRun,
  InsightsModel,
  InsightsProject,
  Kind,
  Usd,
} from "../shared/insights.ts";

export { familyOf } from "../shared/modelFamily.ts";

const TOKEN_SUM_SQL =
  "(input_tokens + output_tokens + cache_read_tokens + cache_create_5m_tokens + cache_create_1h_tokens)";
const THIRTY_MIN_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WORKFLOW_RUN_CAP = 2000;

// ---------------------------------------------------------------------------
// Local-calendar helpers.
//
// A DB timestamp is bucketed by SQLite's own `'localtime'` modifier; every
// derivation below that needs "which local day/month is this" builds the SAME
// kind of string from a plain JS `Date` (whose local getters read the
// process's timezone) so the two always agree -- see tests/insights.test.ts's
// TZ canary for why bun:sqlite's `'localtime'` and a *runtime* `process.env.TZ`
// write can disagree, and why the `test` script pins `TZ` before Bun starts
// instead of relying on a value set from inside a test.
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
/** "YYYY-MM" from a local Date. */
function ym(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
/** "YYYY-MM-DD" from a local Date. */
function ymd(d: Date): string {
  return `${ym(d)}-${pad2(d.getDate())}`;
}
/** "YYYY-MM-DD HH" -- the same shape as R1's `hb` column, so an hour-bucket
 *  string and a boundary built from a plain Date compare correctly with
 *  ordinary string comparison (no re-parsing either side). */
function hbOf(d: Date): string {
  return `${ymd(d)} ${pad2(d.getHours())}`;
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}
function endOfMonthExclusive(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0);
}
function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1, 0, 0, 0, 0);
}
/** Monday = 0 .. Sunday = 6 (JS's own `getDay()` is Sunday = 0). */
function mondayFirstWeekday(d: Date): number {
  return (d.getDay() + 6) % 7;
}

/** Every "YYYY-MM" from `firstAt`'s month through `now`'s month, inclusive,
 *  with no gaps (§6: "growth is never overstated by skipping gaps"). Empty
 *  when there is no usage yet. */
export function continuousMonths(firstAt: number | null, now: number): string[] {
  if (firstAt == null) return [];
  const start = startOfMonth(new Date(firstAt));
  const end = startOfMonth(new Date(now));
  const out: string[] = [];
  for (let d = start; d.getTime() <= end.getTime(); d = addMonths(d, 1)) out.push(ym(d));
  return out;
}

/** Agent kind for one usage row (§6): a `run_id` means the row was written by
 *  a workflow agent, a bare `agent_id` (no run_id) a Task subagent, neither a
 *  main-session message. (No row has a run_id without an agent_id.) */
export function kindOf(runId: unknown, agentId: unknown): Kind {
  if (runId != null) return "workflow";
  if (agentId != null) return "subagent";
  return "main";
}

/** Sum of `cost_usd`-shaped rows, null-aware: an EMPTY slice (no usage rows at
 *  all in that window) is a true `0` -- nothing happened, which is not the
 *  same as "something happened but we don't know its price". A non-empty
 *  slice where every row is unpriced is `null`; a mix sums just the priced
 *  rows (partial totals are always shown, never silently dropped). This is
 *  the one rule every grouped Usd figure below follows. */
function sumCost(rows: { cost: number | null }[]): Usd {
  if (rows.length === 0) return 0;
  let sum = 0;
  let any = false;
  for (const r of rows) {
    if (r.cost != null) {
      sum += r.cost;
      any = true;
    }
  }
  return any ? sum : null;
}

export interface TokenClassUsd {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  unpriced: boolean;
}

/** The four spend classes for one bucket of raw token counts, at `rate`.
 *  `rate: null` (the model has no price today) contributes 0 to every class
 *  and is flagged `unpriced` -- mirrors `cost_usd IS NULL`, but recomputed
 *  fresh from `rateFor` rather than trusting the stored column, so this stays
 *  correct even a moment before the next generic reprice pass runs. */
export function tokenClassUsd(tokens: Tokens, rate: Rate | null): TokenClassUsd {
  if (!rate) return { inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0, unpriced: true };
  return {
    inputUsd: (tokens.input * rate.input) / 1e6,
    outputUsd: (tokens.output * rate.output) / 1e6,
    cacheReadUsd: (tokens.cache_read * rate.cacheRead) / 1e6,
    cacheWriteUsd: (tokens.cache_create_5m * rate.cacheWrite5m + tokens.cache_create_1h * rate.cacheWrite1h) / 1e6,
    unpriced: false,
  };
}

/** MTD + trailing-7-day-rate * days remaining in the local month; `null` on
 *  the first two days of a month (too little signal) or when neither figure
 *  is priced at all. */
export function projection(now: number, mtdUsd: Usd, trailing7dUsd: Usd): Usd {
  const d = new Date(now);
  if (d.getDate() <= 2) return null;
  if (mtdUsd == null && trailing7dUsd == null) return null;
  const end = endOfMonthExclusive(d).getTime();
  const daysRemaining = (end - now) / DAY_MS;
  return (mtdUsd ?? 0) + ((trailing7dUsd ?? 0) / 7) * daysRemaining;
}

/** Prior month's spend from its own start through the same day-of-month and
 *  time-of-day as `now`, clamped to the prior month's own end (so 31 Mar
 *  compares against all of a 28-day February, not an overflowed March 3rd).
 *  `rows` is any `{hb, cost}` slice covering at least the prior month (R1's
 *  full row set in production; a synthetic slice in tests). */
export function samePointPrevMonth(rows: { hb: string; cost: number | null }[], now: number): Usd {
  const d = new Date(now);
  const prevMonthStart = addMonths(startOfMonth(d), -1);
  const curMonthStart = startOfMonth(d);
  let target = new Date(prevMonthStart.getFullYear(), prevMonthStart.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
  let clamped = false;
  if (target.getTime() >= curMonthStart.getTime() || target.getMonth() !== prevMonthStart.getMonth()) {
    target = curMonthStart; // shorter previous month: clamp to its own end
    clamped = true;
  }
  const lo = hbOf(prevMonthStart);
  const hi = hbOf(target);
  // Clamped and un-clamped use different inclusivity on purpose. Un-clamped,
  // `target` is really "now, projected onto last month" and its whole hour
  // bucket belongs inside the window (the hour-level approximation §7 signs
  // off on). Clamped, `target` IS `curMonthStart` -- the first instant of
  // THIS month -- so an inclusive `<=` would pull THIS month's 00:00 hour
  // bucket into a sum that is supposed to be "all of last month" (reviewer
  // finding: a Sep-01 00:00 row leaking into an Aug figure).
  const inWindow = clamped ? rows.filter((r) => r.hb >= lo && r.hb < hi) : rows.filter((r) => r.hb >= lo && r.hb <= hi);
  return sumCost(inWindow);
}

/** Exact (not hour-bucketed) `SUM(cost_usd)` over `[loMs, hiMs)`, straight off
 *  the indexed `usage.at` column -- used only for `trailing7dUsd`, where R1's
 *  hour-bucket approximation (fine for every chart, §7) measurably overcounts
 *  by pulling in the WHOLE starting hour bucket even though only part of it
 *  falls in the trailing window (reviewer finding: +$52 / +3% on a live copy,
 *  which then skews the projected-month-end KPI). Same null-aware convention
 *  as `sumCost`: a truly empty window is `0`, an all-unpriced one is `null`. */
export function queryCostRange(db: Database, loMs: number, hiMs: number): Usd {
  const row = db.query(`SELECT SUM(cost_usd) AS sum, COUNT(*) AS n FROM usage WHERE at >= $lo AND at < $hi`).get({ $lo: loMs, $hi: hiMs }) as {
    sum: number | null;
    n: number;
  };
  if (row.n === 0) return 0;
  return row.sum;
}

/** Longest run and current run of consecutive local calendar days, over a
 *  SORTED, distinct list of "YYYY-MM-DD" strings that had any usage.
 *  `todayLocal` is the caller's own "YYYY-MM-DD" for `now` (kept as a
 *  parameter so this stays pure/testable with no Date math inside). */
export function streaks(
  activeDaysSorted: string[],
  todayLocal: string
): { longest: { from: string; to: string; days: number } | null; current: number } {
  if (activeDaysSorted.length === 0) return { longest: null, current: 0 };
  const toDayNum = (s: string): number => {
    const [y, m, dd] = s.split("-").map(Number);
    return Math.round(Date.UTC(y, m - 1, dd) / DAY_MS);
  };
  const nums = activeDaysSorted.map(toDayNum);
  let bestStart = 0;
  let bestLen = 1;
  let curStart = 0;
  let curLen = 1;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === nums[i - 1] + 1) curLen++;
    else {
      curStart = i;
      curLen = 1;
    }
    if (curLen > bestLen) {
      bestLen = curLen;
      bestStart = curStart;
    }
  }
  const longest = { from: activeDaysSorted[bestStart], to: activeDaysSorted[bestStart + bestLen - 1], days: bestLen };

  const todayNum = toDayNum(todayLocal);
  const lastNum = nums[nums.length - 1];
  let current = 0;
  if (lastNum === todayNum || lastNum === todayNum - 1) {
    let len = 1;
    for (let i = nums.length - 1; i > 0 && nums[i] - nums[i - 1] === 1; i--) len++;
    current = len;
  }
  return { longest, current };
}

// ---------------------------------------------------------------------------
// Row shapes straight off the DB (§7's R1/R2/R4/R5/R7/R8).
// ---------------------------------------------------------------------------

interface R1Row {
  hb: string;
  model: string;
  project: string;
  harness: string;
  kind: number; // 0 main, 1 subagent, 2 workflow
  cost: number | null;
  unpriced_rows: number;
  unpriced_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_5m_tokens: number;
  cache_create_1h_tokens: number;
  messages: number;
}

function queryR1(db: Database): R1Row[] {
  return db
    .query(
      `SELECT
         strftime('%Y-%m-%d %H', at/1000, 'unixepoch', 'localtime') AS hb,
         model,
         COALESCE(project, '(no project)') AS project,
         COALESCE(harness, 'claude') AS harness,
         CASE WHEN run_id IS NOT NULL THEN 2 WHEN agent_id IS NOT NULL THEN 1 ELSE 0 END AS kind,
         SUM(cost_usd) AS cost,
         SUM(cost_usd IS NULL) AS unpriced_rows,
         SUM(CASE WHEN cost_usd IS NULL THEN ${TOKEN_SUM_SQL} ELSE 0 END) AS unpriced_tokens,
         SUM(input_tokens) AS input_tokens,
         SUM(output_tokens) AS output_tokens,
         SUM(cache_read_tokens) AS cache_read_tokens,
         SUM(cache_create_5m_tokens) AS cache_create_5m_tokens,
         SUM(cache_create_1h_tokens) AS cache_create_1h_tokens,
         COUNT(*) AS messages
       FROM usage
       GROUP BY hb, model, project, harness, kind`
    )
    .all() as R1Row[];
}

interface R2Row {
  d: string;
  p: string;
  session_id: string;
  cost: number | null;
  unpriced_tokens: number;
  messages: number;
}

function queryR2(db: Database): R2Row[] {
  return db
    .query(
      `SELECT
         strftime('%Y-%m-%d', at/1000, 'unixepoch', 'localtime') AS d,
         COALESCE(project, '(no project)') AS p,
         session_id,
         SUM(cost_usd) AS cost,
         SUM(CASE WHEN cost_usd IS NULL THEN ${TOKEN_SUM_SQL} ELSE 0 END) AS unpriced_tokens,
         COUNT(*) AS messages
       FROM usage
       GROUP BY d, p, session_id`
    )
    .all() as R2Row[];
}

interface R4Row {
  k: number;
  a: number;
}

function queryR4(db: Database): R4Row[] {
  return db.query(`SELECT at/900000 AS k, COUNT(DISTINCT COALESCE(agent_id, session_id)) AS a FROM usage GROUP BY k`).all() as R4Row[];
}

interface R5Row {
  m: string;
  session_id: string;
  union_ms: number;
  session_ms: number;
  session_min_at: number;
  session_max_at: number;
}

function queryR5(db: Database): R5Row[] {
  return db
    .query(
      `WITH g AS (
         SELECT session_id, at,
                LAG(at) OVER (ORDER BY at) p,
                LAG(at) OVER (PARTITION BY session_id ORDER BY at) sp,
                MIN(at) OVER (PARTITION BY session_id) mn,
                MAX(at) OVER (PARTITION BY session_id) mx
         FROM usage WHERE agent_id IS NULL
       )
       SELECT strftime('%Y-%m', at/1000, 'unixepoch', 'localtime') AS m, session_id,
              SUM(CASE WHEN at - p < ${THIRTY_MIN_MS} THEN at - p ELSE 0 END) AS union_ms,
              SUM(CASE WHEN at - sp < ${THIRTY_MIN_MS} THEN at - sp ELSE 0 END) AS session_ms,
              MIN(mn) AS session_min_at, MAX(mx) AS session_max_at
       FROM g GROUP BY m, session_id`
    )
    .all() as R5Row[];
}

interface R7Row {
  run_id: string;
  name: string | null;
  status: string | null;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  agent_count: number | null;
  cost: number | null;
  output_tokens: number | null;
}

function queryR7(db: Database): R7Row[] {
  return db
    .query(
      `SELECT r.run_id, r.name, r.status, r.started_at, r.ended_at, r.duration_ms, r.agent_count,
              u.cost AS cost, u.output_tokens AS output_tokens
       FROM workflow_runs r
       LEFT JOIN (
         SELECT run_id, SUM(cost_usd) AS cost, SUM(output_tokens) AS output_tokens
         FROM usage WHERE run_id IS NOT NULL GROUP BY run_id
       ) u ON u.run_id = r.run_id`
    )
    .all() as R7Row[];
}

function queryR8(db: Database): number {
  return (db.query(`SELECT COUNT(*) AS c FROM workflow_agents`).get() as { c: number }).c;
}

function queryBounds(db: Database): { firstAt: number | null; lastAt: number | null } {
  const row = db.query(`SELECT MIN(at) AS mn, MAX(at) AS mx FROM usage`).get() as { mn: number | null; mx: number | null };
  return { firstAt: row.mn, lastAt: row.mx };
}

// ---------------------------------------------------------------------------
// Small accumulator used throughout the folds below.
// ---------------------------------------------------------------------------

class Acc {
  cost = 0;
  sawPriced = false;
  sawAny = false;
  tokens = 0;
  outputTokens = 0;
  messages = 0;
  add(row: { cost: number | null; tokens?: number; outputTokens?: number; messages?: number }): void {
    this.sawAny = true;
    if (row.cost != null) {
      this.cost += row.cost;
      this.sawPriced = true;
    }
    this.tokens += row.tokens ?? 0;
    this.outputTokens += row.outputTokens ?? 0;
    this.messages += row.messages ?? 0;
  }
  get usd(): Usd {
    if (!this.sawAny) return 0;
    return this.sawPriced ? this.cost : null;
  }
}

/** Pure compute: the whole `/api/insights` payload from a live DB handle and
 *  `now`. Called through `Store.insights()`'s memoization -- this function
 *  itself never caches anything. */
export function computeInsights(db: Database, now: number): InsightsResponse {
  const r1 = queryR1(db);
  const r2 = queryR2(db);
  const r4 = queryR4(db);
  const r5 = queryR5(db);
  const r7 = queryR7(db);
  const workflowAgents = queryR8(db);
  const { firstAt, lastAt } = queryBounds(db);

  const months = continuousMonths(firstAt, now);
  const currentMonth = ym(new Date(now));
  const nowLocalDay = ymd(new Date(now));

  // ---- R1 rollups --------------------------------------------------------
  const tokenSum = (r: R1Row) => r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_create_5m_tokens + r.cache_create_1h_tokens;
  const cacheWriteSum = (r: R1Row) => r.cache_create_5m_tokens + r.cache_create_1h_tokens;

  const lifetime = new Acc();
  const byHarnessAcc = new Map<string, Acc>();
  const byMonthModelAcc = new Map<string, Acc & { model: string; unpriced: number }>();
  const byMonthKindAcc = new Map<string, Acc>();
  const byModelAcc = new Map<string, Acc>();
  const byModelTokensAcc = new Map<string, Tokens>();
  const monthTokensByModel = new Map<string, Map<string, Tokens>>(); // month -> model -> Tokens
  let inputTokens = 0;
  let outputTokensTotal = 0;
  let cacheReadTokensTotal = 0;
  let cacheWriteTokensTotal = 0;
  let unpricedRows = 0;
  let unpricedTokensTotal = 0;

  for (const r of r1) {
    const tok = tokenSum(r);
    lifetime.add({ cost: r.cost, tokens: tok, outputTokens: r.output_tokens, messages: r.messages });
    inputTokens += r.input_tokens;
    outputTokensTotal += r.output_tokens;
    cacheReadTokensTotal += r.cache_read_tokens;
    cacheWriteTokensTotal += cacheWriteSum(r);
    unpricedRows += r.unpriced_rows;
    unpricedTokensTotal += r.unpriced_tokens;

    const harnessAcc = byHarnessAcc.get(r.harness) ?? new Acc();
    harnessAcc.add({ cost: r.cost, tokens: tok });
    byHarnessAcc.set(r.harness, harnessAcc);

    const month = r.hb.slice(0, 7);
    const mmKey = `${month}\u0000${r.model}`;
    const mmAcc = byMonthModelAcc.get(mmKey) ?? Object.assign(new Acc(), { model: r.model, unpriced: 0 });
    mmAcc.add({ cost: r.cost, tokens: tok, outputTokens: r.output_tokens });
    mmAcc.unpriced += r.unpriced_tokens;
    byMonthModelAcc.set(mmKey, mmAcc);

    const mkKey = `${month}\u0000${r.kind}`;
    const mkAcc = byMonthKindAcc.get(mkKey) ?? new Acc();
    mkAcc.add({ cost: r.cost, outputTokens: r.output_tokens });
    byMonthKindAcc.set(mkKey, mkAcc);

    const modAcc = byModelAcc.get(r.model) ?? new Acc();
    modAcc.add({ cost: r.cost, outputTokens: r.output_tokens });
    byModelAcc.set(r.model, modAcc);

    const modTok = byModelTokensAcc.get(r.model) ?? { input: 0, output: 0, cache_read: 0, cache_create_5m: 0, cache_create_1h: 0 };
    modTok.input += r.input_tokens;
    modTok.output += r.output_tokens;
    modTok.cache_read += r.cache_read_tokens;
    modTok.cache_create_5m += r.cache_create_5m_tokens;
    modTok.cache_create_1h += r.cache_create_1h_tokens;
    byModelTokensAcc.set(r.model, modTok);

    let byModelThisMonth = monthTokensByModel.get(month);
    if (!byModelThisMonth) {
      byModelThisMonth = new Map();
      monthTokensByModel.set(month, byModelThisMonth);
    }
    const mtok = byModelThisMonth.get(r.model) ?? { input: 0, output: 0, cache_read: 0, cache_create_5m: 0, cache_create_1h: 0 };
    mtok.input += r.input_tokens;
    mtok.output += r.output_tokens;
    mtok.cache_read += r.cache_read_tokens;
    mtok.cache_create_5m += r.cache_create_5m_tokens;
    mtok.cache_create_1h += r.cache_create_1h_tokens;
    byModelThisMonth.set(r.model, mtok);
  }

  const byHarness = [...byHarnessAcc.entries()]
    .map(([harness, acc]) => ({ harness, costUsd: acc.usd, tokens: acc.tokens }))
    .sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0));

  const byMonthModel: ByMonthModel[] = [...byMonthModelAcc.entries()].map(([key, acc]) => {
    const [month] = key.split("\u0000");
    return {
      month,
      model: acc.model,
      family: familyOf(acc.model),
      costUsd: acc.usd,
      tokens: acc.tokens,
      outputTokens: acc.outputTokens,
      unpricedTokens: acc.unpriced,
    };
  });

  const KIND_ORDER: Kind[] = ["main", "subagent", "workflow"];
  const byMonthKind: ByMonthKind[] = [];
  for (const month of months) {
    for (let k = 0; k < 3; k++) {
      const acc = byMonthKindAcc.get(`${month}\u0000${k}`);
      byMonthKind.push({
        month,
        kind: KIND_ORDER[k],
        costUsd: acc ? acc.usd : 0,
        outputTokens: acc ? acc.outputTokens : 0,
      });
    }
  }

  // ---- token classes, month x class and lifetime-per-model ---------------
  const byMonthTokenClass: ByMonthTokenClass[] = months.map((month) => {
    const byModel = monthTokensByModel.get(month);
    let inputUsd = 0, outputUsd = 0, cacheReadUsd = 0, cacheWriteUsd = 0, unpricedTokens = 0;
    let inTok = 0, outTok = 0, crTok = 0, c5Tok = 0, c1Tok = 0;
    if (byModel) {
      for (const [model, tok] of byModel) {
        inTok += tok.input;
        outTok += tok.output;
        crTok += tok.cache_read;
        c5Tok += tok.cache_create_5m;
        c1Tok += tok.cache_create_1h;
        const cls = tokenClassUsd(tok, rateFor(model));
        if (cls.unpriced) {
          unpricedTokens += tok.input + tok.output + tok.cache_read + tok.cache_create_5m + tok.cache_create_1h;
        } else {
          inputUsd += cls.inputUsd;
          outputUsd += cls.outputUsd;
          cacheReadUsd += cls.cacheReadUsd;
          cacheWriteUsd += cls.cacheWriteUsd;
        }
      }
    }
    return {
      month,
      inputUsd,
      outputUsd,
      cacheReadUsd,
      cacheWriteUsd,
      inputTokens: inTok,
      outputTokens: outTok,
      cacheReadTokens: crTok,
      cacheWrite5mTokens: c5Tok,
      cacheWrite1hTokens: c1Tok,
      unpricedTokens,
    };
  });

  // ---- models[] (C8) -------------------------------------------------------
  const thirtyDaysAgo = hbOf(new Date(now - 30 * DAY_MS));
  const nowHb = hbOf(new Date(now));
  const models: InsightsModel[] = [];
  for (const [model, acc] of byModelAcc) {
    if (acc.outputTokens < 1_000_000) continue;
    const tok = byModelTokensAcc.get(model)!;
    const cls = tokenClassUsd(tok, rateFor(model));
    const cacheUsd = cls.cacheReadUsd + cls.cacheWriteUsd;
    const window30 = r1.filter((r) => r.model === model && r.hb >= thirtyDaysAgo && r.hb <= nowHb);
    const costUsd30d = sumCost(window30);
    const outputTokens30d = window30.reduce((s, r) => s + r.output_tokens, 0);
    models.push({
      model,
      family: familyOf(model),
      costUsd: acc.usd,
      outputTokens: acc.outputTokens,
      cacheUsd,
      listOutputRate: rateFor(model)?.output ?? null,
      costUsd30d,
      outputTokens30d,
    });
  }
  models.sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));

  // ---- KPI ----------------------------------------------------------------
  const mtdRows = r1.filter((r) => r.hb.slice(0, 7) === currentMonth);
  const prevMonth = ym(addMonths(startOfMonth(new Date(now)), -1));
  const prevMonthRows = r1.filter((r) => r.hb.slice(0, 7) === prevMonth);

  const mtdUsd = sumCost(mtdRows);
  const prevMonthUsd = sumCost(prevMonthRows);
  // Exact to the second (queryCostRange), not R1's hour buckets -- this feeds
  // the projected-month-end KPI directly, so its precision matters more than
  // the chart-level figures the hour-bucket approximation was designed for.
  const trailing7dUsd = queryCostRange(db, now - 7 * DAY_MS, now);
  const prevMonthSamePointUsd = samePointPrevMonth(
    r1.map((r) => ({ hb: r.hb, cost: r.cost })),
    now
  );
  const projectedMonthEndUsd = projection(now, mtdUsd, trailing7dUsd);

  const cacheDenom = inputTokens + cacheReadTokensTotal + cacheWriteTokensTotal;
  const cacheHitRate = cacheDenom > 0 ? cacheReadTokensTotal / cacheDenom : 0;
  let cacheSavingsUsdEst = 0;
  for (const [model, tok] of byModelTokensAcc) {
    const rate = rateFor(model);
    if (!rate) continue;
    cacheSavingsUsdEst += (tok.cache_read * (rate.input - rate.cacheRead)) / 1e6;
  }

  // ---- R2 rollups: days / projects / sessions -----------------------------
  const dayAcc = new Map<string, Acc & { sessions: Set<string> }>();
  const dayProjectAcc = new Map<string, Acc>(); // `${day}\0${project}`
  const projectMonthAcc = new Map<string, Acc & { sessions: Set<string>; days: Set<string> }>(); // `${project}\0${month}`
  const projectLifetimeAcc = new Map<string, Acc>();
  // Lifetime distinct sessions per project, kept SEPARATELY from
  // `projectMonthAcc`'s per-month Sets: a session that sends usage in two
  // different months (the common case for anything long-running) has a row
  // in each month's Set, so summing `pm.sessions.size` across months double-
  // counts it at the lifetime level (reviewer finding, e.g. 52 API vs 51
  // actual distinct sessions for one project). A dedicated lifetime Set,
  // unioned once per project, counts it exactly once.
  const projectSessionsAcc = new Map<string, Set<string>>();
  const sessionProjectMessages = new Map<string, Map<string, number>>(); // session -> project -> messages
  const allProjects = new Set<string>();
  const allSessions = new Set<string>();

  for (const r of r2) {
    allSessions.add(r.session_id);
    if (r.p !== "(no project)") allProjects.add(r.p);

    const d = dayAcc.get(r.d) ?? Object.assign(new Acc(), { sessions: new Set<string>() });
    d.add({ cost: r.cost, messages: r.messages });
    d.sessions.add(r.session_id);
    dayAcc.set(r.d, d);

    const dpKey = `${r.d}\u0000${r.p}`;
    const dp = dayProjectAcc.get(dpKey) ?? new Acc();
    dp.add({ cost: r.cost, messages: r.messages });
    dayProjectAcc.set(dpKey, dp);

    const month = r.d.slice(0, 7);
    const pmKey = `${r.p}\u0000${month}`;
    const pm = projectMonthAcc.get(pmKey) ?? Object.assign(new Acc(), { sessions: new Set<string>(), days: new Set<string>() });
    pm.add({ cost: r.cost });
    pm.sessions.add(r.session_id);
    pm.days.add(r.d);
    projectMonthAcc.set(pmKey, pm);

    const pl = projectLifetimeAcc.get(r.p) ?? new Acc();
    pl.add({ cost: r.cost });
    projectLifetimeAcc.set(r.p, pl);

    const ps = projectSessionsAcc.get(r.p) ?? new Set<string>();
    ps.add(r.session_id);
    projectSessionsAcc.set(r.p, ps);

    let bySess = sessionProjectMessages.get(r.session_id);
    if (!bySess) {
      bySess = new Map();
      sessionProjectMessages.set(r.session_id, bySess);
    }
    bySess.set(r.p, (bySess.get(r.p) ?? 0) + r.messages);
  }

  // per-day top project: one pass over dayProjectAcc (not one scan of the
  // whole map PER day -- that was an accidental O(days x entries) scan here
  // before, easily the biggest single cost in this function on the 76k-row
  // production copy since dayProjectAcc has one entry per (day, project)).
  const topProjectByDay = new Map<string, { project: string | null; score: number }>();
  for (const [key, acc] of dayProjectAcc) {
    const [day, project] = key.split("\u0000");
    // A priced group's $ amount is always >= 0, so an unpriced-but-active
    // group (-1) only ever wins the day when it's the sole candidate.
    const score = acc.usd ?? -1;
    const best = topProjectByDay.get(day);
    if (!best || score > best.score) topProjectByDay.set(day, { project, score });
  }

  // per-day peak concurrent agents, from R4's 15-minute buckets.
  const dayPeakAgents = new Map<string, number>();
  let peakAgents = 0;
  let peakBucketK = -1;
  for (const row of r4) {
    const at = row.k * 900_000;
    const day = ymd(new Date(at));
    dayPeakAgents.set(day, Math.max(dayPeakAgents.get(day) ?? 0, row.a));
    if (row.a > peakAgents) {
      peakAgents = row.a;
      peakBucketK = row.k;
    }
  }

  const days: InsightsDay[] = [...dayAcc.entries()]
    .map(([day, acc]) => ({
      day,
      costUsd: acc.usd,
      messages: acc.messages,
      sessions: acc.sessions.size,
      topProject: topProjectByDay.get(day)?.project ?? null,
      peakAgents: dayPeakAgents.get(day) ?? 0,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const activeDaySet = days.map((d) => d.day);

  // ---- weekHour (C10) + weekdayCounts --------------------------------------
  const dayHourCost = new Map<string, Acc>(); // `${day}\0${hour}`
  for (const r of r1) {
    const day = r.hb.slice(0, 10);
    const hour = r.hb.slice(11, 13);
    const key = `${day}\u0000${hour}`;
    const acc = dayHourCost.get(key) ?? new Acc();
    acc.add({ cost: r.cost });
    dayHourCost.set(key, acc);
  }
  const weekHourAcc = new Map<string, { activeDays: number; costUsd: Usd; rows: { cost: number | null }[] }>();
  for (const [key, acc] of dayHourCost) {
    const [day, hourStr] = key.split("\u0000");
    const [y, m, dd] = day.split("-").map(Number);
    const weekday = mondayFirstWeekday(new Date(y, m - 1, dd));
    const hour = Number(hourStr);
    const whKey = `${weekday}\u0000${hour}`;
    const existing = weekHourAcc.get(whKey) ?? { activeDays: 0, costUsd: 0 as Usd, rows: [] as { cost: number | null }[] };
    existing.activeDays += 1;
    existing.rows.push({ cost: acc.usd });
    weekHourAcc.set(whKey, existing);
  }
  const weekHour: WeekHourCell[] = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let hour = 0; hour < 24; hour++) {
      const cell = weekHourAcc.get(`${weekday}\u0000${hour}`);
      weekHour.push({
        weekday,
        hour,
        activeDays: cell?.activeDays ?? 0,
        costUsd: cell ? sumCost(cell.rows) : 0,
      });
    }
  }
  const weekdayCounts = [0, 0, 0, 0, 0, 0, 0];
  if (firstAt != null) {
    const first = new Date(firstAt);
    first.setHours(0, 0, 0, 0);
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    // Step by calendar day via `setDate`, not by adding a fixed 24h in ms: a
    // local midnight plus DAY_MS lands on a DST-transition day at 23:00 or
    // 01:00 local, not the next midnight, which silently drops or double-
    // counts one weekday once a year (reviewer finding: Saturday read 31
    // instead of 32 after a spring-forward). `setDate` always normalizes back
    // to local midnight of the intended calendar day.
    for (const d = new Date(first); d.getTime() <= today.getTime(); d.setDate(d.getDate() + 1)) {
      weekdayCounts[mondayFirstWeekday(d)]++;
    }
  }

  // ---- R5: activity (C11) + longest main session (records) ---------------
  const activityByMonth = new Map<string, number>();
  const sessionActiveMs = new Map<string, number>();
  const sessionBounds = new Map<string, { min: number; max: number }>();
  for (const r of r5) {
    activityByMonth.set(r.m, (activityByMonth.get(r.m) ?? 0) + r.union_ms);
    sessionActiveMs.set(r.session_id, (sessionActiveMs.get(r.session_id) ?? 0) + r.session_ms);
    sessionBounds.set(r.session_id, { min: r.session_min_at, max: r.session_max_at });
  }
  const activity: InsightsActivity[] = months.map((month) => ({ month, activeMs: activityByMonth.get(month) ?? 0 }));

  let longestSession: InsightsRecords["longestSession"] = null;
  let bestActiveMs = -1;
  for (const [sessionId, activeMs] of sessionActiveMs) {
    if (activeMs > bestActiveMs) {
      bestActiveMs = activeMs;
      const bounds = sessionBounds.get(sessionId)!;
      const projMap = sessionProjectMessages.get(sessionId);
      let project: string | null = null;
      if (projMap) {
        let best = -1;
        for (const [p, msgs] of projMap) {
          if (msgs > best) {
            best = msgs;
            project = p === "(no project)" ? null : p;
          }
        }
      }
      longestSession = {
        sessionId,
        project,
        activeMs,
        wallMs: bounds.max - bounds.min,
        startedAt: bounds.min,
      };
    }
  }

  // ---- projects[] (C12) ----------------------------------------------------
  const projectRank = [...projectLifetimeAcc.entries()]
    .filter(([p]) => p !== "(no project)")
    .sort((a, b) => (b[1].usd ?? 0) - (a[1].usd ?? 0));
  const top10 = new Set(projectRank.slice(0, 10).map(([p]) => p));
  const others = projectRank.slice(10).map(([p]) => p);

  function byMonthFor(project: string): Record<string, { costUsd: Usd; sessions: number }> {
    const out: Record<string, { costUsd: Usd; sessions: number }> = {};
    for (const month of months) {
      const pm = projectMonthAcc.get(`${project}\u0000${month}`);
      if (pm) out[month] = { costUsd: pm.usd, sessions: pm.sessions.size };
    }
    return out;
  }

  const projects: InsightsProject[] = [];
  for (const [p] of projectRank) {
    if (!top10.has(p)) continue;
    const lifetime = projectLifetimeAcc.get(p)!;
    let activeDaysCount = 0;
    for (const month of months) {
      const pm = projectMonthAcc.get(`${p}\u0000${month}`);
      if (pm) activeDaysCount += pm.days.size;
    }
    const sessions = projectSessionsAcc.get(p)?.size ?? 0;
    projects.push({ project: p, kind: "project", lifetimeUsd: lifetime.usd, sessions, activeDays: activeDaysCount, byMonth: byMonthFor(p) });
  }
  if (others.length > 0) {
    let activeDaysCount = 0;
    const byMonth: Record<string, { costUsd: Usd; sessions: number }> = {};
    const rowsAll: { cost: number | null }[] = [];
    const otherSessions = new Set<string>();
    for (const month of months) {
      let acc = new Acc();
      let sess = new Set<string>();
      let daysSet = new Set<string>();
      for (const p of others) {
        const pm = projectMonthAcc.get(`${p}\u0000${month}`);
        if (pm) {
          acc.add({ cost: pm.usd });
          for (const s of pm.sessions) sess.add(s);
          for (const dd of pm.days) daysSet.add(dd);
        }
      }
      if (acc.sawAny) byMonth[month] = { costUsd: acc.usd, sessions: sess.size };
      activeDaysCount += daysSet.size;
    }
    for (const p of others) {
      rowsAll.push({ cost: projectLifetimeAcc.get(p)!.usd });
      for (const sid of projectSessionsAcc.get(p) ?? []) otherSessions.add(sid);
    }
    projects.push({
      project: `Other ${others.length} projects`,
      kind: "other",
      lifetimeUsd: sumCost(rowsAll),
      sessions: otherSessions.size,
      activeDays: activeDaysCount,
      byMonth,
    });
  }
  if (projectLifetimeAcc.has("(no project)")) {
    const p = "(no project)";
    let activeDaysCount = 0;
    for (const month of months) {
      const pm = projectMonthAcc.get(`${p}\u0000${month}`);
      if (pm) activeDaysCount += pm.days.size;
    }
    projects.push({
      project: "(no project)",
      kind: "none",
      lifetimeUsd: projectLifetimeAcc.get(p)!.usd,
      sessions: projectSessionsAcc.get(p)?.size ?? 0,
      activeDays: activeDaysCount,
      byMonth: byMonthFor(p),
    });
  }

  // ---- workflow runs (R7) + records ----------------------------------------
  let workflowRuns: InsightsWorkflowRun[] = r7.map((r) => ({
    runId: r.run_id,
    name: r.name,
    status: r.status,
    startedAt: r.started_at,
    month: r.started_at != null ? ym(new Date(r.started_at)) : null,
    agentCount: r.agent_count,
    durationMs: r.duration_ms,
    costUsd: r.cost,
    outputTokens: r.output_tokens ?? 0,
  }));
  let truncated: boolean | undefined;
  if (workflowRuns.length > WORKFLOW_RUN_CAP) {
    const byCostDesc = [...workflowRuns].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0)).slice(0, 10);
    const recent = [...workflowRuns].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).slice(0, WORKFLOW_RUN_CAP);
    const kept = new Map<string, InsightsWorkflowRun>();
    for (const r of [...recent, ...byCostDesc]) kept.set(r.runId, r);
    workflowRuns = [...kept.values()];
    truncated = true;
  }

  let priciestRun: InsightsRecords["priciestRun"] = null;
  for (const r of workflowRuns) {
    if (r.costUsd == null) continue;
    if (!priciestRun || r.costUsd > priciestRun.costUsd) {
      priciestRun = { runId: r.runId, name: r.name, costUsd: r.costUsd, agentCount: r.agentCount, startedAt: r.startedAt };
    }
  }

  let peakAgentsRecord: InsightsRecords["peakAgents"] = null;
  if (peakBucketK >= 0) {
    const lo = peakBucketK * 900_000;
    const hi = lo + 900_000;
    const dominant = db
      .query(
        `SELECT run_id, COUNT(*) AS c FROM usage WHERE at >= $lo AND at < $hi AND run_id IS NOT NULL
         GROUP BY run_id ORDER BY c DESC LIMIT 1`
      )
      .get({ $lo: lo, $hi: hi }) as { run_id: string; c: number } | null;
    const runName = dominant ? workflowRuns.find((r) => r.runId === dominant.run_id)?.name ?? null : null;
    peakAgentsRecord = { at: lo, agents: peakAgents, runId: dominant?.run_id ?? null, runName };
  }

  let biggestDay: InsightsRecords["biggestDay"] = null;
  for (const d of days) {
    if (d.costUsd == null) continue;
    if (!biggestDay || d.costUsd > biggestDay.costUsd) biggestDay = { day: d.day, costUsd: d.costUsd, messages: d.messages };
  }

  const { longest, current } = streaks(activeDaySet, nowLocalDay);

  const kpi: InsightsKpi = {
    lifetimeUsd: lifetime.usd,
    lifetimeTokens: lifetime.tokens,
    inputTokens,
    outputTokens: outputTokensTotal,
    cacheReadTokens: cacheReadTokensTotal,
    cacheWriteTokens: cacheWriteTokensTotal,
    messages: lifetime.messages,
    sessions: allSessions.size,
    projects: allProjects.size,
    activeDays: days.length,
    workflowRuns: r7.length,
    workflowAgents,
    byHarness,
    mtdUsd,
    prevMonthUsd,
    prevMonthSamePointUsd,
    trailing7dUsd,
    projectedMonthEndUsd,
    cacheHitRate,
    cacheSavingsUsdEst,
  };

  const records: InsightsRecords = {
    biggestDay,
    longestStreak: longest,
    currentStreakDays: current,
    peakAgents: peakAgentsRecord,
    priciestRun,
    longestSession,
  };

  return {
    meta: {
      generatedAt: now,
      computeMs: 0, // filled in by Store.insights()
      stale: false,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      firstAt,
      lastAt,
      usageRows: r1.reduce((s, r) => s + r.messages, 0),
      unpricedRows,
      unpricedTokens: unpricedTokensTotal,
    },
    months,
    currentMonth,
    kpi,
    records,
    byMonthModel,
    byMonthTokenClass,
    byMonthKind,
    days,
    weekHour,
    weekdayCounts,
    activity,
    workflowRuns,
    models,
    projects,
    ...(truncated ? { truncated } : {}),
  };
}
