# Live Cost Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show per-session and board-level live cost on the dashboard, computed from session transcripts.

**Architecture:** A new `usage` SQLite table holds one priced row per assistant message, ingested by tailing each session's transcript JSONL (deduped by message uuid). Aggregations (`costSummary`) feed the existing `buildState()` / SSE push. The web app gains a per-session cost line and a sidebar cost panel.

**Tech Stack:** Bun + `bun:sqlite`, TypeScript, React 18 + Vite + Tailwind, `bun test` (backend) / Vitest + Testing Library (web).

**Spec:** `docs/superpowers/specs/2026-06-15-live-cost-tracking-design.md`

---

## File Structure

- `src/server/pricing.ts` — **new.** Pure pricing map + `costOf(model, tokens)`. Depends on nothing.
- `src/server/usage.ts` — **new.** `parseUsageLine` (pure) + `tailUsage` (reads fs, writes via store). Depends on `pricing.ts`, `store.ts` (type only).
- `src/server/db.ts` — **modify.** Add `usage` table + `sessions.usage_offset` migration.
- `src/server/store.ts` — **modify.** `recordUsage`, `setUsageOffset`, `getTailInfo`, `sessionsToTail`, `costSummary`.
- `src/server/http.ts` — **modify.** Export module-level `buildState(store)` (now incl. `cost`); tail on `stop`/`session_end`.
- `src/server/index.ts` — **modify.** Sweep tails non-ended sessions; unify broadcast to full `buildState`.
- `src/web/types.ts` — **modify.** Add `Cost` types to `State`.
- `src/web/cost.ts` — **new.** `formatUsd`, `formatTokens`, `prettyModel`.
- `src/web/components/CostPanel.tsx` — **new.** Sidebar panel.
- `src/web/components/SessionCard.tsx` — **modify.** Per-session cost line.
- `src/web/components/Board.tsx` — **modify.** Mount panel; pass cost to cards.
- `src/web/App.tsx` — **modify.** Add `cost` to initial state.
- Tests: `tests/pricing.test.ts`, `tests/usage.test.ts`, `tests/cost-store.test.ts` (new); `tests/store.test.ts` (migration test); `web-tests/cost.test.ts`, `web-tests/CostPanel.test.tsx` (new).

**Shared type contracts (used across tasks):**

```ts
// pricing.ts
export interface Tokens {
  input: number; output: number; cache_read: number;
  cache_create_5m: number; cache_create_1h: number;
}
// usage.ts
export interface ParsedUsage { uuid: string; model: string; tokens: Tokens; at: number; }
// store.ts
recordUsage(u: { uuid: string; sessionId: string; model: string; tokens: Tokens; at: number; cost: number }): boolean
setUsageOffset(id: string, offset: number): void
getTailInfo(id: string): { transcript_path: string | null; usage_offset: number } | null
sessionsToTail(): { id: string; transcript_path: string | null; usage_offset: number }[]
costSummary(midnightMs: number): {
  perSession: Record<string, { costUsd: number; tokens: number }>;
  liveTotalUsd: number; todayUsd: number;
  byModelToday: { model: string; costUsd: number }[];
}
```

---

## Task 1: DB migration — `usage` table + `sessions.usage_offset`

**Files:**
- Modify: `src/server/db.ts`
- Test: `tests/store.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test inside the `describe("Store sessions", ...)` block in `tests/store.test.ts` (after the existing `"idempotently adds the sessions.branch column"` test):

```ts
  it("idempotently creates the usage table and sessions.usage_offset column", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, project TEXT, started_at INTEGER NOT NULL DEFAULT 0, last_activity_at INTEGER NOT NULL DEFAULT 0);`);
    migrate(db);
    const hasTable = () =>
      (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='usage'").all() as unknown[]).length;
    const hasOffset = () =>
      (db.query("PRAGMA table_info(sessions)").all() as { name: string }[]).filter((c) => c.name === "usage_offset").length;
    expect(hasTable()).toBe(1);
    expect(hasOffset()).toBe(1);
    migrate(db); // second run must not throw or duplicate
    expect(hasTable()).toBe(1);
    expect(hasOffset()).toBe(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/store.test.ts`
Expected: FAIL — `expect(hasTable()).toBe(1)` receives `0` (table not yet created).

- [ ] **Step 3: Add the migration**

In `src/server/db.ts`, inside the `db.exec(\`...\`)` template in `migrate()`, add the `usage` table after the `todos` table block (before the closing `\`);`):

```sql
    CREATE TABLE IF NOT EXISTS usage (
      message_uuid TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_create_5m_tokens INTEGER NOT NULL DEFAULT 0,
      cache_create_1h_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_id);
    CREATE INDEX IF NOT EXISTS idx_usage_at ON usage(at);
```

Then, in the idempotent-column section (after the `active_tool` block), add:

```ts
  if (!sessionCols.some((c) => c.name === "usage_offset")) {
    db.exec("ALTER TABLE sessions ADD COLUMN usage_offset INTEGER NOT NULL DEFAULT 0;");
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/store.test.ts`
Expected: PASS (all store tests, including the new one).

- [ ] **Step 5: Commit**

```bash
git add src/server/db.ts tests/store.test.ts
git commit -m "feat(db): usage table + sessions.usage_offset migration"
```

---

## Task 2: Pricing — `costOf`

**Files:**
- Create: `src/server/pricing.ts`
- Test: `tests/pricing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/pricing.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { costOf, type Tokens } from "../src/server/pricing.ts";

const zero: Tokens = { input: 0, output: 0, cache_read: 0, cache_create_5m: 0, cache_create_1h: 0 };

describe("costOf", () => {
  it("prices input and output at the model's per-MTok rate", () => {
    // Opus 4.8: $5 / $25 per MTok
    const c = costOf("claude-opus-4-8", { ...zero, input: 1_000_000, output: 1_000_000 });
    expect(c).toBeCloseTo(5 + 25, 6);
  });

  it("applies cache multipliers to the input rate (read 0.1x, 5m 1.25x, 1h 2x)", () => {
    const c = costOf("claude-opus-4-8", {
      ...zero,
      cache_read: 1_000_000,
      cache_create_5m: 1_000_000,
      cache_create_1h: 1_000_000,
    });
    // 5 * (0.1 + 1.25 + 2.0)
    expect(c).toBeCloseTo(5 * 3.35, 6);
  });

  it("uses the right rate per model", () => {
    expect(costOf("claude-haiku-4-5", { ...zero, input: 1_000_000 })).toBeCloseTo(1, 6);
    expect(costOf("claude-sonnet-4-6", { ...zero, output: 1_000_000 })).toBeCloseTo(15, 6);
    expect(costOf("claude-fable-5", { ...zero, output: 1_000_000 })).toBeCloseTo(50, 6);
  });

  it("returns 0 for an unknown model", () => {
    expect(costOf("gpt-9", { ...zero, input: 1_000_000 })).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/pricing.test.ts`
Expected: FAIL — cannot resolve `../src/server/pricing.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/server/pricing.ts`:

```ts
export interface Tokens {
  input: number;
  output: number;
  cache_read: number;
  cache_create_5m: number;
  cache_create_1h: number;
}

interface Rate {
  input: number; // USD per million input tokens
  output: number; // USD per million output tokens
}

// Published list prices (USD / MTok). Keep current as models change.
const RATES: Record<string, Rate> = {
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
};

const CACHE_READ_MULT = 0.1;
const CACHE_CREATE_5M_MULT = 1.25;
const CACHE_CREATE_1H_MULT = 2.0;

const warned = new Set<string>();

/** USD cost of one message's token usage. Unknown model → 0 (warned once). */
export function costOf(model: string, t: Tokens): number {
  const rate = RATES[model];
  if (!rate) {
    if (!warned.has(model)) {
      console.warn(`[pricing] unknown model, costing $0: ${model}`);
      warned.add(model);
    }
    return 0;
  }
  const inPer = rate.input / 1e6;
  const outPer = rate.output / 1e6;
  return (
    t.input * inPer +
    t.output * outPer +
    t.cache_read * inPer * CACHE_READ_MULT +
    t.cache_create_5m * inPer * CACHE_CREATE_5M_MULT +
    t.cache_create_1h * inPer * CACHE_CREATE_1H_MULT
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/pricing.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/pricing.ts tests/pricing.test.ts
git commit -m "feat(server): pricing map + costOf"
```

---

## Task 3: `parseUsageLine`

**Files:**
- Create: `src/server/usage.ts`
- Test: `tests/usage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/usage.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { parseUsageLine } from "../src/server/usage.ts";

const assistantLine = JSON.stringify({
  type: "assistant",
  uuid: "u-1",
  timestamp: "2026-06-15T08:00:00.000Z",
  message: {
    model: "claude-opus-4-8",
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
      iterations: [{ input_tokens: 100, output_tokens: 20 }],
    },
  },
});

describe("parseUsageLine", () => {
  it("extracts uuid, model, tokens, and timestamp", () => {
    const p = parseUsageLine(assistantLine);
    expect(p).not.toBeNull();
    expect(p!.uuid).toBe("u-1");
    expect(p!.model).toBe("claude-opus-4-8");
    expect(p!.tokens).toEqual({
      input: 100, output: 20, cache_read: 1000, cache_create_5m: 100, cache_create_1h: 200,
    });
    expect(p!.at).toBe(Date.parse("2026-06-15T08:00:00.000Z"));
  });

  it("returns null for lines without usage (user / tool_result lines)", () => {
    expect(parseUsageLine(JSON.stringify({ type: "user", uuid: "x", message: { role: "user", content: "hi" } }))).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseUsageLine("{not json")).toBeNull();
  });

  it("defaults missing cache_creation split to 0", () => {
    const line = JSON.stringify({
      uuid: "u-2", timestamp: "2026-06-15T08:00:00.000Z",
      message: { model: "claude-haiku-4-5", usage: { input_tokens: 5, output_tokens: 1 } },
    });
    const p = parseUsageLine(line)!;
    expect(p.tokens).toEqual({ input: 5, output: 1, cache_read: 0, cache_create_5m: 0, cache_create_1h: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/usage.test.ts`
Expected: FAIL — cannot resolve `../src/server/usage.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/server/usage.ts`:

```ts
import { readFileSync } from "node:fs";
import type { Store } from "./store.ts";
import { costOf, type Tokens } from "./pricing.ts";

export interface ParsedUsage {
  uuid: string;
  model: string;
  tokens: Tokens;
  at: number; // epoch ms
}

/** Parse one transcript JSONL line into priced usage, or null if it carries none.
 *  Reads the top-level `message.usage` (already aggregates `iterations` — reading
 *  that array too would double-count). */
export function parseUsageLine(line: string): ParsedUsage | null {
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  const uuid = o?.uuid;
  const msg = o?.message;
  const usage = msg?.usage;
  if (typeof uuid !== "string" || !msg?.model || !usage) return null;
  const cc = usage.cache_creation ?? {};
  const tokens: Tokens = {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cache_read: usage.cache_read_input_tokens ?? 0,
    cache_create_5m: cc.ephemeral_5m_input_tokens ?? 0,
    cache_create_1h: cc.ephemeral_1h_input_tokens ?? 0,
  };
  const at = o.timestamp ? Date.parse(o.timestamp) : NaN;
  return { uuid, model: msg.model, tokens, at: Number.isFinite(at) ? at : 0 };
}
```

(Note: `tailUsage` is added in Task 6 — this task only adds `parseUsageLine`. The `readFileSync`/`Store`/`costOf` imports are used there; if your linter flags unused imports now, leave them — Task 6 uses them. If the build fails on unused imports, drop `readFileSync`, `Store`, and `costOf` from the import lines here and re-add them in Task 6.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/usage.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/usage.ts tests/usage.test.ts
git commit -m "feat(server): parseUsageLine transcript parser"
```

---

## Task 4: Store — `recordUsage`, `setUsageOffset`, `getTailInfo`, `sessionsToTail`

**Files:**
- Modify: `src/server/store.ts`
- Test: `tests/cost-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/cost-store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "bun:test";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import type { Tokens } from "../src/server/pricing.ts";

const tok = (input: number): Tokens => ({ input, output: 0, cache_read: 0, cache_create_5m: 0, cache_create_1h: 0 });

describe("Store usage rows", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(openDb(":memory:"));
  });

  it("records a usage row once per message uuid (dedup)", () => {
    const row = { uuid: "m1", sessionId: "s1", model: "claude-opus-4-8", tokens: tok(100), at: 1000, cost: 0.5 };
    expect(store.recordUsage(row)).toBe(true);
    expect(store.recordUsage(row)).toBe(false); // same uuid → ignored
    const summary = store.costSummary(0);
    expect(summary.perSession.s1.costUsd).toBeCloseTo(0.5, 6);
  });

  it("tracks and updates the per-session usage offset", () => {
    store.applyEvent("s1", { status: "working", transcript_path: "/tmp/x.jsonl", last_activity_at: 1 }, 1);
    expect(store.getTailInfo("s1")).toEqual({ transcript_path: "/tmp/x.jsonl", usage_offset: 0 });
    store.setUsageOffset("s1", 42);
    expect(store.getTailInfo("s1")!.usage_offset).toBe(42);
    expect(store.getTailInfo("nope")).toBeNull();
  });

  it("lists only non-ended sessions with a transcript for tailing", () => {
    store.applyEvent("live", { status: "working", transcript_path: "/tmp/a.jsonl", last_activity_at: 1 }, 1);
    store.applyEvent("dead", { status: "ended", transcript_path: "/tmp/b.jsonl", last_activity_at: 1 }, 1);
    store.applyEvent("notp", { status: "working", last_activity_at: 1 }, 1); // no transcript_path
    const ids = store.sessionsToTail().map((s) => s.id).sort();
    expect(ids).toEqual(["live"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cost-store.test.ts`
Expected: FAIL — `store.recordUsage is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/server/store.ts`, add the `Tokens` import to the top type import line:

```ts
import type { Session, SessionPatch, Todo, TodoStatus, CreateTodoInput, UpdateTodoInput } from "./types.ts";
import type { Tokens } from "./pricing.ts";
```

Then add these methods to the `Store` class (place them after `sweepStale`, before `createTodo`):

```ts
  recordUsage(u: {
    uuid: string;
    sessionId: string;
    model: string;
    tokens: Tokens;
    at: number;
    cost: number;
  }): boolean {
    const res = this.db
      .query(
        `INSERT OR IGNORE INTO usage
           (message_uuid, session_id, model, input_tokens, output_tokens,
            cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens, cost_usd, at)
         VALUES ($u, $s, $m, $in, $out, $cr, $c5, $c1, $cost, $at)`
      )
      .run({
        $u: u.uuid,
        $s: u.sessionId,
        $m: u.model,
        $in: u.tokens.input,
        $out: u.tokens.output,
        $cr: u.tokens.cache_read,
        $c5: u.tokens.cache_create_5m,
        $c1: u.tokens.cache_create_1h,
        $cost: u.cost,
        $at: u.at,
      });
    return res.changes > 0;
  }

  setUsageOffset(id: string, offset: number): void {
    this.db.query(`UPDATE sessions SET usage_offset = $o WHERE id = $id`).run({ $o: offset, $id: id });
  }

  getTailInfo(id: string): { transcript_path: string | null; usage_offset: number } | null {
    const row = this.db
      .query(`SELECT transcript_path, usage_offset FROM sessions WHERE id = $id`)
      .get({ $id: id });
    return (row as { transcript_path: string | null; usage_offset: number }) ?? null;
  }

  sessionsToTail(): { id: string; transcript_path: string | null; usage_offset: number }[] {
    return this.db
      .query(
        `SELECT id, transcript_path, usage_offset FROM sessions
         WHERE status != 'ended' AND transcript_path IS NOT NULL`
      )
      .all() as { id: string; transcript_path: string | null; usage_offset: number }[];
  }
```

(Note: `costSummary` is referenced by this task's first test but implemented in Task 5. To keep this task green on its own, **also add the `costSummary` method now** from Task 5 Step 3, then Task 5 only adds its tests. If you prefer strict task isolation, instead temporarily change the first test's last two lines to assert via a raw query and move the `perSession` assertion to Task 5.)

The simplest path: implement `costSummary` here too (copy from Task 5 Step 3), so both this test and Task 5's tests pass.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cost-store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/store.ts tests/cost-store.test.ts
git commit -m "feat(store): record usage rows + tail bookkeeping"
```

---

## Task 5: Store — `costSummary` aggregations

**Files:**
- Modify: `src/server/store.ts` (if not already added in Task 4)
- Test: `tests/cost-store.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/cost-store.test.ts` inside the `describe("Store usage rows", ...)` block:

```ts
  it("aggregates per-session, live (non-ended), today, and per-model", () => {
    const MIDNIGHT = 2_000_000;
    // sessions: a = working (live), b = ended
    store.applyEvent("a", { status: "working", last_activity_at: 1 }, 1);
    store.applyEvent("b", { status: "ended", last_activity_at: 1 }, 1);
    // a: opus, one row before midnight + one after
    store.recordUsage({ uuid: "a1", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: MIDNIGHT - 1, cost: 1.0 });
    store.recordUsage({ uuid: "a2", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: MIDNIGHT + 1, cost: 2.0 });
    // b (ended): haiku, after midnight
    store.recordUsage({ uuid: "b1", sessionId: "b", model: "claude-haiku-4-5", tokens: tok(0), at: MIDNIGHT + 1, cost: 4.0 });

    const s = store.costSummary(MIDNIGHT);
    expect(s.perSession.a.costUsd).toBeCloseTo(3.0, 6); // 1.0 + 2.0 lifetime
    expect(s.perSession.b.costUsd).toBeCloseTo(4.0, 6);
    expect(s.liveTotalUsd).toBeCloseTo(3.0, 6); // only session a (b is ended)
    expect(s.todayUsd).toBeCloseTo(6.0, 6); // 2.0 (a2) + 4.0 (b1), excludes a1 (before midnight)
    expect(s.byModelToday).toEqual([
      { model: "claude-haiku-4-5", costUsd: 4.0 },
      { model: "claude-opus-4-8", costUsd: 2.0 },
    ]);
  });

  it("sums all token types into perSession.tokens", () => {
    store.applyEvent("a", { status: "working", last_activity_at: 1 }, 1);
    store.recordUsage({
      uuid: "a1", sessionId: "a", model: "claude-opus-4-8",
      tokens: { input: 10, output: 20, cache_read: 30, cache_create_5m: 5, cache_create_1h: 5 },
      at: 1, cost: 0,
    });
    expect(store.costSummary(0).perSession.a.tokens).toBe(70);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cost-store.test.ts`
Expected: FAIL — `store.costSummary is not a function` (unless you already added it in Task 4, in which case it should PASS — skip to Step 4).

- [ ] **Step 3: Write the implementation**

Add the `costSummary` method to the `Store` class in `src/server/store.ts` (after `sessionsToTail`):

```ts
  costSummary(midnightMs: number): {
    perSession: Record<string, { costUsd: number; tokens: number }>;
    liveTotalUsd: number;
    todayUsd: number;
    byModelToday: { model: string; costUsd: number }[];
  } {
    const TOKENS =
      "(input_tokens + output_tokens + cache_read_tokens + cache_create_5m_tokens + cache_create_1h_tokens)";

    const per = this.db
      .query(`SELECT session_id, SUM(cost_usd) AS cost, SUM${TOKENS} AS tokens FROM usage GROUP BY session_id`)
      .all() as { session_id: string; cost: number; tokens: number }[];
    const perSession: Record<string, { costUsd: number; tokens: number }> = {};
    for (const r of per) perSession[r.session_id] = { costUsd: r.cost, tokens: r.tokens };

    const live = this.db
      .query(
        `SELECT COALESCE(SUM(u.cost_usd), 0) AS c FROM usage u
         JOIN sessions s ON s.id = u.session_id WHERE s.status != 'ended'`
      )
      .get() as { c: number };

    const today = this.db
      .query(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM usage WHERE at >= $m`)
      .get({ $m: midnightMs }) as { c: number };

    const byModel = this.db
      .query(
        `SELECT model, SUM(cost_usd) AS c FROM usage WHERE at >= $m
         GROUP BY model HAVING c > 0 ORDER BY c DESC`
      )
      .all({ $m: midnightMs }) as { model: string; c: number }[];

    return {
      perSession,
      liveTotalUsd: live.c,
      todayUsd: today.c,
      byModelToday: byModel.map((r) => ({ model: r.model, costUsd: r.c })),
    };
  }
```

Note the SQL `SUM${TOKENS}` resolves to `SUM(input_tokens + ... )`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cost-store.test.ts`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/server/store.ts tests/cost-store.test.ts
git commit -m "feat(store): costSummary aggregations"
```

---

## Task 6: `tailUsage`

**Files:**
- Modify: `src/server/usage.ts`
- Test: `tests/usage.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/usage.test.ts`. Add these imports at the top of the file:

```ts
import { tailUsage } from "../src/server/usage.ts";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import { writeFileSync, appendFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
```

Add this block at the end of the file:

```ts
function line(uuid: string, model = "claude-opus-4-8") {
  return JSON.stringify({
    uuid, timestamp: "2026-06-15T08:00:00.000Z",
    message: { model, usage: { input_tokens: 1_000_000, output_tokens: 0 } },
  }) + "\n";
}

describe("tailUsage", () => {
  it("ingests new complete lines, is idempotent, and resumes from the offset", () => {
    const dir = mkdtempSync(join(tmpdir(), "am-usage-"));
    const file = join(dir, "t.jsonl");
    writeFileSync(file, line("m1") + line("m2"));
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", transcript_path: file, last_activity_at: 1 }, 1);

    const info1 = store.getTailInfo("s1")!;
    expect(tailUsage(store, { id: "s1", ...info1 })).toBe(true);
    expect(store.costSummary(0).perSession.s1.costUsd).toBeCloseTo(10, 6); // 2 × $5 (1M input @ opus)

    // Re-tail with no new content → nothing recorded, total unchanged
    const info2 = store.getTailInfo("s1")!;
    expect(tailUsage(store, { id: "s1", ...info2 })).toBe(false);
    expect(store.costSummary(0).perSession.s1.costUsd).toBeCloseTo(10, 6);

    // Append a third line → only it is ingested
    appendFileSync(file, line("m3"));
    const info3 = store.getTailInfo("s1")!;
    expect(tailUsage(store, { id: "s1", ...info3 })).toBe(true);
    expect(store.costSummary(0).perSession.s1.costUsd).toBeCloseTo(15, 6);
  });

  it("ignores a trailing partial line until it is completed", () => {
    const dir = mkdtempSync(join(tmpdir(), "am-usage-"));
    const file = join(dir, "t.jsonl");
    writeFileSync(file, line("m1") + '{"uuid":"m2","partial'); // no trailing newline on m2
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", transcript_path: file, last_activity_at: 1 }, 1);

    tailUsage(store, { id: "s1", ...store.getTailInfo("s1")! });
    expect(store.costSummary(0).perSession.s1.costUsd).toBeCloseTo(5, 6); // only m1

    // Complete the partial line
    writeFileSync(file, line("m1") + line("m2"));
    tailUsage(store, { id: "s1", ...store.getTailInfo("s1")! });
    expect(store.costSummary(0).perSession.s1.costUsd).toBeCloseTo(10, 6); // m1 + m2
  });

  it("returns false for a missing transcript", () => {
    const store = new Store(openDb(":memory:"));
    expect(tailUsage(store, { id: "x", transcript_path: "/no/such/file.jsonl", usage_offset: 0 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/usage.test.ts`
Expected: FAIL — `tailUsage is not a function` (or undefined export).

- [ ] **Step 3: Write the implementation**

Append `tailUsage` to `src/server/usage.ts` (ensure `readFileSync`, `Store`, and `costOf` are imported — they were added in Task 3):

```ts
/** Read new complete lines from a session's transcript, price them, and record
 *  them. Advances usage_offset to the last newline so a partially-written final
 *  line is never consumed. Idempotent via the message_uuid primary key. */
export function tailUsage(
  store: Store,
  session: { id: string; transcript_path: string | null; usage_offset: number }
): boolean {
  const path = session.transcript_path;
  if (!path) return false;

  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return false; // missing / unreadable
  }

  let offset = session.usage_offset;
  if (offset > content.length) offset = 0; // file shrank/rotated → re-read

  const end = content.lastIndexOf("\n") + 1; // 0 when there is no newline
  if (end <= offset) return false; // no complete new line since last time

  let recorded = false;
  for (const ln of content.slice(offset, end).split("\n")) {
    if (!ln.trim()) continue;
    const parsed = parseUsageLine(ln);
    if (!parsed) continue;
    const ok = store.recordUsage({
      uuid: parsed.uuid,
      sessionId: session.id,
      model: parsed.model,
      tokens: parsed.tokens,
      at: parsed.at,
      cost: costOf(parsed.model, parsed.tokens),
    });
    if (ok) recorded = true;
  }
  store.setUsageOffset(session.id, end);
  return recorded;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/usage.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/usage.ts tests/usage.test.ts
git commit -m "feat(server): tailUsage transcript ingestion"
```

---

## Task 7: Wire cost into `buildState` + ingestion triggers

**Files:**
- Modify: `src/server/http.ts`
- Modify: `src/server/index.ts`
- Test: `tests/http.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/http.test.ts`. First check the top of the file for how it constructs a store/app; add this test (adapt the `new Store(openDb(":memory:"))` construction to match the file's existing helper if one exists):

```ts
import { buildState } from "../src/server/http.ts";
// (openDb / Store imports likely already present in this file)

describe("buildState", () => {
  it("includes a cost block with the expected shape", () => {
    const { Store } = require("../src/server/store.ts");
    const { openDb } = require("../src/server/db.ts");
    const store = new Store(openDb(":memory:"));
    const state = buildState(store);
    expect(state.cost).toBeDefined();
    expect(state.cost.perSession).toEqual({});
    expect(state.cost.liveTotalUsd).toBe(0);
    expect(state.cost.todayUsd).toBe(0);
    expect(state.cost.byModelToday).toEqual([]);
  });
});
```

(If `tests/http.test.ts` already imports `Store`/`openDb` at the top via `import`, reuse those instead of `require` — prefer matching the file's existing style.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/http.test.ts`
Expected: FAIL — `buildState is not exported` / `is not a function`.

- [ ] **Step 3a: Refactor `buildState` to module level in `src/server/http.ts`**

Add the import near the top (after the existing imports):

```ts
import { tailUsage } from "./usage.ts";
import type { Store } from "./store.ts";
```

Add a module-level helper and exported `buildState` above `createApp` (after the `ACTIVITY_LIMIT` constant):

```ts
function startOfLocalDay(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function buildState(store: Store) {
  return {
    sessions: store.listSessions(),
    todos: store.listTodos(),
    activity: store.recentActivity(ACTIVITY_LIMIT),
    stats: store.toolStats(),
    cost: store.costSummary(startOfLocalDay(Date.now())),
  };
}
```

Then inside `createApp`, delete the local `function buildState() {...}` and change `pushState` to use the module-level one:

```ts
  function pushState(): void {
    sse.broadcast("state", buildState(store));
  }
```

And the SSE init write (currently `res.write(\`event: state\ndata: ${JSON.stringify(buildState())}\n\n\`);`) becomes:

```ts
    res.write(`event: state\ndata: ${JSON.stringify(buildState(store))}\n\n`);
```

- [ ] **Step 3b: Tail on `stop` / `session_end` in the `/events` handler**

In the `POST /events` branch of `src/server/http.ts`, immediately before the existing `pushState();` (the one after `store.db.query(...INSERT INTO events...).run(...)`), add:

```ts
        if (type === "stop" || type === "session_end") {
          const info = store.getTailInfo(sessionId);
          if (info) {
            tailUsage(store, { id: sessionId, transcript_path: info.transcript_path, usage_offset: info.usage_offset });
          }
        }
```

- [ ] **Step 3c: Sweep tails non-ended sessions in `src/server/index.ts`**

Replace the broadcast wiring and sweep. Change the imports line:

```ts
import { createApp, buildState, type AppDeps } from "./http.ts";
import { tailUsage } from "./usage.ts";
```

Replace the `onChange` definition:

```ts
const pushState = () => sse.broadcast("state", buildState(store));
const onChange = pushState;
```

Replace the sweep `setInterval` body:

```ts
setInterval(() => {
  const affected = store.sweepStale(Date.now(), STALE_MS, DEAD_MS);
  let changed = affected.length > 0;
  for (const s of store.sessionsToTail()) {
    if (tailUsage(store, s)) changed = true;
  }
  if (changed) pushState();
}, SWEEP_INTERVAL_MS);
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test tests/http.test.ts && bun run typecheck`
Expected: PASS, and `TYPECHECK_EXIT=0` (tsc clean — `buildState` typed, `index.ts` imports resolve).

- [ ] **Step 5: Commit**

```bash
git add src/server/http.ts src/server/index.ts tests/http.test.ts
git commit -m "feat(server): cost in buildState + tail on stop/sweep"
```

---

## Task 8: Web — `Cost` types + formatters

**Files:**
- Modify: `src/web/types.ts`
- Create: `src/web/cost.ts`
- Test: `web-tests/cost.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web-tests/cost.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatUsd, formatTokens, prettyModel } from "../src/web/cost.ts";

describe("formatUsd", () => {
  it("formats dollars with two decimals", () => {
    expect(formatUsd(3.714)).toBe("$3.71");
    expect(formatUsd(0)).toBe("$0.00");
  });
  it("shows a floor for tiny non-zero amounts", () => {
    expect(formatUsd(0.004)).toBe("<$0.01");
  });
});

describe("formatTokens", () => {
  it("uses K / M suffixes", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(312_000)).toBe("312K");
    expect(formatTokens(1_240_000)).toBe("1.2M");
  });
});

describe("prettyModel", () => {
  it("turns model ids into display names", () => {
    expect(prettyModel("claude-opus-4-8")).toBe("Opus 4.8");
    expect(prettyModel("claude-haiku-4-5")).toBe("Haiku 4.5");
    expect(prettyModel("claude-fable-5")).toBe("Fable 5");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run web-tests/cost.test.ts`
Expected: FAIL — cannot resolve `../src/web/cost.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/web/cost.ts`:

```ts
export function formatUsd(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01";
  return "$" + n.toFixed(2);
}

export function formatTokens(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(n);
}

/** "claude-opus-4-8" → "Opus 4.8"; unknown ids are best-effort title-cased. */
export function prettyModel(id: string): string {
  const parts = id.replace(/^claude-/, "").split("-");
  if (parts.length === 0 || !parts[0]) return id;
  const name = parts[0][0].toUpperCase() + parts[0].slice(1);
  const ver = parts.slice(1).join(".");
  return ver ? `${name} ${ver}` : name;
}
```

Add the cost types to `src/web/types.ts` (above `export interface State`):

```ts
export interface SessionCost {
  costUsd: number;
  tokens: number;
}

export interface ModelCost {
  model: string;
  costUsd: number;
}

export interface Cost {
  perSession: Record<string, SessionCost>;
  liveTotalUsd: number;
  todayUsd: number;
  byModelToday: ModelCost[];
}
```

And add `cost` to the `State` interface:

```ts
export interface State {
  sessions: Session[];
  todos: Todo[];
  activity: Activity[];
  stats: ToolStat[];
  cost: Cost;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run web-tests/cost.test.ts`
Expected: PASS (3 describe blocks, 5 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/web/cost.ts src/web/types.ts web-tests/cost.test.ts
git commit -m "feat(web): cost types + currency/token/model formatters"
```

---

## Task 9: Web — `CostPanel`

**Files:**
- Create: `src/web/components/CostPanel.tsx`
- Test: `web-tests/CostPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `web-tests/CostPanel.test.tsx` (match the render/import style of existing `web-tests/*.test.tsx` — they use `@testing-library/react`):

```tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CostPanel } from "../src/web/components/CostPanel.tsx";
import type { Cost } from "../src/web/types.ts";

afterEach(cleanup);

const cost: Cost = {
  perSession: {},
  liveTotalUsd: 3.71,
  todayUsd: 12.4,
  byModelToday: [
    { model: "claude-opus-4-8", costUsd: 10.9 },
    { model: "claude-haiku-4-5", costUsd: 1.5 },
  ],
};

describe("CostPanel", () => {
  it("renders live total, today, and per-model rows", () => {
    render(<CostPanel cost={cost} />);
    expect(screen.getByText("live total")).toBeTruthy();
    expect(screen.getByText("$3.71")).toBeTruthy();
    expect(screen.getByText("today")).toBeTruthy();
    expect(screen.getByText("$12.40")).toBeTruthy();
    expect(screen.getByText("Opus 4.8")).toBeTruthy();
    expect(screen.getByText("$10.90")).toBeTruthy();
  });

  it("renders nothing when there is no cost yet", () => {
    const { container } = render(
      <CostPanel cost={{ perSession: {}, liveTotalUsd: 0, todayUsd: 0, byModelToday: [] }} />
    );
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run web-tests/CostPanel.test.tsx`
Expected: FAIL — cannot resolve `../src/web/components/CostPanel.tsx`.

- [ ] **Step 3: Write the implementation**

Create `src/web/components/CostPanel.tsx`:

```tsx
import type { Cost } from "../types.ts";
import { formatUsd, prettyModel } from "../cost.ts";

export function CostPanel({ cost }: { cost: Cost }) {
  if (cost.liveTotalUsd === 0 && cost.todayUsd === 0) return null;

  return (
    <section className="mt-7">
      <div className="mb-3 flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        <span aria-hidden="true">$</span> Session cost
        <span
          className="ml-auto rounded-full bg-chip px-1.5 py-0.5 text-[10px] font-normal normal-case tracking-normal text-muted-foreground/60"
          title="Notional API-equivalent cost — subscription plans aren't billed per token."
        >
          API-equiv
        </span>
      </div>
      <ul className="space-y-1 font-mono text-2xs">
        <li className="flex items-center gap-2 px-2 py-1">
          <span className="min-w-0 flex-1 text-foreground">live total</span>
          <span className="tabular-nums text-muted-foreground">{formatUsd(cost.liveTotalUsd)}</span>
        </li>
        <li className="flex items-center gap-2 px-2 py-1">
          <span className="min-w-0 flex-1 text-foreground">today</span>
          <span className="tabular-nums text-muted-foreground">{formatUsd(cost.todayUsd)}</span>
        </li>
        {cost.byModelToday.map((m) => (
          <li key={m.model} className="flex items-center gap-2 px-2 py-1 text-muted-foreground/70">
            <span className="min-w-0 flex-1 truncate">{prettyModel(m.model)}</span>
            <span className="tabular-nums">{formatUsd(m.costUsd)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run web-tests/CostPanel.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/web/components/CostPanel.tsx web-tests/CostPanel.test.tsx
git commit -m "feat(web): CostPanel sidebar component"
```

---

## Task 10: Web — per-session cost line + mount panel + initial state

**Files:**
- Modify: `src/web/components/SessionCard.tsx`
- Modify: `src/web/components/Board.tsx`
- Modify: `src/web/App.tsx`
- Test: `web-tests/SessionCard.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `web-tests/SessionCard.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SessionCard } from "../src/web/components/SessionCard.tsx";
import type { Session } from "../src/web/types.ts";

afterEach(cleanup);

const base: Session = {
  id: "s1",
  project: "demo",
  status: "working",
  current_task: null,
  current_intent: "doing a thing",
  attention_reason: null,
  active_tool: null,
  branch: null,
  started_at: 0,
  last_activity_at: 0,
};

describe("SessionCard cost line", () => {
  it("shows cost + tokens when provided", () => {
    render(<SessionCard s={base} cost={{ costUsd: 1.24, tokens: 312_000 }} />);
    expect(screen.getByText("$1.24 · 312K tok")).toBeTruthy();
  });

  it("omits the cost line when no cost is provided", () => {
    const { container } = render(<SessionCard s={base} />);
    expect(container.textContent).not.toContain("tok");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run web-tests/SessionCard.test.tsx`
Expected: FAIL — `cost` is not a prop of `SessionCard` (TS) / no matching text.

- [ ] **Step 3a: Add the cost prop + line to `SessionCard.tsx`**

Add the import at the top of `src/web/components/SessionCard.tsx`:

```ts
import type { SessionCost } from "../types.ts";
import { formatUsd, formatTokens } from "../cost.ts";
```

Change the component signature to accept `cost`:

```tsx
export function SessionCard({
  s,
  latestTool,
  latestDetail,
  cost,
}: {
  s: Session;
  latestTool?: string;
  latestDetail?: string | null;
  cost?: SessionCost;
}) {
```

Add the cost line directly after the `current_task ?? current_intent` block (after its closing `</div>`):

```tsx
      {cost && (
        <div className="mt-1.5 font-mono text-2xs text-muted-foreground/70">
          {formatUsd(cost.costUsd)} · {formatTokens(cost.tokens)} tok
        </div>
      )}
```

- [ ] **Step 3b: Mount `CostPanel` and pass cost in `Board.tsx`**

In `src/web/components/Board.tsx`, add the import:

```ts
import { CostPanel } from "./CostPanel.tsx";
```

Pass cost to each card — change the `<SessionCard ... />` usage to include:

```tsx
                    <SessionCard
                      key={s.id}
                      s={s}
                      latestTool={latest.get(s.id)?.tool}
                      latestDetail={latest.get(s.id)?.detail ?? null}
                      cost={state.cost.perSession[s.id]}
                    />
```

Mount the panel in the `<aside>` between `ToolStats` and `ActivityFeed`:

```tsx
        <aside className="lg:sticky lg:top-20 lg:w-80 lg:shrink-0">
          <ToolStats stats={state.stats} />
          <CostPanel cost={state.cost} />
          <ActivityFeed activity={state.activity} sessions={state.sessions} />
        </aside>
```

- [ ] **Step 3c: Add `cost` to the initial state in `App.tsx`**

In `src/web/App.tsx`, change the initial `useState`:

```tsx
  const [state, setState] = useState<State>({
    sessions: [],
    todos: [],
    activity: [],
    stats: [],
    cost: { perSession: {}, liveTotalUsd: 0, todayUsd: 0, byModelToday: [] },
  });
```

- [ ] **Step 4: Run test + typecheck**

Run: `bunx vitest run web-tests/SessionCard.test.tsx && bun run typecheck`
Expected: PASS (2 tests) and `tsc` clean (App/Board/SessionCard all satisfy the new `State.cost`).

- [ ] **Step 5: Commit**

```bash
git add src/web/components/SessionCard.tsx src/web/components/Board.tsx src/web/App.tsx web-tests/SessionCard.test.tsx
git commit -m "feat(web): per-session cost line + mount CostPanel"
```

---

## Task 11: Full verification + live check

**Files:** none (verification only)

- [ ] **Step 1: Run the entire backend suite**

Run: `bun test tests/`
Expected: PASS — all suites green (existing + new pricing/usage/cost-store/http/store tests).

- [ ] **Step 2: Run the entire web suite**

Run: `bun run web:test`
Expected: PASS — all Vitest files green (existing + cost/CostPanel/SessionCard).

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: `tsc --noEmit` exits 0 for both `tsconfig.json` and `tsconfig.web.json`.

- [ ] **Step 4: Build the web bundle + restart the service, then verify live**

```bash
bun run web:build
systemctl --user restart am-server.service
# wait for listen, then confirm the API serves a cost block:
for i in $(seq 1 20); do curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4317/api/state | grep -q 200 && break; sleep 0.25; done
curl -s http://127.0.0.1:4317/api/state | python3 -c "import sys,json; d=json.load(sys.stdin); print('cost keys:', sorted(d['cost'].keys())); print('liveTotalUsd:', d['cost']['liveTotalUsd']); print('todayUsd:', d['cost']['todayUsd'])"
```
Expected: `cost keys: ['byModelToday', 'liveTotalUsd', 'perSession', 'todayUsd']`, and after the restart-triggered sweep tails the active sessions, non-zero `liveTotalUsd` / `todayUsd`. Open `http://127.0.0.1:4317` and confirm the `$ SESSION COST` panel and per-card cost lines render.

- [ ] **Step 5: Final commit (if any working-tree changes remain)**

```bash
git status --short   # expect clean if all tasks committed; dist/ is gitignored
```

(No commit needed if clean. The `dist/web` rebuild is gitignored.)

---

## Self-review notes

- **Spec coverage:** usage table + offset (T1), pricing incl. cache multipliers + unknown-model fallback (T2), parseUsageLine ignoring `iterations`/non-usage/malformed (T3), recordUsage dedup + tail bookkeeping (T4), costSummary perSession/live/today/byModel (T5), tailUsage idempotency + partial-line + shrink + missing-file (T6), buildState cost + stop/session_end + sweep triggers + broadcast unification (T7), web types + formatters (T8), CostPanel incl. API-equiv label and zero-state (T9), per-session card line + mount + initial state (T10), full verification incl. live check (T11). All spec sections map to a task.
- **Type consistency:** `Tokens` (pricing.ts) and `ParsedUsage` (usage.ts) and the `recordUsage` object shape and `costSummary` return type are defined once in the File Structure contract and used verbatim in T2–T10. `cost` on `State` (T8) matches `store.costSummary` (T5) field-for-field (`perSession`/`liveTotalUsd`/`todayUsd`/`byModelToday`).
- **Cross-task note:** T4's first test calls `costSummary`, which is implemented in T5. The task text instructs implementing `costSummary` during T4 so each task stays green; T5 then only adds its own tests. If executing strictly task-by-task with a fresh agent, follow that instruction.
