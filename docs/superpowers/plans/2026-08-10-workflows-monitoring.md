# Workflows monitoring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest Claude Code workflow subagent transcripts into the existing `usage` table (recovering ~$1,124 of invisible spend), then surface workflow runs as a live board strip and a `#/workflows` history page.

**Architecture:** A second 5s `setInterval` in `src/server/index.ts` runs `scanWorkflows()`, which walks `<sessionDir>/subagents/workflows/wf_*` run dirs, writes structure into two new tables (`workflow_runs`, `workflow_agents`), and tails each `agent-*.jsonl` into `usage` **using the parent session id** so every existing cost aggregation lights up with zero query changes. Live runs are pushed on a **separate** `workflows` SSE event (never in the 243ms `state` blob); history is pulled from `GET /api/workflows`.

**Tech Stack:** Bun + `bun:sqlite` (server), `bun test` (server tests); React 18 + Vite + Tailwind (web), Vitest + @testing-library/react (web tests).

**Spec:** `docs/superpowers/specs/2026-08-10-workflows-monitoring-design.md` — authoritative. Read §0–§7 before starting; every task below cites its section.

## Global Constraints

- **Read-only on `~/.claude` always.** Never write, never delete, never `fs.watch`. File polling only. (§Non-goals, §5.10)
- **Never destructure a parsed object.** Every field from a manifest / journal / meta / script goes through a tolerant getter with a default. (§1.3, §5.1)
- **`status` is stored RAW, verbatim.** No enum, no CHECK constraint, no validation. Unknown values render grey. (§1.3, §2, §5.4)
- **The fast tick must never call `pushState()` / `buildState()`.** `buildState()` is 243ms (`toolStats()` alone is 232ms). A 5s full-state tick burns ~5% CPU permanently. (§3.1, C5)
- **`sessionId` passed to usage recording is the PARENT session id**, never the agent id. This is the keystone that makes project/branch attribution work. (§1.5, C3)
- **A manifest is NOT terminal.** It fixes structure only; it never stops cost tailing. Sealing on `manifest_seen` permanently loses resumed spend. (§1.4 rule 1, C6)
- **A manifest can be REWRITTEN in place**, outside the run dir, moving nothing else. `manifest_mtime` (stored per run, refreshed on every parse) is the re-parse trigger; `last_seen_at` keeps its meaning — the run dir's mtime. (§1.4, §2, C6)
- **Parent-transcript tailing skips lines marked `isSidechain: true` or carrying an `agentId`.** Workflow agent tailing must **never** set that flag — every line in an agent transcript is a sidechain (C3), so it would ingest nothing. (§1.5)
- **The cross-slug script lookup runs at most ONCE per run**, on the pass that discovers it (or the startup backfill) — never on a steady-state 5s tick. The cheap `<sessionDir>` lookup stays on the tick. (§1.3, C9)
- **Every `bumpDegraded()` is gated on `logOnce(...)` returning `true`**, so `workflows_degraded` counts once per run per cause, not once per 5s tick. (§5.5)
- **Agent set = the run dir's `agent-*.jsonl` files** — not the manifest, not the journal. (§1.1)
- **Do not re-point the `haiku` family alias.** There is no `claude-haiku-5` rate; re-pointing it costs every bare `haiku` $0. (§0a)
- **No `FOREIGN KEY`s** on the new tables, matching `usage`/`events`. (§2)
- **Not stored, ever:** `script`, `args`, `logs`, `result`, `resultPreview` — bulk work content. (§2, §Non-goals)
- Ship order is **load-bearing**: pricing fix + reprice must land before any workflow backfill, because `recordUsage()` is `INSERT OR IGNORE` on `message_uuid` and a row inserted at the wrong price is never repriced. (§0)

## Conventions to follow

- Server tests: `bun test tests/`, in-memory DB via `new Store(openDb(":memory:"))`. The `tok()` helper already exists in `tests/cost-store.test.ts`.
- Web tests: `npx vitest run`. RTL cleanup is registered globally in `web-tests/setup.ts`.
- Typecheck: `bun run typecheck` (runs both `tsconfig.json` and `tsconfig.web.json`).
- Reuse the module-level `TOKEN_SUM` const and `rangeClause()` helper at the top of `src/server/store.ts`.
- Reuse `json(res, 200, …)` and the `num(v)` guard pattern from the `/api/cost/daily` block in `src/server/http.ts:141-153`.
- Web pure helpers live in `src/web/cost.ts` / `src/web/time.ts`; hooks are `src/web/useX.ts`; components in `src/web/components/`.
- Commit after every task. Branch per ship step; merge each before starting the next.
- **Import-cycle rule:** `src/server/store.ts` imports `deriveRunState` from `src/server/workflows.ts` as a **value**, so every import going the other way (`Store`, `LiveWorkflow`, `WorkflowAgentUpsert`, …) MUST be `import type { … }`. Type-only imports erase at runtime, leaving no cycle. The same applies to `src/server/usage.ts`, which already uses `import type { Store }`.

## Task dependency map

| Step | Branch | Tasks | Sequencing within the step |
|---|---|---|---|
| 1 | `fix/pricing-rates-5-series` | 1, 2, 3, **4 (ops)** | strictly sequential: 1 → 2 → 3 → 4 |
| 2 | `feat/workflow-cost-ingestion` | 5–13, **14 (ops)** | **5 → 6** (6's widened `recordUsage` INSERT names `usage.run_id`/`agent_id`, so *every* Task 6 test fails against a DB without them — not just the `cost-store` one). 7 first, then 8, 9 and 10 are independent of each other. 11 needs 5 (its upsert writes `manifest_mtime`, added to the DDL there). 12 needs 6+7+8+9+10+11. 13 needs 12. 14 needs 13. |
| 3 | `feat/workflows-history` | 15–18, **19 (ops)** | 15 → 16. 17 is independent of 15/16 (mocked `fetch`). 18 needs 17. 19 needs 16 and 18. |
| 4 | `feat/workflows-live` | 20–23, **24 (ops)** | 20 → 21. 22 is independent of 20/21. 23 needs 22 (and 20 for the payload shape). 24 needs 23. |

**Step 2 must not start before step 1's ops task (Task 4) has run against the live DB** — otherwise the backfill bakes $786 of $0.00 rows in permanently, and `INSERT OR IGNORE` on `message_uuid` means they can never be repriced in place.

Every step ends with its branch merged to `main` before the next begins.

Tasks marked **(ops)** touch the live machine (systemd, the 285MB production SQLite file) and are **not** code changes. They cannot be delegated to a subagent that only runs tests.

---

## Step 1 — `fix/pricing-rates-5-series`

**Gate:** `tests/pricing.test.ts` amended and green; `#/cost` shows non-zero `claude-opus-5` spend and the row count is back to ~1,985.

**Announce in the commit message:** cost history for past days will visibly jump. That is correct — the spend was always real — but it is jarring on the `#/cost` page.

```bash
git checkout -b fix/pricing-rates-5-series
```

### Task 1: add the 5-series rates and re-point `opus`/`sonnet` (§0a)

**Files:**
- Modify: `src/server/pricing.ts:15-35` (`RATES`, `FAMILY_ALIAS`)
- Test: `tests/pricing.test.ts` (**amend** three existing assertions, add three new)

**Interfaces:**
- Produces: `RATES["claude-opus-5"] = { input: 5, output: 25 }`, `RATES["claude-sonnet-5"] = { input: 3, output: 15 }`; `canonicalModel("opus") === "claude-opus-5"`, `canonicalModel("sonnet") === "claude-sonnet-5"`, `canonicalModel("haiku") === "claude-haiku-4-5"` (unchanged).

- [ ] **Step 1: Amend the failing tests**

In `tests/pricing.test.ts`, replace the whole `canonicalModel` alias test (lines 50-54) with:

```ts
  it("maps bare family aliases to a canonical id", () => {
    expect(canonicalModel("opus")).toBe("claude-opus-5");
    expect(canonicalModel("sonnet")).toBe("claude-sonnet-5");
    // haiku is deliberately NOT re-pointed: there is no claude-haiku-5 rate,
    // so re-pointing it would send every bare `haiku` to the $0 unknown branch.
    expect(canonicalModel("haiku")).toBe("claude-haiku-4-5");
  });
```

Then append inside the existing `describe("costOf", …)` block, after the "prices bare family aliases" test:

```ts
  it("prices the 5-series models (the $786 bug this fix exists for)", () => {
    expect(costOf("claude-opus-5", { ...zero, input: 1_000_000, output: 1_000_000 })).toBeCloseTo(5 + 25, 6);
    expect(costOf("claude-sonnet-5", { ...zero, input: 1_000_000, output: 1_000_000 })).toBeCloseTo(3 + 15, 6);
  });

  it("keeps bare haiku priced at the 4-5 tier (regression: do not 'finish the job')", () => {
    expect(costOf("haiku", { ...zero, input: 1_000_000 })).toBeCloseTo(1, 6);
  });

  it("keeps the alias tier rates unchanged after the re-point", () => {
    // 5/25 and 3/15 are the same between the 4-series and 5-series tiers, so
    // these values must survive the alias move — assert non-zero, don't delete.
    expect(costOf("opus", { ...zero, input: 1_000_000 })).toBeCloseTo(5, 6);
    expect(costOf("sonnet", { ...zero, output: 1_000_000 })).toBeCloseTo(15, 6);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/pricing.test.ts`
Expected: FAIL — `canonicalModel("opus")` returns `"claude-opus-4-8"`, and `costOf("claude-opus-5", …)` returns `0`.

- [ ] **Step 3: Write the implementation**

In `src/server/pricing.ts`, add the two rates at the **top** of `RATES` (above the `-4-*` entries) and re-point exactly two aliases:

```ts
const RATES: Record<string, Rate> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
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

const FAMILY_ALIAS: Record<string, string> = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  // NOT re-pointed: there is no claude-haiku-5 rate, so pointing `haiku` at one
  // would send it to costOf's unknown-model branch and cost it $0.
  haiku: "claude-haiku-4-5",
  fable: "claude-fable-5",
  mythos: "claude-mythos-5",
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/` — Expected: PASS (whole server suite; nothing else asserts on these aliases).

- [ ] **Step 5: Commit**

```bash
git add src/server/pricing.ts tests/pricing.test.ts
git commit -m "fix(pricing): add claude-opus-5/claude-sonnet-5 rates, re-point opus+sonnet aliases

Untracked \$786 of 5-series spend was pricing at \$0. haiku is deliberately
left on claude-haiku-4-5 — there is no claude-haiku-5 rate to point at.
Past days on #/cost will jump once the repricing routine runs."
```

---

### Task 2: `app_meta` key/value table + `Store.getMeta` / `setMeta` (§0b)

**Files:**
- Modify: `src/server/db.ts` (inside `migrate()`, in the main `db.exec` template)
- Modify: `src/server/store.ts` (add two methods after `getTailInfo`, ~line 271)
- Test: `tests/store.test.ts` (append inside `describe("Store sessions", …)`)

**Interfaces:**
- Produces: `Store.getMeta(key: string): string | null`, `Store.setMeta(key: string, value: string): void`; table `app_meta (key TEXT PRIMARY KEY, value TEXT)`.

- [ ] **Step 1: Write the failing tests**

Append inside `describe("Store sessions", …)` in `tests/store.test.ts`:

```ts
  it("round-trips app_meta values and overwrites on repeat set", () => {
    expect(store.getMeta("nope")).toBeNull();
    store.setMeta("marker", "123");
    expect(store.getMeta("marker")).toBe("123");
    store.setMeta("marker", "456");
    expect(store.getMeta("marker")).toBe("456");
  });

  it("idempotently creates app_meta on a pre-existing DB", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, project TEXT, started_at INTEGER NOT NULL DEFAULT 0, last_activity_at INTEGER NOT NULL DEFAULT 0);`);
    migrate(db);
    const has = () =>
      (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='app_meta'").all() as unknown[]).length;
    expect(has()).toBe(1);
    migrate(db); // second run must not throw or duplicate
    expect(has()).toBe(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/store.test.ts`
Expected: FAIL — `store.getMeta is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/server/db.ts`, add to the `db.exec` template in `migrate()` (immediately after the `todos` table block, before `CREATE TABLE IF NOT EXISTS usage`):

```sql
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
```

In `src/server/store.ts`, add after `getTailInfo`:

```ts
  /** Process-independent key/value marker store. Used by one-shot maintenance
   *  routines (e.g. repricing) so a restart cannot re-run them. */
  getMeta(key: string): string | null {
    const row = this.db.query(`SELECT value FROM app_meta WHERE key = $k`).get({ $k: key }) as
      | { value: string | null }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .query(`INSERT INTO app_meta (key, value) VALUES ($k, $v) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run({ $k: key, $v: value });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/store.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/db.ts src/server/store.ts tests/store.test.ts
git commit -m "feat(db): app_meta key/value table + Store.getMeta/setMeta"
```

---

### Task 3: `repriceFiveSeries()` delete-and-reingest routine (§0b)

**Files:**
- Create: `src/server/reprice.ts`
- Create: `tests/reprice.test.ts`
- Modify: `src/server/index.ts` (call it before `server.listen`, ~line 63)

**Interfaces:**
- Consumes: `Store.getMeta`/`setMeta` (Task 2); `tailUsage(store, session)` from `src/server/usage.ts`; `Store.getTailInfo(id)`.
- Produces: `repriceFiveSeries(store: Store, now: number): { sessions: number; deleted: number; recorded: number }` and `export const REPRICE_MARKER = "reprice_5_series_done"`.

- [ ] **Step 1: Write the failing tests**

Create `tests/reprice.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import { repriceFiveSeries, REPRICE_MARKER } from "../src/server/reprice.ts";
import type { Tokens } from "../src/server/pricing.ts";

const tok = (input: number): Tokens => ({ input, output: 0, cache_read: 0, cache_create_5m: 0, cache_create_1h: 0 });

/** One transcript line worth exactly $5 at the opus tier (1M input tokens). */
function line(uuid: string, model = "claude-opus-5") {
  return (
    JSON.stringify({
      uuid,
      timestamp: "2026-08-01T08:00:00.000Z",
      message: { model, usage: { input_tokens: 1_000_000, output_tokens: 0 } },
    }) + "\n"
  );
}

function fixture(): { store: Store; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "am-reprice-"));
  const file = join(dir, "t.jsonl");
  writeFileSync(file, line("m1") + line("m2"));
  const store = new Store(openDb(":memory:"));
  // An ENDED session — sessionsToTail() would never touch it, which is exactly
  // why the routine must re-tail in-process (spec §0b step 5).
  store.applyEvent("s1", { status: "ended", project: "alpha", branch: "main", transcript_path: file, last_activity_at: 1 }, 1);
  store.setUsageOffset("s1", 999);
  // The pre-existing damage: rows recorded at $0 before the rates were added.
  store.recordUsage({ uuid: "m1", sessionId: "s1", model: "claude-opus-5", tokens: tok(1_000_000), at: 1, cost: 0 });
  store.recordUsage({ uuid: "m2", sessionId: "s1", model: "claude-opus-5", tokens: tok(1_000_000), at: 1, cost: 0 });
  return { store, file };
}

describe("repriceFiveSeries", () => {
  it("deletes the $0 5-series rows and re-tails them back at the correct price", () => {
    const { store } = fixture();
    expect(store.costSummary(0).perSession.s1.costUsd).toBe(0);

    const r = repriceFiveSeries(store, 5000);
    expect(r.sessions).toBe(1);
    expect(r.deleted).toBe(2);
    expect(store.costSummary(0).perSession.s1.costUsd).toBeCloseTo(10, 6); // 2 × $5
  });

  it("leaves legitimately-free rows of other models untouched", () => {
    const { store } = fixture();
    store.recordUsage({ uuid: "syn", sessionId: "s1", model: "<synthetic>", tokens: tok(0), at: 1, cost: 0 });
    repriceFiveSeries(store, 5000);
    const kept = store.db.query("SELECT COUNT(*) AS c FROM usage WHERE model = '<synthetic>'").get() as { c: number };
    expect(kept.c).toBe(1);
  });

  it("skips sessions whose transcript is gone rather than deleting their history", () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("ghost", { status: "ended", transcript_path: "/no/such/file.jsonl", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "g1", sessionId: "ghost", model: "claude-opus-5", tokens: tok(10), at: 1, cost: 0 });
    const r = repriceFiveSeries(store, 5000);
    expect(r.sessions).toBe(0);
    expect(r.deleted).toBe(0);
    const still = store.db.query("SELECT COUNT(*) AS c FROM usage WHERE message_uuid = 'g1'").get() as { c: number };
    expect(still.c).toBe(1); // token history preserved
  });

  it("writes a marker so a restart cannot re-run it", () => {
    const { store } = fixture();
    repriceFiveSeries(store, 5000);
    expect(store.getMeta(REPRICE_MARKER)).toBe("5000");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/reprice.test.ts`
Expected: FAIL — cannot resolve `../src/server/reprice.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/server/reprice.ts`:

```ts
import { existsSync } from "node:fs";
import type { Store } from "./store.ts";
import { tailUsage } from "./usage.ts";

export const REPRICE_MARKER = "reprice_5_series_done";

/** One-shot maintenance routine (spec §0b). `recordUsage()` is INSERT OR IGNORE
 *  on message_uuid, so a row inserted at the wrong price is never repriced in
 *  place — the only fix is delete-and-reingest.
 *
 *  All affected rows belong to ENDED sessions, which `sessionsToTail()` filters
 *  out, so step 5 (the in-process re-tail) is NOT optional: without it this is a
 *  pure deletion and the spend is lost. Steps 3–5 run in one transaction so a
 *  crash between the DELETE and the re-tail is impossible. */
export function repriceFiveSeries(
  store: Store,
  now: number
): { sessions: number; deleted: number; recorded: number } {
  const owners = store.db
    .query(
      `SELECT DISTINCT session_id FROM usage
       WHERE cost_usd = 0 AND model IN ('claude-opus-5', 'claude-sonnet-5')`
    )
    .all() as { session_id: string }[];

  // Drop any session whose transcript is gone — its rows are unrecoverable and
  // deleting them would lose token history for nothing.
  const kept: { id: string; path: string }[] = [];
  for (const { session_id } of owners) {
    const info = store.getTailInfo(session_id);
    if (!info?.transcript_path) continue;
    if (!existsSync(info.transcript_path)) continue;
    kept.push({ id: session_id, path: info.transcript_path });
  }

  if (kept.length === 0) {
    store.setMeta(REPRICE_MARKER, String(now));
    return { sessions: 0, deleted: 0, recorded: 0 };
  }

  const placeholders = kept.map((_, i) => `$s${i}`).join(", ");
  const params: Record<string, string> = {};
  kept.forEach((k, i) => (params[`$s${i}`] = k.id));

  let deleted = 0;
  let recorded = 0;
  store.db.transaction(() => {
    // The model filter is load-bearing: it leaves the `<synthetic>` $0.00 rows,
    // which are legitimately free, untouched.
    const res = store.db
      .query(
        `DELETE FROM usage
         WHERE cost_usd = 0 AND model IN ('claude-opus-5', 'claude-sonnet-5')
           AND session_id IN (${placeholders})`
      )
      .run(params);
    deleted = res.changes;
    for (const k of kept) {
      store.setUsageOffset(k.id, 0);
      if (tailUsage(store, { id: k.id, transcript_path: k.path, usage_offset: 0 })) recorded++;
    }
    store.setMeta(REPRICE_MARKER, String(now));
  })();

  return { sessions: kept.length, deleted, recorded };
}
```

In `src/server/index.ts`, add the import beside the others and the gated call **immediately before** `server.listen(...)` (so no request observes the half-deleted state):

```ts
import { repriceFiveSeries, REPRICE_MARKER } from "./reprice.ts";
```

```ts
// One-shot: reprice the pre-existing $0.00 5-series rows (spec §0b). Gated behind
// AM_REPRICE=1 for the manual first run and guarded by a marker so a restart
// cannot re-run it.
if (process.env.AM_REPRICE === "1" && !store.getMeta(REPRICE_MARKER)) {
  const r = repriceFiveSeries(store, Date.now());
  console.log(`[reprice] sessions=${r.sessions} deleted=${r.deleted} re-tailed=${r.recorded}`);
}

server.listen(PORT, HOST, () => {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/ && bun run typecheck` — Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/server/reprice.ts src/server/index.ts tests/reprice.test.ts
git commit -m "feat(server): AM_REPRICE=1 delete-and-reingest routine for \$0 5-series rows"
```

---

### Task 4 (ops): run the repricing against the live DB

**Files:** none — this operates on `~/.local/share/agent-monitor/agent-monitor.sqlite` and `am-server.service`.

This is the **delete-and-reingest of $0-priced usage rows** the spec requires *before* any workflow backfill. Do not skip it and do not reorder it after step 2.

- [ ] **Step 1: Record the "before" numbers**

```bash
sqlite3 -readonly ~/.local/share/agent-monitor/agent-monitor.sqlite \
  "SELECT model, COUNT(*), ROUND(SUM(cost_usd),2) FROM usage WHERE cost_usd = 0 GROUP BY model ORDER BY 2 DESC;"
```
Expected (as surveyed 2026-08-10): `claude-opus-5|1985|0.0` and `<synthetic>|18|0.0`. Write both numbers down — step 5 checks against them.

- [ ] **Step 2: Stop the service and back up the DB**

Two processes must not write this SQLite file at once.

```bash
systemctl --user stop am-server.service
sqlite3 ~/.local/share/agent-monitor/agent-monitor.sqlite ".backup '/tmp/am-pre-reprice.sqlite'"
ls -la /tmp/am-pre-reprice.sqlite
```
Expected: a ~286MB backup file exists.

- [ ] **Step 3: Run the routine**

The routine runs before `listen()`, then the server starts normally. There is nothing
to interrupt by hand: `timeout` kills the process on its own once the two lines have
printed, so this is a single blocking command that always terminates.

```bash
cd /home/lunatic/projects/work/agent-monitor && AM_REPRICE=1 timeout 180 bun run src/server/index.ts 2>&1 | tee /tmp/am-reprice.log
```
Expected stdout: a `[reprice] sessions=10 deleted=1985 re-tailed=10` line (counts may
drift; **as measured on 2026-08-10 the live DB holds exactly 1,985 `claude-opus-5`
$0.00 rows across 10 sessions**), followed by `am-server listening on
http://127.0.0.1:4317`. The command then sits idle until `timeout` ends it — that is
expected, not a hang. If `timeout` fires before the `[reprice]` line appears, re-run
with a larger value: the re-tail re-reads 10 full transcripts.

- [ ] **Step 4: Restart the service**

```bash
systemctl --user start am-server.service
systemctl --user is-active am-server.service
```
Expected: `active`.

- [ ] **Step 5: Verify the gate**

```bash
sqlite3 -readonly ~/.local/share/agent-monitor/agent-monitor.sqlite \
  "SELECT COUNT(*), ROUND(SUM(cost_usd),2) FROM usage WHERE model = 'claude-opus-5';
   SELECT COUNT(*) FROM usage WHERE model = '<synthetic>';
   SELECT value FROM app_meta WHERE key = 'reprice_5_series_done';"
```
Expected: the opus-5 row count is back to ~1,985 (step 1's number) with a **non-zero** total cost; the `<synthetic>` count is unchanged at 18; the marker holds an epoch-ms value.

Then open `http://localhost:4317/#/cost` — `claude-opus-5` spend is non-zero and past days have visibly jumped. That jump is correct.

- [ ] **Step 6: Merge the branch**

```bash
git checkout main && git merge --no-ff fix/pricing-rates-5-series
```

---

## Step 2 — `feat/workflow-cost-ingestion`

**Delivers:** the whole §2 migration, the `takeUsage()` refactor, the cost-only workflow scan, and the one-time startup backfill. **No API, no UI.**

**Gate:** ~$1,124 appears in cost views, attributed to real projects/branches, no `unknown` bucket.

**Announce in the commit message:** ~$1,124 of spend lands on **past** days; prior days on `#/cost` will jump noticeably. Correct, but jarring.

```bash
git checkout -b feat/workflow-cost-ingestion
```

### Task 5: migration — `workflow_runs`, `workflow_agents`, `usage.run_id`/`agent_id` (§2)

**Files:**
- Modify: `src/server/db.ts` (`migrate()`: main `db.exec` template + the `usageCols` idempotent-ALTER block at lines 83-89)
- Test: `tests/store.test.ts` (append inside `describe("Store sessions", …)`)

**Interfaces:**
- Produces: tables `workflow_runs` (PK `run_id`, including `manifest_mtime INTEGER` — the manifest's mtime as of the last parse, §1.4's rewrite trigger) and `workflow_agents` (PK `(run_id, agent_id)`), columns `usage.run_id` / `usage.agent_id`, indexes `idx_workflow_runs_started` and `idx_usage_run`.

**Independent of Task 6.**

- [ ] **Step 1: Write the failing tests**

Append inside `describe("Store sessions", …)` in `tests/store.test.ts`:

```ts
  it("idempotently creates workflow_runs and workflow_agents on a pre-existing DB", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, project TEXT, started_at INTEGER NOT NULL DEFAULT 0, last_activity_at INTEGER NOT NULL DEFAULT 0);`);
    migrate(db);
    const hasTable = (n: string) =>
      (db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='${n}'`).all() as unknown[]).length;
    expect(hasTable("workflow_runs")).toBe(1);
    expect(hasTable("workflow_agents")).toBe(1);
    // manifest_mtime is what makes an in-place manifest rewrite (C6) re-parse;
    // the run dir's mtime never moves for it, so nothing else would notice.
    const runCols = (db.query("PRAGMA table_info(workflow_runs)").all() as { name: string }[]).map((c) => c.name);
    expect(runCols).toContain("manifest_mtime");
    migrate(db); // second run must not throw or duplicate
    expect(hasTable("workflow_runs")).toBe(1);
    expect(hasTable("workflow_agents")).toBe(1);
  });

  it("idempotently adds usage.run_id and usage.agent_id to a pre-existing usage table", () => {
    const db = new Database(":memory:");
    // A usage table predating the workflow columns.
    db.exec(`CREATE TABLE usage (message_uuid TEXT PRIMARY KEY, session_id TEXT NOT NULL, model TEXT NOT NULL, cost_usd REAL NOT NULL, at INTEGER NOT NULL);`);
    migrate(db);
    const has = (col: string) =>
      (db.query("PRAGMA table_info(usage)").all() as { name: string }[]).filter((c) => c.name === col).length;
    expect(has("run_id")).toBe(1);
    expect(has("agent_id")).toBe(1);
    migrate(db); // second run must not throw or duplicate
    expect(has("run_id")).toBe(1);
    expect(has("agent_id")).toBe(1);
  });

  it("stores an unknown workflow status verbatim (no enum, no CHECK)", () => {
    store.db
      .query(
        `INSERT INTO workflow_runs (run_id, session_id, status, dir) VALUES ('wf_x', 's1', 'brand-new-status', '/tmp/x')`
      )
      .run();
    const row = store.db.query("SELECT status FROM workflow_runs WHERE run_id = 'wf_x'").get() as { status: string };
    expect(row.status).toBe("brand-new-status");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/store.test.ts`
Expected: FAIL — `no such table: workflow_runs`.

- [ ] **Step 3: Write the implementation**

In `src/server/db.ts`, append to the main `db.exec` template in `migrate()` (after the two `idx_usage_*` indexes, still inside the same backtick string):

```sql
    CREATE TABLE IF NOT EXISTS workflow_runs (
      run_id                TEXT PRIMARY KEY,
      session_id            TEXT NOT NULL,
      project               TEXT,
      branch                TEXT,
      name                  TEXT,
      summary               TEXT,
      status                TEXT,
      error                 TEXT,
      started_at            INTEGER,
      ended_at              INTEGER,
      duration_ms           INTEGER,
      agent_count           INTEGER,
      phases                TEXT,
      cc_version            TEXT,
      manifest_seen         INTEGER NOT NULL DEFAULT 0,
      manifest_mtime        INTEGER,
      last_seen_at          INTEGER,
      dir                   TEXT NOT NULL,
      schema_ok             INTEGER NOT NULL DEFAULT 1,
      total_tokens_reported INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_started ON workflow_runs(started_at);
    CREATE TABLE IF NOT EXISTS workflow_agents (
      run_id            TEXT NOT NULL,
      agent_id          TEXT NOT NULL,
      label             TEXT,
      phase_index       INTEGER,
      phase_title       TEXT,
      idx               INTEGER,
      model             TEXT,
      state             TEXT,
      attempt           INTEGER,
      journal_key       TEXT,
      last_tool         TEXT,
      last_tool_summary TEXT,
      prompt_preview    TEXT,
      started_at        INTEGER,
      ended_at          INTEGER,
      duration_ms       INTEGER,
      tool_calls        INTEGER,
      offset            INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, agent_id)
    );
```

Then extend the existing `usageCols` block (currently lines 83-89) with two more guarded ALTERs and the index:

```ts
  if (!usageCols.some((c) => c.name === "run_id")) {
    db.exec("ALTER TABLE usage ADD COLUMN run_id TEXT;");
  }
  if (!usageCols.some((c) => c.name === "agent_id")) {
    db.exec("ALTER TABLE usage ADD COLUMN agent_id TEXT;");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_usage_run ON usage(run_id);");
```

Note: no `FOREIGN KEY`s anywhere, deliberately — `PRAGMA foreign_keys = ON` is set in `openDb`, and a backfill insert against a purged session must not fail.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/store.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/db.ts tests/store.test.ts
git commit -m "feat(db): workflow_runs + workflow_agents tables, usage.run_id/agent_id"
```

---

### Task 6: `takeUsage()` path-based tail core (§1.5)

**Files:**
- Modify: `src/server/usage.ts:41-80` (`tailUsage` becomes a wrapper over a new `takeUsage`)
- Modify: `src/server/store.ts:227-260` (`recordUsage` gains optional `runId`/`agentId`)
- Test: `tests/usage.test.ts` (append a new `describe`; the existing `tailUsage` tests must pass **unchanged** — that is the refactor's safety net)
- Test: `tests/cost-store.test.ts` (append one test for the new columns)

**Interfaces:**
- Consumes: `usage.run_id` / `usage.agent_id` columns (Task 5).
- Produces:
  ```ts
  export function takeUsage(store: Store, t: {
    path: string; offset: number; sessionId: string;
    runId?: string; agentId?: string; skipSidechain?: boolean;
  }): { offset: number; recorded: boolean };
  ```
  and `Store.recordUsage(u: { uuid; sessionId; model; tokens; at; cost; runId?: string; agentId?: string }): boolean`.
  `ParsedUsage` gains one field: `sidechain: boolean` (`isSidechain === true` **or** an `agentId` field on the line).
  `tailUsage(store, session): boolean` keeps its existing signature, so `src/server/http.ts:127` and the 60s sweep in `src/server/index.ts:57-59` need no change.

**Double-count guard (§1.5).** `tailUsage` — the PARENT-transcript path — passes `skipSidechain: true`, so a parent line carrying `isSidechain: true` or an `agentId` is never priced. Today that is a **no-op**: 0 such lines exist in any parent transcript on this machine. It exists so that if Claude Code ever folds agent lines into the parent under fresh uuids, `INSERT OR IGNORE` failing to dedupe them cannot double-charge (spec accepted risk 6). The workflow path must **never** set the flag — every agent transcript line carries `isSidechain: true` (C3), so it would ingest nothing.

**Needs Task 5.** `recordUsage`'s INSERT below names `usage.run_id` / `usage.agent_id`; SQLite rejects the statement at prepare time when those columns are absent, so *every* test in this task fails without Task 5's migration — not just the `cost-store` one.

- [ ] **Step 1: Write the failing tests**

Append to `tests/usage.test.ts` (add `takeUsage` to the existing import from `../src/server/usage.ts`, and `statSync` is not needed — the short-circuit is observed through the returned offset):

```ts
/** The same priced line as `line()`, plus a subagent marker at the top level.
 *  Real agent transcript lines carry `isSidechain: true`; `agentId` is the other
 *  marker a fold would plausibly keep. */
const markedLine = (uuid: string, marker: Record<string, unknown>) =>
  JSON.stringify({
    uuid,
    timestamp: "2026-06-15T08:00:00.000Z",
    ...marker,
    message: { model: "claude-opus-4-8", usage: { input_tokens: 1_000_000, output_tokens: 0 } },
  }) + "\n";

describe("parseUsageLine sidechain markers", () => {
  it("flags isSidechain and agentId lines and leaves an ordinary line unflagged", () => {
    expect(parseUsageLine(line("p1"))!.sidechain).toBe(false);
    expect(parseUsageLine(markedLine("s1", { isSidechain: true }))!.sidechain).toBe(true);
    expect(parseUsageLine(markedLine("s2", { agentId: "a-1" }))!.sidechain).toBe(true);
  });
});

describe("takeUsage", () => {
  it("short-circuits when the file has not grown (no re-read of a multi-MB transcript)", () => {
    const dir = mkdtempSync(join(tmpdir(), "am-take-"));
    const file = join(dir, "t.jsonl");
    writeFileSync(file, line("m1"));
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", last_activity_at: 1 }, 1);

    const first = takeUsage(store, { path: file, offset: 0, sessionId: "s1" });
    expect(first.recorded).toBe(true);
    expect(first.offset).toBe(Buffer.byteLength(line("m1")));

    const second = takeUsage(store, { path: file, offset: first.offset, sessionId: "s1" });
    expect(second.recorded).toBe(false);
    expect(second.offset).toBe(first.offset);
  });

  it("stamps run_id/agent_id and attributes to the PARENT session's project/branch", () => {
    const dir = mkdtempSync(join(tmpdir(), "am-take-"));
    const file = join(dir, "agent-a1.jsonl");
    writeFileSync(file, line("w1"));
    const store = new Store(openDb(":memory:"));
    store.applyEvent("parent", { status: "working", project: "alpha", branch: "feat/x", last_activity_at: 1 }, 1);

    const r = takeUsage(store, { path: file, offset: 0, sessionId: "parent", runId: "wf_1", agentId: "a1" });
    expect(r.recorded).toBe(true);
    const row = store.db.query("SELECT run_id, agent_id, project, branch FROM usage WHERE message_uuid = 'w1'").get();
    expect(row).toEqual({ run_id: "wf_1", agent_id: "a1", project: "alpha", branch: "feat/x" });
  });

  it("is idempotent — re-reading from offset 0 records nothing new", () => {
    const dir = mkdtempSync(join(tmpdir(), "am-take-"));
    const file = join(dir, "t.jsonl");
    writeFileSync(file, line("m1") + line("m2"));
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", last_activity_at: 1 }, 1);
    takeUsage(store, { path: file, offset: 0, sessionId: "s1" });
    const again = takeUsage(store, { path: file, offset: 0, sessionId: "s1" });
    expect(again.recorded).toBe(false);
    expect(store.costSummary(0).perSession.s1.costUsd).toBeCloseTo(10, 6); // still 2 × $5
  });

  it("resets to 0 and re-reads when the file shrank below the stored offset", () => {
    const dir = mkdtempSync(join(tmpdir(), "am-take-"));
    const file = join(dir, "t.jsonl");
    writeFileSync(file, line("m1"));
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", last_activity_at: 1 }, 1);
    const r = takeUsage(store, { path: file, offset: 1_000_000, sessionId: "s1" });
    expect(r.recorded).toBe(true);
    expect(r.offset).toBe(Buffer.byteLength(line("m1")));
  });

  it("returns the caller's offset unchanged for a missing file", () => {
    const store = new Store(openDb(":memory:"));
    expect(takeUsage(store, { path: "/no/such/file.jsonl", offset: 7, sessionId: "s1" })).toEqual({
      offset: 7,
      recorded: false,
    });
  });

  it("skips sidechain / agent-marked lines on the PARENT path (double-count guard)", () => {
    const dir = mkdtempSync(join(tmpdir(), "am-take-"));
    const file = join(dir, "parent.jsonl");
    // A synthetic parent transcript: one ordinary assistant line plus two lines
    // folded in from subagents. No real parent transcript on this machine holds
    // such a line today — the guard exists so that if Claude Code ever starts
    // folding them in under FRESH uuids, the same spend is not counted twice
    // (once here, once from agent-*.jsonl).
    writeFileSync(file, line("p1") + markedLine("s1", { isSidechain: true }) + markedLine("s2", { agentId: "a-1" }));
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", last_activity_at: 1 }, 1);

    const r = takeUsage(store, { path: file, offset: 0, sessionId: "s1", skipSidechain: true });
    expect(r.recorded).toBe(true);
    expect(store.db.query("SELECT message_uuid FROM usage ORDER BY message_uuid").all()).toEqual([
      { message_uuid: "p1" },
    ]);
    // The offset still advances past every line — skipped, not deferred.
    expect(r.offset).toBe(Buffer.byteLength(readFileSync(file, "utf8")));
  });

  it("tailUsage passes the guard, so a session transcript never prices a folded agent line", () => {
    const dir = mkdtempSync(join(tmpdir(), "am-take-"));
    const file = join(dir, "parent.jsonl");
    writeFileSync(file, line("p1") + markedLine("s1", { isSidechain: true }));
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", last_activity_at: 1 }, 1);
    expect(tailUsage(store, { id: "s1", transcript_path: file, usage_offset: 0 })).toBe(true);
    expect(store.costSummary(0).perSession.s1.costUsd).toBeCloseTo(5, 6); // one line, not two
  });

  it("still records a marked line through the WORKFLOW path — every agent line is a sidechain (C3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "am-take-"));
    const file = join(dir, "agent-a1.jsonl");
    writeFileSync(file, markedLine("w1", { isSidechain: true }));
    const store = new Store(openDb(":memory:"));
    store.applyEvent("parent", { status: "working", project: "alpha", last_activity_at: 1 }, 1);
    // No skipSidechain here, deliberately: setting it would ingest nothing at all.
    const r = takeUsage(store, { path: file, offset: 0, sessionId: "parent", runId: "wf_1", agentId: "a1" });
    expect(r.recorded).toBe(true);
  });
});
```

`readFileSync` joins the existing `node:fs` import in this file.

Append to `tests/cost-store.test.ts` inside `describe("Store usage rows", …)`:

```ts
  it("records run_id and agent_id when given, NULL when not", () => {
    store.recordUsage({ uuid: "w1", sessionId: "s1", model: "claude-opus-5", tokens: tok(10), at: 1, cost: 1, runId: "wf_1", agentId: "a1" });
    store.recordUsage({ uuid: "p1", sessionId: "s1", model: "claude-opus-5", tokens: tok(10), at: 1, cost: 1 });
    const rows = store.db.query("SELECT message_uuid, run_id, agent_id FROM usage ORDER BY message_uuid").all();
    expect(rows).toEqual([
      { message_uuid: "p1", run_id: null, agent_id: null },
      { message_uuid: "w1", run_id: "wf_1", agent_id: "a1" },
    ]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/usage.test.ts tests/cost-store.test.ts`
Expected: FAIL — `takeUsage` is not exported; `parsed.sidechain` is `undefined`; `run_id` is not a recognised column in the INSERT.

- [ ] **Step 3: Write the implementation**

Replace the body of `src/server/usage.ts` from the import line down through `tailUsage` with:

```ts
import { openSync, fstatSync, readSync, closeSync } from "node:fs";
import type { Store } from "./store.ts";
import { costOf, canonicalModel, type Tokens } from "./pricing.ts";
```

then widen `ParsedUsage` and `parseUsageLine` by exactly one field — everything else about that function stays as it is:

```ts
export interface ParsedUsage {
  uuid: string;
  model: string;
  tokens: Tokens;
  at: number; // epoch ms
  /** True when the line carries a subagent marker: `isSidechain: true` or an
   *  `agentId` field. Every workflow agent transcript line has one (C3); no
   *  parent transcript line on this machine does. The parent tail path skips
   *  these so a future fold-into-parent cannot double-charge (§1.5). */
  sidechain: boolean;
}
```
```ts
  const at = o.timestamp ? Date.parse(o.timestamp) : NaN;
  const sidechain = o?.isSidechain === true || o?.agentId != null;
  return { uuid, model: msg.model, tokens, at: Number.isFinite(at) ? at : 0, sidechain };
```

(The three existing `parseUsageLine` tests assert field-by-field, never `toEqual` on the whole object, so they stay green untouched.)

Then replace `tailUsage` with:

```ts
/** Read new complete lines from a transcript at `path`, price them, and record
 *  them. Returns the new byte offset (the position just past the last newline,
 *  so a partially-written final line is never consumed) and whether anything new
 *  landed. Persistence of the offset is the caller's job: sessions write
 *  `sessions.usage_offset`, workflow agents write `workflow_agents.offset`.
 *
 *  `sessionId` is always the PARENT session id, including for workflow agent
 *  transcripts — `recordUsage`'s subquery stamps project/branch from that row,
 *  which is what makes every existing cost aggregation correct for free.
 *
 *  `skipSidechain` is set by the PARENT path only (see tailUsage). Never set it
 *  for an agent transcript: every line in one is a sidechain (C3). */
export function takeUsage(
  store: Store,
  t: {
    path: string;
    offset: number;
    sessionId: string;
    runId?: string;
    agentId?: string;
    skipSidechain?: boolean;
  }
): { offset: number; recorded: boolean } {
  let fd: number;
  try {
    fd = openSync(t.path, "r");
  } catch {
    return { offset: t.offset, recorded: false }; // missing / unreadable
  }
  try {
    const size = fstatSync(fd).size;
    // Short-circuit BEFORE reading: agent transcripts reach 6.3MB and are polled
    // every 5s, so this is the difference between idle and tens of MB a minute.
    let offset = t.offset;
    if (offset < 0 || offset > size) offset = 0; // shrank / rotated → re-read
    if (size === offset) return { offset, recorded: false };

    const buf = Buffer.allocUnsafe(size - offset);
    // readSync may legally return a SHORT count, and the tail of an allocUnsafe
    // buffer is uninitialized memory — never look past what was actually read.
    const got = readSync(fd, buf, 0, buf.length, offset);
    if (got <= 0) return { offset, recorded: false };
    const chunk = buf.subarray(0, got);
    // Find the last newline BYTE: 0x0A never occurs inside a multi-byte UTF-8
    // sequence, so this is exact without decoding first.
    const nl = chunk.lastIndexOf(0x0a);
    if (nl < 0) return { offset, recorded: false }; // no complete new line

    let recorded = false;
    for (const ln of chunk.subarray(0, nl + 1).toString("utf8").split("\n")) {
      if (!ln.trim()) continue;
      const parsed = parseUsageLine(ln);
      if (!parsed) continue;
      // Double-count guard (§1.5): on the parent path, a line marked as a
      // subagent's (isSidechain / agentId) belongs to an agent-*.jsonl we tail
      // separately. A no-op today — 0 such lines exist in any parent transcript —
      // it neutralises a future fold-into-parent under fresh uuids, which
      // INSERT OR IGNORE could not dedupe. The offset still advances past it.
      if (t.skipSidechain && parsed.sidechain) continue;
      const ok = store.recordUsage({
        uuid: parsed.uuid,
        sessionId: t.sessionId,
        // Store the canonical id so per-model rollups group cleanly.
        model: canonicalModel(parsed.model),
        tokens: parsed.tokens,
        at: parsed.at,
        cost: costOf(parsed.model, parsed.tokens),
        runId: t.runId,
        agentId: t.agentId,
      });
      if (ok) recorded = true;
    }
    return { offset: offset + nl + 1, recorded };
  } finally {
    closeSync(fd);
  }
}

/** Session-transcript wrapper over `takeUsage` that persists the offset onto the
 *  `sessions` row. Signature unchanged so http.ts and the 60s sweep still work. */
export function tailUsage(
  store: Store,
  session: { id: string; transcript_path: string | null; usage_offset: number }
): boolean {
  if (!session.transcript_path) return false;
  const r = takeUsage(store, {
    path: session.transcript_path,
    offset: session.usage_offset,
    sessionId: session.id,
    // The ONLY caller that sets this. Workflow agent transcripts must not.
    skipSidechain: true,
  });
  if (r.offset !== session.usage_offset) store.setUsageOffset(session.id, r.offset);
  return r.recorded;
}
```

In `src/server/store.ts`, widen `recordUsage`'s parameter and INSERT:

```ts
  recordUsage(u: {
    uuid: string;
    sessionId: string;
    model: string;
    tokens: Tokens;
    at: number;
    cost: number;
    runId?: string;
    agentId?: string;
  }): boolean {
```
and inside it, add the two columns/values and the two params:
```ts
        `INSERT OR IGNORE INTO usage
           (message_uuid, session_id, model, input_tokens, output_tokens,
            cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens, cost_usd, project, branch, at,
            run_id, agent_id)
         VALUES ($u, $s, $m, $in, $out, $cr, $c5, $c1, $cost,
                 (SELECT project FROM sessions WHERE id = $s),
                 (SELECT branch FROM sessions WHERE id = $s), $at,
                 $run, $agent)`
```
```ts
        $at: u.at,
        $run: u.runId ?? null,
        $agent: u.agentId ?? null,
```

**Note for the implementer:** the offset is now a **byte** offset where it used to be a JS **character** count. Byte offsets are ≥ character offsets, so every previously-stored `sessions.usage_offset` is now slightly *early* on transcripts containing non-ASCII — the effect is one extra re-parse pass whose rows are all dropped by `INSERT OR IGNORE`. This is safe and is the reason the existing `tailUsage` tests must pass unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/ && bun run typecheck`
Expected: PASS — including the three pre-existing `describe("tailUsage", …)` tests, untouched.

- [ ] **Step 5: Commit**

```bash
git add src/server/usage.ts src/server/store.ts tests/usage.test.ts tests/cost-store.test.ts
git commit -m "refactor(usage): path-based takeUsage core with statSync short-circuit + run/agent stamping"
```

---

### Task 7: config constants, frozen fixtures, `sessionDirFor`, `deriveRunState` (§1.2, §1.4, §6)

**Files:**
- Modify: `src/server/config.ts` (append 5 constants)
- Create: `src/server/workflows.ts`
- Create: `tests/workflows.test.ts`
- Create: `tests/fixtures/workflows/` (9 frozen files, captured by the script in Step 1)

**Interfaces:**
- Produces:
  ```ts
  // src/server/config.ts
  export const WF_TICK_MS: number;      // 5_000
  export const WF_QUIET_MS: number;     // 600_000
  export const WF_RECHECK_MS: number;   // 86_400_000
  export const WORKFLOWS_ENABLED: boolean;
  export const CLAUDE_PROJECTS_DIR: string;

  // src/server/workflows.ts
  export function sessionDirFor(transcriptPath: string): string;
  export function deriveRunState(
    run: { manifest_seen: boolean; status: string | null; last_seen_at: number | null; session_status: string },
    now: number
  ): "running" | "settled" | "orphaned";
  export function workflowsDegraded(): number;
  export function bumpDegraded(n?: number): void;
  export function resetDegraded(): void;          // tests only; clears the log memory too
  export function logOnce(key: string, err: unknown): boolean;   // true ⇒ it actually logged
  ```

**`logOnce` returns a boolean and every `bumpDegraded()` is gated on it** (spec §5.5). A cause that recurs every 5s tick — an unparseable manifest, an unreadable run dir — logs once and counts **once**, so `workflows_degraded` reads as "how many things are wrong", not "how long has it been wrong". Call sites in Tasks 12, 13 and 21 all take the form `if (logOnce(key, err)) bumpDegraded();` (or `if (cond && logOnce(…)) bumpDegraded(n);` where the cause carries a count).

**Deviation from the spec, deliberate:** §1.2 lists 4 constants; this adds a 5th, `CLAUDE_PROJECTS_DIR`, so the startup backfill (Task 13) can be pointed at a temp dir in tests instead of the real `~/.claude`.

- [ ] **Step 1: Capture the frozen fixtures**

These are **frozen copies** — capture once, then only ever assert against the copies. Never assert against a path under `~/.claude`; those files keep moving.

```bash
mkdir -p /home/lunatic/projects/work/agent-monitor/tests/fixtures/workflows
python3 - <<'PY'
import json, os, shutil, pathlib
OUT = pathlib.Path("/home/lunatic/projects/work/agent-monitor/tests/fixtures/workflows")
A = pathlib.Path("/home/lunatic/.claude/projects/-home-lunatic-projects-work-agent-monitor/df8a5ade-bcdf-44e6-9248-4dd022f96b14")
B = pathlib.Path("/home/lunatic/.claude/projects/-home-lunatic-projects-work-browns-oxygenrx-malta-scoping/85441d1f-c8e8-413d-8b7f-44174dd2d6e2")

STRIP_RUN = ("script", "args", "logs", "result")
STRIP_AGENT = ("resultPreview",)

def manifest(src, dst):
    d = json.load(open(src))
    for k in STRIP_RUN:
        d.pop(k, None)
    for e in d.get("workflowProgress") or []:
        if isinstance(e, dict):
            for k in STRIP_AGENT:
                e.pop(k, None)
    json.dump(d, open(OUT / dst, "w"), indent=1)

def journal(src, dst):
    with open(OUT / dst, "w") as out:
        for ln in open(src):
            if not ln.strip():
                continue
            o = json.loads(ln)
            o.pop("result", None)          # huge, and it is work content
            out.write(json.dumps(o) + "\n")

manifest(A / "workflows/wf_eb7bf7e8-8a5.json", "wf_eb7bf7e8-8a5.manifest.json")
manifest(B / "workflows/wf_57b2617f-124.json", "wf_57b2617f-124.manifest.json")
journal(A / "subagents/workflows/wf_eb7bf7e8-8a5/journal.jsonl", "wf_eb7bf7e8-8a5.journal.jsonl")
journal(B / "subagents/workflows/wf_57b2617f-124/journal.jsonl", "wf_57b2617f-124.journal.jsonl")
journal(A / "subagents/workflows/wf_de7ba892-786/journal.jsonl", "wf_de7ba892-786.journal.jsonl")
shutil.copy(A / "workflows/scripts/workflows-monitoring-research-wf_eb7bf7e8-8a5.js",
            OUT / "script-with-phases.js")

# meta files: one 65-byte form (has `model`), one 48-byte form (no `model`)
metas = sorted((A / "subagents/workflows/wf_371816c5-ceb").glob("agent-*.meta.json"))
with_model = next(p for p in metas if "model" in json.load(open(p)))
shutil.copy(with_model, OUT / "agent-meta-with-model.json")
json.dump({"agentType": "workflow-subagent", "spawnDepth": 1}, open(OUT / "agent-meta-no-model.json", "w"))

# agent transcript header: first 4 lines, message.content clipped to 300 chars
src = A / "subagents/workflows/wf_371816c5-ceb/agent-a2d6696d4ad9f0332.jsonl"
with open(OUT / "agent-head.jsonl", "w") as out:
    for i, ln in enumerate(open(src)):
        if i >= 4:
            break
        o = json.loads(ln)
        m = o.get("message")
        if isinstance(m, dict) and isinstance(m.get("content"), str):
            m["content"] = m["content"][:300]
        out.write(json.dumps(o) + "\n")
print(sorted(p.name for p in OUT.iterdir()))
PY
```

Expected: 9 files listed. Sanity-check that nothing sensitive survived:

```bash
cd /home/lunatic/projects/work/agent-monitor && \
  grep -l -E '"(script|args|logs|result|resultPreview)" *:' tests/fixtures/workflows/*.json tests/fixtures/workflows/*.jsonl
```
Expected: no output (exit 1).

The `" *:` anchor is load-bearing: it matches a stripped **key**, not a value. Every
journal `result` line carries `"type": "result"`, so an unanchored
`'"(…|result|…)"'` grep matches all three journal fixtures and the check reads as a
false failure. Verified against the real files.

- [ ] **Step 2: Write the failing tests**

Create `tests/workflows.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sessionDirFor, deriveRunState } from "../src/server/workflows.ts";
import { WF_QUIET_MS } from "../src/server/config.ts";

export const FIX = join(import.meta.dir, "fixtures", "workflows");
export const fixture = (name: string): string => readFileSync(join(FIX, name), "utf8");

describe("sessionDirFor", () => {
  it("strips the .jsonl suffix from a transcript path (C9, exact for 20/20 runs)", () => {
    expect(sessionDirFor("/home/u/.claude/projects/-slug/abc-123.jsonl")).toBe(
      "/home/u/.claude/projects/-slug/abc-123"
    );
  });
  it("leaves a path with no .jsonl suffix alone", () => {
    expect(sessionDirFor("/home/u/.claude/projects/-slug/abc-123")).toBe(
      "/home/u/.claude/projects/-slug/abc-123"
    );
  });
});

describe("deriveRunState", () => {
  const NOW = 1_800_000_000_000;
  const run = (over: Partial<Parameters<typeof deriveRunState>[0]> = {}) => ({
    manifest_seen: false,
    status: null,
    last_seen_at: NOW,
    session_status: "working",
    ...over,
  });

  it("stays running when a manifest exists but the dir is still moving (C6 regression)", () => {
    // wf_3b398ae6-146 had a `failed` manifest with agent files still appending
    // 6 minutes later. Sealing on manifest_seen would have lost that spend.
    expect(deriveRunState(run({ manifest_seen: true, status: "failed", last_seen_at: NOW - 1000 }), NOW)).toBe("running");
  });

  it("settles once a manifest exists and the dir has been quiet for WF_QUIET_MS", () => {
    expect(deriveRunState(run({ manifest_seen: true, last_seen_at: NOW - WF_QUIET_MS - 1 }), NOW)).toBe("settled");
  });

  it("un-settles when the dir mtime advances again", () => {
    expect(deriveRunState(run({ manifest_seen: true, last_seen_at: NOW }), NOW)).toBe("running");
  });

  it("reports orphaned for a quiet run with no manifest (hard-killed CLI writes none)", () => {
    expect(deriveRunState(run({ manifest_seen: false, last_seen_at: NOW - WF_QUIET_MS - 1 }), NOW)).toBe("orphaned");
  });

  it("reports orphaned when the owning session has ended, even if the dir just moved", () => {
    expect(deriveRunState(run({ session_status: "ended", last_seen_at: NOW }), NOW)).toBe("orphaned");
  });

  it("treats a never-seen run (null last_seen_at) as quiet", () => {
    expect(deriveRunState(run({ manifest_seen: true, last_seen_at: null }), NOW)).toBe("settled");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/workflows.test.ts`
Expected: FAIL — cannot resolve `../src/server/workflows.ts`.

- [ ] **Step 4: Write the implementation**

Append to `src/server/config.ts`:

```ts
/** Workflow scan cadence. A live run must feel live; 60s freezes the card. */
export const WF_TICK_MS = 5 * 1000;
/** Run dir mtime unchanged this long ⇒ stop tailing (ACTIVE → SETTLED). The same
 *  window, combined with a missing manifest, is what reads as `orphaned` — a
 *  display state only, never persisted. */
export const WF_QUIET_MS = 10 * 60 * 1000;
/** Settled runs younger than this are re-stat'd to catch resumed appends (C6). */
export const WF_RECHECK_MS = 24 * 60 * 60 * 1000;
/** Kill switch. AM_WORKFLOWS=0 disables the scanner entirely. */
export const WORKFLOWS_ENABLED = process.env.AM_WORKFLOWS !== "0";
/** Root of Claude Code's per-project transcript tree. Only the one-time startup
 *  backfill globs this; the steady-state scan walks session transcript paths. */
export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
```

Create `src/server/workflows.ts`:

```ts
import { WF_QUIET_MS } from "./config.ts";

/** A session's on-disk directory is its transcript path minus `.jsonl` — exact
 *  for 20 of 20 surveyed runs (C9). Never recompute the project slug from cwd. */
export function sessionDirFor(transcriptPath: string): string {
  return transcriptPath.replace(/\.jsonl$/, "");
}

/** Liveness from two independent signals — structure (`manifest_seen`) and motion
 *  (`last_seen_at`, which is the run dir's mtime as of the last tick that saw it,
 *  NOT the time we last looked). Pure: no I/O, no agent argument.
 *
 *  Rules in force order (spec §1.4):
 *   1. manifest + quiet ⇒ settled. A manifest is terminal for STRUCTURE only —
 *      it never stops cost tailing, which is why "running" wins while the dir moves.
 *   2. quiet with no manifest, or an ended owning session ⇒ orphaned (display only,
 *      never persisted; self-healing if files move again).
 *   3. otherwise running. */
export function deriveRunState(
  run: {
    manifest_seen: boolean;
    status: string | null;
    last_seen_at: number | null;
    session_status: string;
  },
  now: number
): "running" | "settled" | "orphaned" {
  const quiet = run.last_seen_at == null || now - run.last_seen_at > WF_QUIET_MS;
  if (run.manifest_seen && quiet) return "settled";
  if (quiet || run.session_status === "ended") return "orphaned";
  return "running";
}

/** One console.warn per key per process, modelled on the `warned` Set in
 *  pricing.ts. Keys are run ids — once per run, not per tick (§5.5). */
const warnedRuns = new Set<string>();

/** Process-lifetime counter of parse failures, unknown journal line types and
 *  zero-agent manifests. Surfaced as `workflows_degraded` in buildState (§5.9).
 *  Resetting on restart is intended: a restart is how you clear the banner.
 *
 *  Every bump is gated on `logOnce` returning true, so a cause that recurs on
 *  every 5s tick counts ONCE per run per cause, not 720 times an hour (§5.5). */
let degraded = 0;
export function workflowsDegraded(): number {
  return degraded;
}
export function bumpDegraded(n = 1): void {
  degraded += n;
}
/** Tests only. Clears the once-per-key log memory as well as the counter — the
 *  two are coupled now, and fixtures reuse a fixed run id (`wf_t1`) across tests,
 *  so a stale key would silently suppress the next test's bump. */
export function resetDegraded(): void {
  degraded = 0;
  warnedRuns.clear();
}

/** Warn once per key (see `warnedRuns` above), and return TRUE only on the pass
 *  that actually logged. Callers gate `bumpDegraded()` on that boolean, which is
 *  what makes the degraded counter once-per-run-per-cause instead of
 *  once-per-tick. */
export function logOnce(key: string, err: unknown): boolean {
  if (warnedRuns.has(key)) return false;
  warnedRuns.add(key);
  console.warn(`[workflows] ${key}: ${String(err)}`);
  return true;
}
```

Also add `homedir`/`join` imports to `config.ts` if not already present — they are (`node:os`, `node:path`, lines 1-2).

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/workflows.test.ts && bun run typecheck` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/config.ts src/server/workflows.ts tests/workflows.test.ts tests/fixtures/workflows
git commit -m "feat(workflows): config constants, sessionDirFor, deriveRunState + frozen fixtures"
```

---

### Task 8: `parseManifest` (§1.3, §5.1–5.6)

**Files:**
- Modify: `src/server/workflows.ts` (append)
- Test: `tests/workflows.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: fixtures from Task 7 via the exported `fixture(name)` helper in `tests/workflows.test.ts`.
- Produces:
  ```ts
  export interface Phase { title: string; detail: string | null }
  export interface ManifestAgent {
    agent_id: string; label: string | null; phase_index: number | null; phase_title: string | null;
    idx: number | null; model: string | null; state: string | null; attempt: number | null;
    last_tool: string | null; last_tool_summary: string | null; prompt_preview: string | null;
    started_at: number | null; duration_ms: number | null; tool_calls: number | null;
  }
  export interface ManifestView {
    name: string | null; status: string | null; summary: string | null;
    started_at: number | null; ended_at: number | null; duration_ms: number | null;
    agent_count: number | null; total_tokens_reported: number | null;
    phases: Phase[]; agents: ManifestAgent[]; schema_ok: boolean; error: string | null;
  }
  export function parseManifest(text: string): ManifestView | null;  // null ⇒ not JSON at all
  ```

**Independent of Tasks 9 and 10.**

- [ ] **Step 1: Write the failing tests**

Append to `tests/workflows.test.ts` (add `parseManifest` to the import):

```ts
describe("parseManifest", () => {
  it("reads the real manifest: status, times, phases, and 1-based indices", () => {
    const m = parseManifest(fixture("wf_eb7bf7e8-8a5.manifest.json"))!;
    expect(m.status).toBe("completed");
    expect(m.schema_ok).toBe(true);
    expect(typeof m.started_at).toBe("number"); // startTime is epoch ms
    expect(m.ended_at).toBe(Date.parse("2026-08-10T07:16:36.681Z")); // timestamp is ISO
    expect(m.phases.length).toBeGreaterThan(0);
    expect(m.phases[0].title).toBe("Explore");
    // index/phaseIndex are stored VERBATIM, 1-based — a phase pill reads
    // `Phase ${phaseIndex}/${phases.length}` with no arithmetic.
    expect(m.agents[0].idx).toBe(1);
    expect(m.agents[0].phase_index).toBe(1);
    expect(Math.max(...m.agents.map((a) => a.phase_index ?? 0))).toBe(m.phases.length);
  });

  it("filters workflowProgress to type === 'workflow_agent' (workflow_phase entries are dropped)", () => {
    const raw = JSON.parse(fixture("wf_eb7bf7e8-8a5.manifest.json"));
    const total = (raw.workflowProgress as any[]).length;
    const agents = (raw.workflowProgress as any[]).filter((e) => e?.type === "workflow_agent").length;
    expect(agents).toBeLessThan(total); // the fixture really does carry both types
    expect(parseManifest(fixture("wf_eb7bf7e8-8a5.manifest.json"))!.agents.length).toBe(agents);
  });

  it("returns null for a truncated manifest rather than throwing", () => {
    const half = fixture("wf_eb7bf7e8-8a5.manifest.json").slice(0, 400);
    expect(parseManifest(half)).toBeNull();
  });

  it("keeps status/duration/tokens when workflowProgress is missing, and flags schema_ok=0", () => {
    const raw = JSON.parse(fixture("wf_eb7bf7e8-8a5.manifest.json"));
    delete raw.workflowProgress;
    const m = parseManifest(JSON.stringify(raw))!;
    expect(m.status).toBe("completed");
    expect(m.duration_ms).toBe(raw.durationMs);
    expect(m.total_tokens_reported).toBe(raw.totalTokens);
    expect(m.agents).toEqual([]);
    expect(m.schema_ok).toBe(false);
    expect(m.error).toBe("manifest parsed 0 agents");
  });

  it("stores an unknown status string verbatim (C11: `failed` already broke the vocabulary)", () => {
    const raw = JSON.parse(fixture("wf_eb7bf7e8-8a5.manifest.json"));
    raw.status = "quantum-superposition";
    expect(parseManifest(JSON.stringify(raw))!.status).toBe("quantum-superposition");
  });

  it("survives a manifest whose agent entries are missing optional fields", () => {
    const raw = JSON.parse(fixture("wf_eb7bf7e8-8a5.manifest.json"));
    raw.workflowProgress = [{ type: "workflow_agent", agentId: "bare" }];
    const m = parseManifest(JSON.stringify(raw))!;
    expect(m.agents).toEqual([
      {
        agent_id: "bare", label: null, phase_index: null, phase_title: null, idx: null,
        model: null, state: null, attempt: null, last_tool: null, last_tool_summary: null,
        prompt_preview: null, started_at: null, duration_ms: null, tool_calls: null,
      },
    ]);
  });

  it("reads the 10-entry manifest of a run that has 13 agent transcripts", () => {
    const m = parseManifest(fixture("wf_57b2617f-124.manifest.json"))!;
    expect(m.agents.length).toBe(10);
    expect(m.agent_count).toBe(10);
    // attempt is 1 on every surveyed entry — display only, never retry detection.
    expect(m.agents.every((a) => a.attempt === 1 || a.attempt === null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/workflows.test.ts` — Expected: FAIL, `parseManifest is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/server/workflows.ts`:

```ts
export interface Phase {
  title: string;
  detail: string | null;
}

export interface ManifestAgent {
  agent_id: string;
  label: string | null;
  phase_index: number | null;
  phase_title: string | null;
  idx: number | null;
  model: string | null;
  state: string | null;
  attempt: number | null;
  last_tool: string | null;
  last_tool_summary: string | null;
  prompt_preview: string | null;
  started_at: number | null;
  duration_ms: number | null;
  tool_calls: number | null;
}

export interface ManifestView {
  name: string | null;
  status: string | null;
  summary: string | null;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  agent_count: number | null;
  total_tokens_reported: number | null;
  phases: Phase[];
  agents: ManifestAgent[];
  schema_ok: boolean;
  error: string | null;
}

/** Tolerant getters. NOTHING in this file destructures a parsed object (§5.1). */
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Parse a workflow manifest. Returns null only when the text is not JSON at all;
 *  a structurally surprising manifest still yields a partial view with
 *  `schema_ok = false` (the toolStats() precedent — degrade, never throw). */
export function parseManifest(text: string): ManifestView | null {
  let o: any;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;

  const phases: Phase[] = [];
  const rawPhases = Array.isArray(o.phases) ? o.phases : [];
  for (const p of rawPhases) {
    const title = str(p?.title);
    if (title) phases.push({ title, detail: str(p?.detail) });
  }

  const agents: ManifestAgent[] = [];
  const progress = Array.isArray(o.workflowProgress) ? o.workflowProgress : [];
  for (const e of progress) {
    // Entries of other types (workflow_phase today, more tomorrow) are ignored,
    // never destructured.
    if (e?.type !== "workflow_agent") continue;
    const id = str(e?.agentId);
    if (!id) continue;
    agents.push({
      agent_id: id,
      label: str(e?.label),
      phase_index: num(e?.phaseIndex),
      phase_title: str(e?.phaseTitle),
      idx: num(e?.index),
      model: str(e?.model),
      state: str(e?.state),
      attempt: num(e?.attempt),
      last_tool: str(e?.lastToolName),
      last_tool_summary: str(e?.lastToolSummary),
      prompt_preview: str(e?.promptPreview),
      started_at: num(e?.startedAt),
      duration_ms: num(e?.durationMs),
      tool_calls: num(e?.toolCalls),
    });
  }

  const endedIso = str(o.timestamp);
  const endedAt = endedIso ? Date.parse(endedIso) : NaN;
  const zeroAgents = agents.length === 0;

  return {
    name: str(o.workflowName),
    status: str(o.status), // RAW passthrough — no enum, no validation
    summary: str(o.summary),
    started_at: num(o.startTime),
    ended_at: Number.isFinite(endedAt) ? endedAt : null,
    duration_ms: num(o.durationMs),
    agent_count: num(o.agentCount),
    total_tokens_reported: num(o.totalTokens),
    phases,
    agents,
    schema_ok: !zeroAgents,
    error: zeroAgents ? "manifest parsed 0 agents" : null,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/workflows.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/workflows.ts tests/workflows.test.ts
git commit -m "feat(workflows): tolerant parseManifest with verbatim status + 1-based indices"
```

---

### Task 9: `parseJournal` — retry dedupe by journal key (§1.3, C7)

**Files:**
- Modify: `src/server/workflows.ts` (append)
- Test: `tests/workflows.test.ts` (append a `describe`)

**Interfaces:**
- Produces:
  ```ts
  export type AgentState = "running" | "done" | "abandoned";
  export interface JournalAgent { agent_id: string; journal_key: string; state: AgentState }
  export function parseJournal(
    lines: string[],
    opts: { manifestPresent: boolean }
  ): { agents: Map<string, JournalAgent>; unknownTypes: number };
  ```

**Independent of Tasks 8 and 10.**

- [ ] **Step 1: Write the failing tests**

Append to `tests/workflows.test.ts` (add `parseJournal` to the import):

```ts
const jlines = (name: string) => fixture(name).split("\n").filter((l) => l.trim());

describe("parseJournal", () => {
  it("gives every key's winner a row; with a manifest present none are left running", () => {
    // wf_eb7bf7e8-8a5: 6 started / 3 result over 6 distinct keys. This run
    // COMPLETED — 3 keys never got a result line, so `started`-without-`result`
    // cannot mean running once a manifest exists (C7).
    const { agents } = parseJournal(jlines("wf_eb7bf7e8-8a5.journal.jsonl"), { manifestPresent: true });
    expect(agents.size).toBe(6);
    expect([...agents.values()].filter((a) => a.state === "running").length).toBe(0);
  });

  it("marks resultless winners running only when the manifest is absent", () => {
    const { agents } = parseJournal(jlines("wf_eb7bf7e8-8a5.journal.jsonl"), { manifestPresent: false });
    expect([...agents.values()].filter((a) => a.state === "running").length).toBe(3);
    expect([...agents.values()].filter((a) => a.state === "done").length).toBe(3);
  });

  it("dedupes retries: the last agentId per key in FILE ORDER wins, earlier ones are abandoned", () => {
    // wf_57b2617f-124: 13 started / 10 result over 10 keys → 10 winners + 3 abandoned.
    // A retry reuses the key with a FRESH agentId; `attempt` stays 1, so it is
    // never the retry signal.
    const { agents } = parseJournal(jlines("wf_57b2617f-124.journal.jsonl"), { manifestPresent: true });
    expect(agents.size).toBe(13); // every agentId keeps its own row so its tokens attribute
    expect([...agents.values()].filter((a) => a.state === "abandoned").length).toBe(3);
    expect([...agents.values()].filter((a) => a.state === "done").length).toBe(10);
    const keys = new Set([...agents.values()].map((a) => a.journal_key));
    expect(keys.size).toBe(10);
  });

  it("marks an unmatched started as running on a manifest-less live run", () => {
    const { agents } = parseJournal(jlines("wf_de7ba892-786.journal.jsonl"), { manifestPresent: false });
    expect([...agents.values()].filter((a) => a.state === "running").length).toBeGreaterThan(0);
  });

  it("counts unknown line types and unparseable lines toward degraded, never throws", () => {
    const lines = [
      JSON.stringify({ type: "started", key: "k1", agentId: "a1" }),
      JSON.stringify({ type: "brand_new_type", key: "k1", agentId: "a1" }),
      "{not json",
    ];
    const { agents, unknownTypes } = parseJournal(lines, { manifestPresent: false });
    expect(unknownTypes).toBe(2);
    expect(agents.get("a1")!.state).toBe("running");
  });

  it("returns an empty map for an empty journal", () => {
    expect(parseJournal([], { manifestPresent: false }).agents.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/workflows.test.ts` — Expected: FAIL, `parseJournal is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/server/workflows.ts`:

```ts
export type AgentState = "running" | "done" | "abandoned";

export interface JournalAgent {
  agent_id: string;
  journal_key: string;
  state: AgentState;
}

/** Reduce a run's journal.jsonl into per-agent states (§1.3, C7).
 *
 *  `key` is an opaque content hash (`v2:<sha256>`) — a grouping key only, never
 *  rendered. Journal lines carry no timestamp, so FILE ORDER is the tiebreak:
 *  the last agentId seen for a key wins and earlier ones become `abandoned`.
 *  Abandoned agents keep their row so their tokens still attribute.
 *
 *  `started`-without-`result` means running ONLY when no manifest exists. A
 *  completed run legitimately has resultless keys (6 started / 3 result over 6
 *  keys was observed on a completed run) and would otherwise show phantom
 *  running agents forever. */
export function parseJournal(
  lines: string[],
  opts: { manifestPresent: boolean }
): { agents: Map<string, JournalAgent>; unknownTypes: number } {
  let unknownTypes = 0;
  const keyOrder = new Map<string, string[]>(); // key → agentIds in file order
  const keyOf = new Map<string, string>(); // agentId → key
  const hasResult = new Set<string>(); // agentIds with a result line

  for (const ln of lines) {
    if (!ln.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(ln);
    } catch {
      unknownTypes++;
      continue;
    }
    const type = str(o?.type);
    if (type !== "started" && type !== "result") {
      unknownTypes++;
      continue;
    }
    const key = str(o?.key);
    const id = str(o?.agentId);
    if (!key || !id) {
      unknownTypes++;
      continue;
    }
    const seq = keyOrder.get(key) ?? [];
    if (seq[seq.length - 1] !== id) seq.push(id);
    keyOrder.set(key, seq);
    keyOf.set(id, key);
    if (type === "result") hasResult.add(id);
  }

  const agents = new Map<string, JournalAgent>();
  for (const [key, seq] of keyOrder) {
    const winner = seq[seq.length - 1];
    for (const id of seq) {
      let state: AgentState;
      if (id !== winner) state = "abandoned";
      else if (hasResult.has(id)) state = "done";
      else state = opts.manifestPresent ? "done" : "running";
      agents.set(id, { agent_id: id, journal_key: key, state });
    }
  }
  return { agents, unknownTypes };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/workflows.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/workflows.ts tests/workflows.test.ts
git commit -m "feat(workflows): parseJournal with file-order retry dedupe by opaque key"
```

---

### Task 10: `parseAgentMeta`, `parseAgentHeader`, `parseScriptMeta` + script lookup (§1.3)

**Files:**
- Modify: `src/server/workflows.ts` (append)
- Test: `tests/workflows.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `truncate(s, n)` from `src/server/derive.ts` — **the length must be passed explicitly**; its default is `MAX_INTENT_LEN` (140), not 160.
- Produces:
  ```ts
  export function parseAgentMeta(text: string): { agent_type: string | null; model: string | null };
  export function parseAgentHeader(head: string): {
    cc_version: string | null; model: string | null; prompt_preview: string | null;
  };
  export function parseScriptMeta(text: string): { name: string | null; phases: Phase[] };
  /** Primary lookup: <sessionDir>/workflows/scripts/*-<runId>.js. Cheap; runs on every ACTIVE tick. */
  export function findScriptFile(sessionDir: string, runId: string): string | null;
  /** Fallback (C9): ~/.claude/projects/*<sessionId>/workflows/scripts/*-<runId>.js.
   *  ONCE per run, at discovery/backfill only — never on a steady-state 5s tick. */
  export function findScriptAcrossSlugs(sessionDir: string, runId: string): string | null;
  ```

**Independent of Tasks 8 and 9.**

**Approved amendment to the spec's earlier "look under `<sessionDir>` and nowhere else":** 3 of 20 runs keep their script under a *sibling project slug* carrying the **same** sessionId (C9), so `findScriptAcrossSlugs` derives the projects root by **path structure** — `<sessionDir>` is `<root>/<slug>/<sessionId>`, so the root is two levels up — and does one `readdir` per slug for that one sessionId and that one runId. No new config, no `~` lookup, and temp trees in tests work unchanged. Task 12 gates it to the discovering pass.

- [ ] **Step 1: Write the failing tests**

Append to `tests/workflows.test.ts` (add the three functions to the import):

```ts
describe("parseAgentMeta", () => {
  it("reads the bare model alias from the 65-byte form", () => {
    const m = parseAgentMeta(fixture("agent-meta-with-model.json"));
    expect(m.agent_type).toBe("workflow-subagent");
    expect(typeof m.model).toBe("string"); // e.g. "sonnet" — canonicalModel() handles it
  });
  it("returns model: null for the 48-byte form (32 of 116 files omit it — not an edge case)", () => {
    expect(parseAgentMeta(fixture("agent-meta-no-model.json")).model).toBeNull();
  });
  it("returns nulls rather than throwing on malformed JSON", () => {
    expect(parseAgentMeta("{nope")).toEqual({ agent_type: null, model: null });
  });
});

describe("parseAgentHeader", () => {
  it("pulls cc_version, the first message.model, and a 160-char prompt preview", () => {
    const h = parseAgentHeader(fixture("agent-head.jsonl"));
    expect(h.cc_version).toMatch(/^\d+\.\d+\.\d+$/); // 2.1.226 on recent runs
    expect(h.model).toBe("claude-sonnet-5"); // first line carrying message.model
    expect(h.prompt_preview!.length).toBeLessThanOrEqual(160);
    expect(h.prompt_preview!.startsWith("Implement a bug fix")).toBe(true);
  });
  it("returns nulls for an empty or unparseable head", () => {
    expect(parseAgentHeader("")).toEqual({ cc_version: null, model: null, prompt_preview: null });
    expect(parseAgentHeader("{not json\n")).toEqual({ cc_version: null, model: null, prompt_preview: null });
  });
});

describe("parseScriptMeta", () => {
  it("extracts the workflow name and phase skeleton from the script source", () => {
    const s = parseScriptMeta(fixture("script-with-phases.js"));
    expect(s.name).toBe("workflows-monitoring-research");
    expect(s.phases).toEqual([{ title: "Explore", detail: "codebase map, docs research, on-disk artifacts" }]);
  });
  it("returns empty phases when the source has no meta block", () => {
    expect(parseScriptMeta("console.log('hi')")).toEqual({ name: null, phases: [] });
  });
});

describe("script lookup", () => {
  /** projects root ≙ ~/.claude/projects: <root>/<slug>/<sessionId>/workflows/scripts */
  function makeProjects(opts: { underOwnSlug?: boolean; underSibling?: boolean }) {
    const root = mkdtempSync(join(tmpdir(), "am-scripts-"));
    const own = join(root, "-home-u-repo", "sess-1");
    const sibling = join(root, "-home-u-repo-sub", "sess-1");
    mkdirSync(join(own, "workflows", "scripts"), { recursive: true });
    mkdirSync(join(sibling, "workflows", "scripts"), { recursive: true });
    if (opts.underOwnSlug) writeFileSync(join(own, "workflows", "scripts", "research-wf_1.js"), fixture("script-with-phases.js"));
    if (opts.underSibling) writeFileSync(join(sibling, "workflows", "scripts", "research-wf_1.js"), fixture("script-with-phases.js"));
    return { root, sessionDir: own };
  }

  it("finds the script under the session's own dir, matching by the -<runId>.js suffix", () => {
    const { sessionDir } = makeProjects({ underOwnSlug: true });
    expect(findScriptFile(sessionDir, "wf_1")).toBe(join(sessionDir, "workflows", "scripts", "research-wf_1.js"));
    expect(findScriptFile(sessionDir, "wf_other")).toBeNull(); // suffix match, never a prefix
  });

  it("returns null rather than throwing when the scripts dir does not exist", () => {
    expect(findScriptFile("/no/such/session", "wf_1")).toBeNull();
  });

  it("resolves a script parked under a SIBLING slug with the same sessionId (C9's 3 split runs)", () => {
    const { root, sessionDir } = makeProjects({ underSibling: true });
    expect(findScriptFile(sessionDir, "wf_1")).toBeNull(); // the primary lookup misses
    expect(findScriptAcrossSlugs(sessionDir, "wf_1")).toBe(
      join(root, "-home-u-repo-sub", "sess-1", "workflows", "scripts", "research-wf_1.js")
    );
  });

  it("returns null when no slug holds a script for that run (2 of 20 runs have none)", () => {
    const { sessionDir } = makeProjects({});
    expect(findScriptAcrossSlugs(sessionDir, "wf_1")).toBeNull();
  });

  it("never looks outside the projects root or at another sessionId", () => {
    const { root, sessionDir } = makeProjects({ underSibling: true });
    // Same runId, different session → not ours. The glob is pinned to both.
    mkdirSync(join(root, "-home-u-other", "sess-2", "workflows", "scripts"), { recursive: true });
    writeFileSync(join(root, "-home-u-other", "sess-2", "workflows", "scripts", "research-wf_9.js"), "x");
    expect(findScriptAcrossSlugs(sessionDir, "wf_9")).toBeNull();
  });
});
```

Add `mkdtempSync`, `mkdirSync` and `writeFileSync` to the `node:fs` import and `tmpdir` from `node:os` (Task 12 uses the same set — import them once).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/workflows.test.ts` — Expected: FAIL, `parseAgentMeta is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/server/workflows.ts` (add `import { truncate } from "./derive.ts";` at the top):

```ts
/** `agent-<id>.meta.json` is 48–65 bytes: {agentType, spawnDepth, model?}.
 *  `model` is usually a bare alias and is DISPLAY ONLY — never a pricing input,
 *  which always reads `message.model` off the transcript line. */
export function parseAgentMeta(text: string): { agent_type: string | null; model: string | null } {
  let o: any;
  try {
    o = JSON.parse(text);
  } catch {
    return { agent_type: null, model: null };
  }
  return { agent_type: str(o?.agentType), model: str(o?.model) };
}

/** Read what we need from the head of an agent transcript: the Claude Code
 *  `version` (for the "format last verified on X" badge), the first line
 *  carrying a `message.model` (the fallback when the meta file omits `model` —
 *  32 of 116 do), and the prompt preview.
 *
 *  `head` is the first few KB of the file; pass whatever you have. */
export function parseAgentHeader(head: string): {
  cc_version: string | null;
  model: string | null;
  prompt_preview: string | null;
} {
  let cc_version: string | null = null;
  let model: string | null = null;
  let prompt_preview: string | null = null;

  for (const ln of head.split("\n")) {
    if (!ln.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(ln);
    } catch {
      continue; // a clipped final line is expected when `head` is a byte slice
    }
    if (!cc_version) cc_version = str(o?.version);
    if (!model) model = str(o?.message?.model);
    if (!prompt_preview) {
      const content = o?.message?.content;
      let text: string | null = null;
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        const part = content.find((c: any) => typeof c?.text === "string");
        text = str(part?.text);
      }
      // 160 MUST be passed explicitly — truncate()'s default is MAX_INTENT_LEN (140).
      if (text) prompt_preview = truncate(text, 160);
    }
    if (cc_version && model && prompt_preview) break;
  }
  return { cc_version, model, prompt_preview };
}

/** The workflow script is the ONLY live source of phase titles. It is plain JS
 *  with an `export const meta = { name, description, phases: [{title, detail}] }`
 *  header, so this is a deliberately shallow regex read of that header — not a
 *  parser. Best-effort: 2 of 20 runs have no script at all and 3 more have one
 *  only under a sibling project slug, which we deliberately do NOT search (§1.3).
 *  A miss costs a phase label on a live run; the completed run gets full phases
 *  from its manifest anyway. */
export function parseScriptMeta(text: string): { name: string | null; phases: Phase[] } {
  const head = text.slice(0, 4000);
  const name = /name:\s*['"]([^'"]*)['"]/.exec(head)?.[1] ?? null;
  const phases: Phase[] = [];
  const open = head.indexOf("phases:");
  if (open >= 0) {
    const close = head.indexOf("]", open);
    const block = head.slice(open, close >= 0 ? close + 1 : undefined);
    const re = /title:\s*['"]([^'"]*)['"](?:\s*,\s*detail:\s*['"]([^'"]*)['"])?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) phases.push({ title: m[1], detail: m[2] ?? null });
  }
  return { name, phases };
}

/** ENOENT → empty, never a throw. Task 12's scanner reuses this. */
function readdirSafe(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

/** Primary script lookup, matched by the `-<runId>.js` SUFFIX — never by the
 *  manifest's `scriptPath`, whose filename is unreliable (C11). One readdir of a
 *  small dir; cheap enough to run on every ACTIVE tick. 15 of 20 runs hit here. */
export function findScriptFile(sessionDir: string, runId: string): string | null {
  const dir = join(sessionDir, "workflows", "scripts");
  const hit = readdirSafe(dir).find((n) => n.endsWith(`-${runId}.js`));
  return hit ? join(dir, hit) : null;
}

/** Fallback for C9's split: when a session's cwd moves into a subdirectory, Claude
 *  Code writes that run's script under a DIFFERENT project slug carrying the SAME
 *  sessionId (3 of 20 runs). Equivalent to the glob
 *  `~/.claude/projects/*<sessionId>/workflows/scripts/*-<runId>.js`, with the
 *  projects root derived by path structure — <sessionDir> is
 *  <root>/<slug>/<sessionId>, so the root is two levels up. That keeps the search
 *  inside the tree that already holds the run and needs no config (the same
 *  resolve-by-structure rule the backfill uses).
 *
 *  Pinned to ONE sessionId and ONE runId: a readdir per slug, never a tree walk.
 *  The CALLER is responsible for running this at most once per run (Task 12) —
 *  it must never land on a steady-state 5s tick. */
export function findScriptAcrossSlugs(sessionDir: string, runId: string): string | null {
  const sessionId = basename(sessionDir);
  const projectsRoot = resolve(sessionDir, "..", "..");
  for (const slug of readdirSafe(projectsRoot)) {
    const dir = join(projectsRoot, slug, sessionId, "workflows", "scripts");
    const hit = readdirSafe(dir).find((n) => n.endsWith(`-${runId}.js`));
    if (hit) return join(dir, hit);
  }
  return null;
}
```

Add `import { readdirSync } from "node:fs";` and `import { basename, join, resolve } from "node:path";` to `src/server/workflows.ts` (Task 12 extends both imports further).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/workflows.test.ts && bun run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/workflows.ts tests/workflows.test.ts
git commit -m "feat(workflows): parseAgentMeta / parseAgentHeader / parseScriptMeta + script lookup"
```

---

### Task 11: store writers — upserts, scan list, offsets (§2)

**Files:**
- Modify: `src/server/store.ts` (add a `// --- workflows ---` block after `costDaily`, ~line 370)
- Test: `tests/store.test.ts` (append a new top-level `describe("Store workflows", …)`)

**Interfaces:**
- Consumes: the `workflow_runs` / `workflow_agents` tables (Task 5).
- Produces:
  ```ts
  export interface WorkflowRunUpsert {
    run_id: string; session_id: string; dir: string;
    name?: string | null; summary?: string | null; status?: string | null; error?: string | null;
    started_at?: number | null; ended_at?: number | null; duration_ms?: number | null;
    agent_count?: number | null; phases?: string | null; cc_version?: string | null;
    manifest_seen?: boolean; manifest_mtime?: number | null; last_seen_at?: number | null;
    schema_ok?: boolean; total_tokens_reported?: number | null;
  }
  export interface WorkflowAgentUpsert {
    run_id: string; agent_id: string;
    label?: string | null; phase_index?: number | null; phase_title?: string | null; idx?: number | null;
    model?: string | null; state?: string | null; attempt?: number | null; journal_key?: string | null;
    last_tool?: string | null; last_tool_summary?: string | null; prompt_preview?: string | null;
    started_at?: number | null; ended_at?: number | null; duration_ms?: number | null; tool_calls?: number | null;
  }
  export interface WorkflowRunScanRow {
    run_id: string; session_id: string; dir: string; manifest_seen: number;
    manifest_mtime: number | null; status: string | null; last_seen_at: number | null;
    session_status: string;
  }
  Store.upsertWorkflowRun(r: WorkflowRunUpsert): void
  Store.upsertWorkflowAgent(a: WorkflowAgentUpsert): void
  Store.getWorkflowRun(runId: string): WorkflowRunScanRow | null
  Store.workflowRunsToScan(cutoff: number): WorkflowRunScanRow[]
  Store.workflowAgentOffsets(runId: string): { agent_id: string; offset: number }[]
  Store.setWorkflowAgentOffset(runId: string, agentId: string, offset: number): void
  ```

**Needs Task 5. Independent of Tasks 6–10.**

- [ ] **Step 1: Write the failing tests**

Append a new top-level `describe` to `tests/store.test.ts`:

```ts
describe("Store workflows", () => {
  let store: Store;
  beforeEach(() => {
    store = freshStore();
  });

  it("inserts a run, then enriches it without clobbering earlier non-null fields", () => {
    store.upsertWorkflowRun({ run_id: "wf_1", session_id: "s1", dir: "/d/wf_1", last_seen_at: 100 });
    store.upsertWorkflowRun({
      run_id: "wf_1", session_id: "s1", dir: "/d/wf_1",
      name: "research", status: "completed", manifest_seen: true, last_seen_at: 200,
      phases: JSON.stringify([{ title: "Explore", detail: null }]),
    });
    const row = store.db.query("SELECT * FROM workflow_runs WHERE run_id = 'wf_1'").get() as any;
    expect(row.name).toBe("research");
    expect(row.status).toBe("completed");
    expect(row.manifest_seen).toBe(1);
    expect(row.last_seen_at).toBe(200);
    // A later tick that knows less must not blank what an earlier one learned.
    store.upsertWorkflowRun({ run_id: "wf_1", session_id: "s1", dir: "/d/wf_1", last_seen_at: 300 });
    const after = store.db.query("SELECT name, status, last_seen_at FROM workflow_runs WHERE run_id = 'wf_1'").get() as any;
    expect(after.name).toBe("research");
    expect(after.last_seen_at).toBe(300);
  });

  it("stamps project/branch from the owning session at first sight and keeps them", () => {
    store.applyEvent("s1", { status: "working", project: "alpha", branch: "feat/x", last_activity_at: 1 }, 1);
    store.upsertWorkflowRun({ run_id: "wf_1", session_id: "s1", dir: "/d/wf_1", last_seen_at: 1 });
    store.applyEvent("s1", { branch: "main", last_activity_at: 2 }, 2); // session moves on
    store.upsertWorkflowRun({ run_id: "wf_1", session_id: "s1", dir: "/d/wf_1", last_seen_at: 2 });
    const row = store.db.query("SELECT project, branch FROM workflow_runs WHERE run_id = 'wf_1'").get();
    expect(row).toEqual({ project: "alpha", branch: "feat/x" });
  });

  it("leaves project/branch NULL for a run whose session row does not exist", () => {
    store.upsertWorkflowRun({ run_id: "wf_2", session_id: "ghost", dir: "/d/wf_2", last_seen_at: 1 });
    const row = store.db.query("SELECT project, branch FROM workflow_runs WHERE run_id = 'wf_2'").get();
    expect(row).toEqual({ project: null, branch: null });
  });

  it("upserts agents idempotently and never resets a stored byte offset", () => {
    store.upsertWorkflowAgent({ run_id: "wf_1", agent_id: "a1", state: "running" });
    store.setWorkflowAgentOffset("wf_1", "a1", 4096);
    store.upsertWorkflowAgent({ run_id: "wf_1", agent_id: "a1", state: "done", label: "read:saga" });
    const row = store.db.query("SELECT state, label, offset FROM workflow_agents WHERE run_id='wf_1' AND agent_id='a1'").get() as any;
    expect(row.state).toBe("done");
    expect(row.label).toBe("read:saga");
    expect(row.offset).toBe(4096); // the tail position survives enrichment
    expect(store.workflowAgentOffsets("wf_1")).toEqual([{ agent_id: "a1", offset: 4096 }]);
  });

  it("workflowRunsToScan returns recent runs with the owning session's status joined in", () => {
    store.applyEvent("live", { status: "working", last_activity_at: 1 }, 1);
    store.applyEvent("dead", { status: "ended", last_activity_at: 1 }, 1);
    store.upsertWorkflowRun({ run_id: "wf_recent", session_id: "live", dir: "/d/a", last_seen_at: 5_000 });
    store.upsertWorkflowRun({ run_id: "wf_ended", session_id: "dead", dir: "/d/b", last_seen_at: 5_000 });
    store.upsertWorkflowRun({ run_id: "wf_old", session_id: "live", dir: "/d/c", last_seen_at: 100 });

    const rows = store.workflowRunsToScan(1_000).sort((a, b) => a.run_id.localeCompare(b.run_id));
    expect(rows.map((r) => r.run_id)).toEqual(["wf_ended", "wf_recent"]); // wf_old is past the cutoff
    expect(rows.find((r) => r.run_id === "wf_ended")!.session_status).toBe("ended");
    expect(rows.find((r) => r.run_id === "wf_recent")!.session_status).toBe("working");
  });

  it("treats a purged owning session as ended so its runs read orphaned", () => {
    store.upsertWorkflowRun({ run_id: "wf_x", session_id: "ghost", dir: "/d/x", last_seen_at: 5_000 });
    expect(store.workflowRunsToScan(0)[0].session_status).toBe("ended");
  });

  it("carries manifest_mtime on the scan row so an in-place rewrite can be detected (C6)", () => {
    store.upsertWorkflowRun({ run_id: "wf_1", session_id: "s1", dir: "/d/wf_1", manifest_seen: true, manifest_mtime: 111, last_seen_at: 1 });
    expect(store.getWorkflowRun("wf_1")!.manifest_mtime).toBe(111);
    // A tick that only re-stat'd the dir must not blank what the last parse stored.
    store.upsertWorkflowRun({ run_id: "wf_1", session_id: "s1", dir: "/d/wf_1", last_seen_at: 2 });
    expect(store.getWorkflowRun("wf_1")!.manifest_mtime).toBe(111);
    // A re-parse after the rewrite advances it.
    store.upsertWorkflowRun({ run_id: "wf_1", session_id: "s1", dir: "/d/wf_1", manifest_seen: true, manifest_mtime: 222, last_seen_at: 3 });
    expect(store.getWorkflowRun("wf_1")!.manifest_mtime).toBe(222);
  });

  it("getWorkflowRun returns null for an unknown run", () => {
    expect(store.getWorkflowRun("nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/store.test.ts` — Expected: FAIL, `store.upsertWorkflowRun is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `src/server/store.ts`, after `costDaily`:

```ts
  // --- workflows ---------------------------------------------------------

  /** Insert-or-enrich a run row. `project`/`branch` are stamped from the owning
   *  session at FIRST sight only (matching recordUsage's convention) and never
   *  re-stamped. Every other column takes the new value when it is non-null and
   *  keeps the stored one otherwise, so a tick that knows less (no manifest yet)
   *  cannot blank what an earlier tick learned. */
  upsertWorkflowRun(r: WorkflowRunUpsert): void {
    this.db
      .query(
        `INSERT INTO workflow_runs
           (run_id, session_id, project, branch, name, summary, status, error, started_at, ended_at,
            duration_ms, agent_count, phases, cc_version, manifest_seen, manifest_mtime, last_seen_at,
            dir, schema_ok, total_tokens_reported)
         VALUES ($run, $sess,
                 (SELECT project FROM sessions WHERE id = $sess),
                 (SELECT branch FROM sessions WHERE id = $sess),
                 $name, $summary, $status, $error, $started, $ended, $dur, $count, $phases, $ver,
                 $manifest, $mmtime, $seen, $dir, $ok, $reported)
         ON CONFLICT(run_id) DO UPDATE SET
           name = COALESCE(excluded.name, workflow_runs.name),
           summary = COALESCE(excluded.summary, workflow_runs.summary),
           status = COALESCE(excluded.status, workflow_runs.status),
           error = excluded.error,
           started_at = COALESCE(excluded.started_at, workflow_runs.started_at),
           ended_at = COALESCE(excluded.ended_at, workflow_runs.ended_at),
           duration_ms = COALESCE(excluded.duration_ms, workflow_runs.duration_ms),
           agent_count = COALESCE(excluded.agent_count, workflow_runs.agent_count),
           phases = COALESCE(excluded.phases, workflow_runs.phases),
           cc_version = COALESCE(excluded.cc_version, workflow_runs.cc_version),
           manifest_seen = MAX(excluded.manifest_seen, workflow_runs.manifest_seen),
           manifest_mtime = COALESCE(excluded.manifest_mtime, workflow_runs.manifest_mtime),
           last_seen_at = COALESCE(excluded.last_seen_at, workflow_runs.last_seen_at),
           dir = excluded.dir,
           schema_ok = excluded.schema_ok,
           total_tokens_reported = COALESCE(excluded.total_tokens_reported, workflow_runs.total_tokens_reported)`
      )
      .run({
        $run: r.run_id,
        $sess: r.session_id,
        $name: r.name ?? null,
        $summary: r.summary ?? null,
        $status: r.status ?? null,
        $error: r.error ?? null,
        $started: r.started_at ?? null,
        $ended: r.ended_at ?? null,
        $dur: r.duration_ms ?? null,
        $count: r.agent_count ?? null,
        $phases: r.phases ?? null,
        $ver: r.cc_version ?? null,
        $manifest: r.manifest_seen ? 1 : 0,
        // Only a pass that actually stat'd the manifest passes this; a plain
        // re-stat tick leaves it null and COALESCE keeps the stored value.
        $mmtime: r.manifest_mtime ?? null,
        $seen: r.last_seen_at ?? null,
        $dir: r.dir,
        $ok: r.schema_ok === false ? 0 : 1,
        $reported: r.total_tokens_reported ?? null,
      });
  }

  /** Insert-or-enrich an agent row. `offset` is deliberately absent from this
   *  method — it is owned by setWorkflowAgentOffset so enrichment can never
   *  rewind the tail position. */
  upsertWorkflowAgent(a: WorkflowAgentUpsert): void {
    this.db
      .query(
        `INSERT INTO workflow_agents
           (run_id, agent_id, label, phase_index, phase_title, idx, model, state, attempt, journal_key,
            last_tool, last_tool_summary, prompt_preview, started_at, ended_at, duration_ms, tool_calls, offset)
         VALUES ($run, $agent, $label, $pidx, $ptitle, $idx, $model, $state, $attempt, $key,
                 $tool, $tsum, $prompt, $started, $ended, $dur, $calls, 0)
         ON CONFLICT(run_id, agent_id) DO UPDATE SET
           label = COALESCE(excluded.label, workflow_agents.label),
           phase_index = COALESCE(excluded.phase_index, workflow_agents.phase_index),
           phase_title = COALESCE(excluded.phase_title, workflow_agents.phase_title),
           idx = COALESCE(excluded.idx, workflow_agents.idx),
           model = COALESCE(excluded.model, workflow_agents.model),
           state = COALESCE(excluded.state, workflow_agents.state),
           attempt = COALESCE(excluded.attempt, workflow_agents.attempt),
           journal_key = COALESCE(excluded.journal_key, workflow_agents.journal_key),
           last_tool = COALESCE(excluded.last_tool, workflow_agents.last_tool),
           last_tool_summary = COALESCE(excluded.last_tool_summary, workflow_agents.last_tool_summary),
           prompt_preview = COALESCE(excluded.prompt_preview, workflow_agents.prompt_preview),
           started_at = COALESCE(excluded.started_at, workflow_agents.started_at),
           ended_at = COALESCE(excluded.ended_at, workflow_agents.ended_at),
           duration_ms = COALESCE(excluded.duration_ms, workflow_agents.duration_ms),
           tool_calls = COALESCE(excluded.tool_calls, workflow_agents.tool_calls)`
      )
      .run({
        $run: a.run_id,
        $agent: a.agent_id,
        $label: a.label ?? null,
        $pidx: a.phase_index ?? null,
        $ptitle: a.phase_title ?? null,
        $idx: a.idx ?? null,
        $model: a.model ?? null,
        $state: a.state ?? null,
        $attempt: a.attempt ?? null,
        $key: a.journal_key ?? null,
        $tool: a.last_tool ?? null,
        $tsum: a.last_tool_summary ?? null,
        $prompt: a.prompt_preview ?? null,
        $started: a.started_at ?? null,
        $ended: a.ended_at ?? null,
        $dur: a.duration_ms ?? null,
        $calls: a.tool_calls ?? null,
      });
  }

  private static readonly WF_SCAN_COLS = `r.run_id, r.session_id, r.dir, r.manifest_seen,
    r.manifest_mtime, r.status, r.last_seen_at, COALESCE(s.status, 'ended') AS session_status`;

  getWorkflowRun(runId: string): WorkflowRunScanRow | null {
    const row = this.db
      .query(
        `SELECT ${Store.WF_SCAN_COLS} FROM workflow_runs r
         LEFT JOIN sessions s ON s.id = r.session_id WHERE r.run_id = $run`
      )
      .get({ $run: runId });
    return (row as WorkflowRunScanRow) ?? null;
  }

  /** Runs worth touching this tick: never-seen ones plus anything whose dir moved
   *  after `cutoff` (= now - WF_RECHECK_MS). Beyond that window a run is final,
   *  which bounds the re-stat cost regardless of how much history accumulates.
   *  A purged owning session reads as 'ended' so deriveRunState calls it orphaned. */
  workflowRunsToScan(cutoff: number): WorkflowRunScanRow[] {
    return this.db
      .query(
        `SELECT ${Store.WF_SCAN_COLS} FROM workflow_runs r
         LEFT JOIN sessions s ON s.id = r.session_id
         WHERE r.last_seen_at IS NULL OR r.last_seen_at > $cutoff`
      )
      .all({ $cutoff: cutoff }) as WorkflowRunScanRow[];
  }

  workflowAgentOffsets(runId: string): { agent_id: string; offset: number }[] {
    return this.db
      .query(`SELECT agent_id, offset FROM workflow_agents WHERE run_id = $run ORDER BY agent_id`)
      .all({ $run: runId }) as { agent_id: string; offset: number }[];
  }

  setWorkflowAgentOffset(runId: string, agentId: string, offset: number): void {
    this.db
      .query(`UPDATE workflow_agents SET offset = $o WHERE run_id = $run AND agent_id = $agent`)
      .run({ $o: offset, $run: runId, $agent: agentId });
  }
```

Add the three interfaces above the `export class Store` declaration in the same file:

```ts
export interface WorkflowRunUpsert {
  run_id: string;
  session_id: string;
  dir: string;
  name?: string | null;
  summary?: string | null;
  status?: string | null;
  error?: string | null;
  started_at?: number | null;
  ended_at?: number | null;
  duration_ms?: number | null;
  agent_count?: number | null;
  phases?: string | null;
  cc_version?: string | null;
  manifest_seen?: boolean;
  /** The manifest file's mtime as of the parse that produced this upsert. A
   *  rewritten manifest (C6) advances it without touching the run dir, which is
   *  how scanRun knows to re-parse (§1.4). */
  manifest_mtime?: number | null;
  last_seen_at?: number | null;
  schema_ok?: boolean;
  total_tokens_reported?: number | null;
}

export interface WorkflowAgentUpsert {
  run_id: string;
  agent_id: string;
  label?: string | null;
  phase_index?: number | null;
  phase_title?: string | null;
  idx?: number | null;
  model?: string | null;
  state?: string | null;
  attempt?: number | null;
  journal_key?: string | null;
  last_tool?: string | null;
  last_tool_summary?: string | null;
  prompt_preview?: string | null;
  started_at?: number | null;
  ended_at?: number | null;
  duration_ms?: number | null;
  tool_calls?: number | null;
}

export interface WorkflowRunScanRow {
  run_id: string;
  session_id: string;
  dir: string;
  manifest_seen: number;
  manifest_mtime: number | null;
  status: string | null;
  last_seen_at: number | null;
  session_status: string;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/store.test.ts && bun run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/store.ts tests/store.test.ts
git commit -m "feat(store): workflow run/agent upserts, scan list and byte offsets"
```

---

### Task 12: `scanWorkflows()` — the scanner (§1.1, §1.2, §1.4, §1.5, §5)

**Files:**
- Modify: `src/server/workflows.ts` (append the impure half)
- Test: `tests/workflows.test.ts` (append a `describe`, against a **temp dir** — never `~/.claude`)

**Interfaces:**
- Consumes: `takeUsage` (Task 6, **without** `skipSidechain` — every agent line is a sidechain); `parseManifest` (8); `parseJournal` (9); `parseAgentMeta`/`parseAgentHeader`/`parseScriptMeta`/`findScriptFile`/`findScriptAcrossSlugs` (10); `Store.upsertWorkflowRun`/`upsertWorkflowAgent`/`getWorkflowRun`/`workflowRunsToScan`/`workflowAgentOffsets`/`setWorkflowAgentOffset` (11).
- Produces:
  ```ts
  export interface RunTarget { run_id: string; session_id: string; dir: string }
  export function scanRun(store: Store, t: RunTarget, now: number): boolean;   // true ⇒ something changed
  export function scanWorkflows(store: Store, now: number): { changed: boolean };
  ```
  (Task 21 widens `scanWorkflows`'s return to `{ changed: boolean; live: LiveWorkflow[] }`.)

**Needs Tasks 6, 8, 9, 10, 11.**

- [ ] **Step 1: Write the failing tests**

Append to `tests/workflows.test.ts` (extend the imports with `scanWorkflows`, `workflowsDegraded`, `resetDegraded`, plus `Store`/`openDb` and the node fs helpers — `mkdtempSync`, `mkdirSync`, `writeFileSync` and `tmpdir` are already imported by Task 10's script-lookup tests):

```ts
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Store } from "../src/server/store.ts";
import { openDb } from "../src/server/db.ts";
import { scanWorkflows, workflowsDegraded, resetDegraded } from "../src/server/workflows.ts";
import { WF_RECHECK_MS } from "../src/server/config.ts";

const NOW = 1_800_000_000_000;

/** One priced transcript line: 1M input tokens of opus-5 = exactly $5. */
function agentLine(uuid: string) {
  return (
    JSON.stringify({
      uuid,
      sessionId: "parent",
      isSidechain: true,
      version: "2.1.226",
      timestamp: "2026-08-10T09:00:00.000Z",
      message: { model: "claude-opus-5", content: "do the thing", usage: { input_tokens: 1_000_000, output_tokens: 0 } },
    }) + "\n"
  );
}

/** Lay out a projects root, a session dir and a run dir exactly as Claude Code
 *  does, in a temp tree: <root>/<slug>/<sessionId>/subagents/workflows/wf_t1.
 *  The slug level is load-bearing — findScriptAcrossSlugs derives the projects
 *  root as <sessionDir>/../.., so the whole cross-slug search stays inside `root`
 *  and never touches ~/.claude. `siblingScripts` is C9's split: a SECOND slug
 *  holding the same sessionId, where the run's script sometimes lives. */
function makeRun(opts: { agents: string[]; journal?: string; manifest?: string; siblingScript?: string }) {
  const root = mkdtempSync(join(tmpdir(), "am-wf-"));           // ≙ ~/.claude/projects
  const sessionDir = join(root, "-slug-a", "parent");
  const transcript = join(root, "-slug-a", "parent.jsonl");
  const runDir = join(sessionDir, "subagents", "workflows", "wf_t1");
  const siblingScripts = join(root, "-slug-b", "parent", "workflows", "scripts");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(sessionDir, "workflows"), { recursive: true });
  writeFileSync(transcript, ""); // the parent transcript
  opts.agents.forEach((id, i) => {
    writeFileSync(join(runDir, `agent-${id}.jsonl`), agentLine(`u-${i}`));
    writeFileSync(join(runDir, `agent-${id}.meta.json`), JSON.stringify({ agentType: "workflow-subagent", spawnDepth: 1 }));
  });
  if (opts.journal) writeFileSync(join(runDir, "journal.jsonl"), opts.journal);
  if (opts.manifest) writeFileSync(join(sessionDir, "workflows", "wf_t1.json"), opts.manifest);
  if (opts.siblingScript) {
    mkdirSync(siblingScripts, { recursive: true });
    writeFileSync(join(siblingScripts, "research-wf_t1.js"), opts.siblingScript);
  }

  const store = new Store(openDb(":memory:"));
  store.applyEvent(
    "parent",
    { status: "working", project: "alpha", branch: "feat/x", transcript_path: transcript, last_activity_at: 1 },
    1
  );
  return { store, root, sessionDir, runDir, siblingScripts };
}

/** Force a directory's mtime, so liveness tests don't depend on wall-clock timing. */
const setMtime = (p: string, ms: number) => utimesSync(p, ms / 1000, ms / 1000);

describe("scanWorkflows", () => {
  it("tails every agent transcript against the PARENT session, stamping run_id/agent_id", () => {
    const { store } = makeRun({ agents: ["a1", "a2"] });
    expect(scanWorkflows(store, NOW).changed).toBe(true);
    const rows = store.db
      .query("SELECT run_id, agent_id, project, branch, cost_usd FROM usage ORDER BY agent_id")
      .all() as any[];
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual({ run_id: "wf_t1", agent_id: "a1", project: "alpha", branch: "feat/x", cost_usd: 5 });
    // The keystone: parent attribution means no `unknown` bucket appears.
    expect(store.costByProject()).toEqual([{ project: "alpha", costUsd: 10, tokens: 2_000_000 }]);
  });

  it("creates one agent row per transcript file even when the manifest lists fewer", () => {
    // The real 10-entry manifest against the real 13-agentId journal: keying off
    // the manifest would lose 3 agents' tokens.
    const journal = fixture("wf_57b2617f-124.journal.jsonl");
    const ids = [...new Set(journal.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l).agentId))] as string[];
    expect(ids.length).toBe(13);
    const { store } = makeRun({ agents: ids, journal, manifest: fixture("wf_57b2617f-124.manifest.json") });
    scanWorkflows(store, NOW);
    const n = store.db.query("SELECT COUNT(*) AS c FROM workflow_agents WHERE run_id='wf_t1'").get() as { c: number };
    expect(n.c).toBe(13);
    const abandoned = store.db
      .query("SELECT COUNT(*) AS c FROM workflow_agents WHERE run_id='wf_t1' AND state='abandoned'")
      .get() as { c: number };
    expect(abandoned.c).toBe(3);
  });

  it("reports changed: false on a tick where nothing moved", () => {
    const { store, runDir } = makeRun({ agents: ["a1"], manifest: fixture("wf_eb7bf7e8-8a5.manifest.json") });
    setMtime(runDir, NOW - 60 * 60 * 1000);
    expect(scanWorkflows(store, NOW).changed).toBe(true); // first sight
    expect(scanWorkflows(store, NOW).changed).toBe(false); // pure re-stat
  });

  it("un-settles when an agent file grows without any dir-mtime change (rule 3's hedge)", () => {
    const { store, runDir } = makeRun({ agents: ["a1"], manifest: fixture("wf_eb7bf7e8-8a5.manifest.json") });
    const quiet = NOW - 60 * 60 * 1000;
    setMtime(runDir, quiet);
    scanWorkflows(store, NOW);
    expect(scanWorkflows(store, NOW).changed).toBe(false);

    appendFileSync(join(runDir, "agent-a1.jsonl"), agentLine("u-late"));
    setMtime(runDir, quiet); // appending to a file does NOT touch the dir mtime
    expect(scanWorkflows(store, NOW).changed).toBe(true);
    const total = store.db.query("SELECT COUNT(*) AS c FROM usage").get() as { c: number };
    expect(total.c).toBe(2);
  });

  it("keeps tailing after a manifest appears — a manifest is terminal for STRUCTURE only (C6)", () => {
    const { store, sessionDir, runDir } = makeRun({ agents: ["a1"] });
    setMtime(runDir, NOW - 60 * 60 * 1000);
    scanWorkflows(store, NOW);
    expect(store.getWorkflowRun("wf_t1")!.manifest_seen).toBe(0);

    // The manifest lives OUTSIDE the run dir, so its arrival never bumps the run
    // dir's mtime — the scan must stat it explicitly or the run never enriches.
    writeFileSync(join(sessionDir, "workflows", "wf_t1.json"), fixture("wf_eb7bf7e8-8a5.manifest.json"));
    setMtime(runDir, NOW - 60 * 60 * 1000);
    expect(scanWorkflows(store, NOW).changed).toBe(true);
    expect(store.getWorkflowRun("wf_t1")!.manifest_seen).toBe(1);
    expect(store.getWorkflowRun("wf_t1")!.status).toBe("completed");

    // …and six minutes of appends AFTER the manifest still cost money.
    appendFileSync(join(runDir, "agent-a1.jsonl"), agentLine("u-after-manifest"));
    setMtime(runDir, NOW - 60 * 60 * 1000);
    scanWorkflows(store, NOW);
    const total = store.db.query("SELECT COUNT(*) AS c FROM usage").get() as { c: number };
    expect(total.c).toBe(2);
  });

  it("re-parses a manifest rewritten IN PLACE, which never moves the run dir (C6)", () => {
    // wf_3b398ae6-146's manifest read `failed` at 09:27:58 and was rewritten to
    // `completed` at 09:41:16. The manifest lives outside the run dir, so neither
    // last_seen_at nor any agent file changes — manifest_mtime is the only signal.
    const done = fixture("wf_eb7bf7e8-8a5.manifest.json");
    const failed = JSON.stringify({ ...JSON.parse(done), status: "failed" });
    const { store, sessionDir, runDir } = makeRun({ agents: ["a1"], manifest: failed });
    const manifestPath = join(sessionDir, "workflows", "wf_t1.json");
    const quiet = NOW - 60 * 60 * 1000;
    setMtime(manifestPath, NOW - 10_000);
    setMtime(runDir, quiet);
    scanWorkflows(store, NOW);
    expect(store.getWorkflowRun("wf_t1")!.status).toBe("failed");
    expect(scanWorkflows(store, NOW).changed).toBe(false); // nothing moved

    writeFileSync(manifestPath, done); // the rewrite
    setMtime(manifestPath, NOW - 5_000); // strictly later than the stored mtime
    setMtime(runDir, quiet); // …and the run dir is untouched, as on disk
    expect(scanWorkflows(store, NOW).changed).toBe(true);
    expect(store.getWorkflowRun("wf_t1")!.status).toBe("completed");
  });

  it("resolves phase titles from a SIBLING project slug at discovery (C9's 3 split runs)", () => {
    const { store } = makeRun({ agents: ["a1"], siblingScript: fixture("script-with-phases.js") });
    scanWorkflows(store, NOW);
    const row = store.db.query("SELECT name, phases FROM workflow_runs WHERE run_id='wf_t1'").get() as any;
    expect(row.name).toBe("workflows-monitoring-research");
    expect(JSON.parse(row.phases).length).toBeGreaterThan(0);
  });

  it("never re-runs the cross-slug lookup after discovery — it is a discovery-time cost only", () => {
    const { store, runDir, siblingScripts } = makeRun({ agents: ["a1"] });
    scanWorkflows(store, NOW); // discovery: no script under either slug yet
    expect((store.db.query("SELECT name FROM workflow_runs WHERE run_id='wf_t1'").get() as any).name).toBeNull();

    mkdirSync(siblingScripts, { recursive: true });
    writeFileSync(join(siblingScripts, "research-wf_t1.js"), fixture("script-with-phases.js"));
    appendFileSync(join(runDir, "agent-a1.jsonl"), agentLine("u-late")); // force a full re-parse
    scanWorkflows(store, NOW);
    // Still null: the 5s tick only ever reads <sessionDir>/workflows/scripts.
    expect((store.db.query("SELECT name FROM workflow_runs WHERE run_id='wf_t1'").get() as any).name).toBeNull();
  });

  it("does not touch a settled run older than WF_RECHECK_MS", () => {
    resetDegraded();
    const { store, runDir, root } = makeRun({ agents: ["a1"], manifest: fixture("wf_eb7bf7e8-8a5.manifest.json") });
    setMtime(runDir, NOW - WF_RECHECK_MS - 60_000);
    scanWorkflows(store, NOW);
    store.applyEvent("parent", { status: "ended", last_activity_at: 1 }, 1); // off the discovery list
    rmSync(root, { recursive: true, force: true }); // any stat would now throw
    expect(scanWorkflows(store, NOW).changed).toBe(false);
    expect(workflowsDegraded()).toBe(0); // proves the dir was never stat'd
  });

  it("survives a truncated manifest with schema_ok=0 and an error, still tailing cost", () => {
    resetDegraded();
    const { store } = makeRun({
      agents: ["a1"],
      manifest: fixture("wf_eb7bf7e8-8a5.manifest.json").slice(0, 400),
    });
    scanWorkflows(store, NOW);
    const row = store.db.query("SELECT schema_ok, error FROM workflow_runs WHERE run_id='wf_t1'").get() as any;
    expect(row.schema_ok).toBe(0);
    expect(row.error).toContain("manifest");
    // resetDegraded() above also clears logOnce's key memory — the counter is
    // gated on logOnce returning true, and every test here reuses run id wf_t1.
    expect(workflowsDegraded()).toBe(1); // once per run per cause, not once per tick
    scanWorkflows(store, NOW);
    expect(workflowsDegraded()).toBe(1); // a second tick over the same broken manifest adds nothing
    const total = store.db.query("SELECT COUNT(*) AS c FROM usage").get() as { c: number };
    expect(total.c).toBe(1); // cost is the durable half — it survives structure breaking
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/workflows.test.ts` — Expected: FAIL, `scanWorkflows is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/server/workflows.ts` (extend its imports first — the `node:fs` and `node:path` lines already exist from Task 10 and only gain entries):

```ts
import { readdirSync, statSync, readFileSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Store } from "./store.ts";
import { takeUsage } from "./usage.ts";
import { WF_QUIET_MS, WF_RECHECK_MS } from "./config.ts";
```

```ts
export interface RunTarget {
  run_id: string;
  session_id: string;
  dir: string;
}

const AGENT_RE = /^agent-(.+)\.jsonl$/;

// `readdirSafe` already exists from Task 10 (the script lookup uses it).

function readFileSafe(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** First `bytes` of a file — enough for version/model/prompt without paying for a
 *  6.3MB read. */
function readHead(path: string, bytes = 8192): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const n = Math.min(bytes, fstatSync(fd).size);
    if (n <= 0) return "";
    const buf = Buffer.allocUnsafe(n);
    // Same short-read rule as takeUsage: decode only what was actually read.
    const got = readSync(fd, buf, 0, n, 0);
    return got > 0 ? buf.subarray(0, got).toString("utf8") : "";
  } finally {
    closeSync(fd);
  }
}

/** Scan one run dir: refresh structure, then tail every agent transcript.
 *  Returns true when anything changed (new run, dir moved, manifest arrived or was
 *  rewritten in place, or usage recorded) — the `changed` contract the SSE
 *  broadcast keys off.
 *  Throws only on a stat of the run dir itself; the caller catches. */
export function scanRun(store: Store, t: RunTarget, now: number): boolean {
  const dirStat = statSync(t.dir);
  const mtime = Math.round(dirStat.mtimeMs);
  const prev = store.getWorkflowRun(t.run_id);
  // NOTE: the scanner never calls deriveRunState. Liveness is derived at READ time
  // (hydrateWorkflowRuns / liveWorkflows), from `manifest_seen` + `last_seen_at` +
  // the joined session status — so nothing here needs the owning session's status.

  // The manifest lives OUTSIDE the run dir, so neither its arrival nor an in-place
  // rewrite bumps the run dir mtime — it has to be stat'd explicitly, and its own
  // mtime remembered.
  const sessionDir = resolve(t.dir, "..", "..", "..");
  const manifestPath = join(sessionDir, "workflows", `${t.run_id}.json`);
  let manifestMtime: number | null = null;
  try {
    manifestMtime = Math.round(statSync(manifestPath).mtimeMs);
  } catch {}
  const manifestExists = manifestMtime !== null;
  const manifestNew = manifestExists && (!prev || prev.manifest_seen === 0);
  // C6: a manifest is rewritten in place (`failed` 09:27:58 → `completed` 09:41:16)
  // with the run dir untouched. A stored mtime older than the file's is the only
  // signal that happened. A NULL stored value (row written before this column, or
  // by a pass that never read the manifest) re-parses once, then converges.
  const manifestRewritten =
    manifestExists && !!prev && (prev.manifest_mtime == null || manifestMtime! > prev.manifest_mtime);

  // Agent set = the run dir's agent-*.jsonl files. Not the manifest, not the journal.
  const offsets = new Map(store.workflowAgentOffsets(t.run_id).map((o) => [o.agent_id, o.offset]));
  const files: { agent_id: string; path: string }[] = [];
  let grew = false;
  for (const name of readdirSafe(t.dir)) {
    const m = AGENT_RE.exec(name);
    if (!m) continue;
    const path = join(t.dir, name);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      continue;
    }
    files.push({ agent_id: m[1], path });
    // Rule 3's hedge: an append to an EXISTING transcript leaves the dir mtime
    // alone, so file growth is checked independently.
    if (size > (offsets.get(m[1]) ?? 0)) grew = true;
  }

  const dirMoved = !prev || prev.last_seen_at == null || mtime > prev.last_seen_at;
  if (prev && !dirMoved && !grew && !manifestNew && !manifestRewritten) return false; // cheap re-stat only

  const manifest = manifestExists ? parseManifest(readFileSafe(manifestPath)) : null;
  let error: string | null = null;
  if (manifestExists && !manifest) error = "manifest: not valid JSON";
  else if (manifest && !manifest.schema_ok) error = manifest.error;
  // logOnce returns true only on the pass that actually logged; gating the counter
  // on it makes workflows_degraded once-per-run-per-cause, not once-per-5s-tick.
  if (error && logOnce(t.run_id, error)) bumpDegraded();

  const journalLines = readFileSafe(join(t.dir, "journal.jsonl")).split("\n");
  const { agents: journalAgents, unknownTypes } = parseJournal(journalLines, { manifestPresent: !!manifest });
  if (unknownTypes > 0 && logOnce(`${t.run_id}:journal-types`, `${unknownTypes} unknown journal line type(s)`)) {
    bumpDegraded(unknownTypes);
  }

  // The script is the only LIVE source of phase titles; once a manifest exists it
  // is strictly better, so don't pay for the read.
  let script: { name: string | null; phases: Phase[] } = { name: null, phases: [] };
  if (!manifest) {
    // Primary lookup: one readdir of a small dir, every ACTIVE tick.
    let scriptPath = findScriptFile(sessionDir, t.run_id);
    // Fallback (C9): 3 of 20 runs park their script under a SIBLING project slug
    // carrying the same sessionId. `!prev` pins this to the pass that DISCOVERS
    // the run — the first tick that sees it, or the startup backfill on a fresh
    // DB — so it is a discovery-time cost and NEVER lands on a 5s tick (§1.3).
    if (!scriptPath && !prev) scriptPath = findScriptAcrossSlugs(sessionDir, t.run_id);
    if (scriptPath) script = parseScriptMeta(readFileSafe(scriptPath));
  }

  const manifestById = new Map((manifest?.agents ?? []).map((a) => [a.agent_id, a]));
  const ids = new Set<string>([...files.map((f) => f.agent_id), ...journalAgents.keys(), ...manifestById.keys()]);
  const quiet = now - mtime > WF_QUIET_MS;

  let ccVersion: string | null = null;
  let recorded = false;

  for (const id of ids) {
    const file = files.find((f) => f.agent_id === id);
    const j = journalAgents.get(id);
    const m = manifestById.get(id);
    // Read the transcript head only for an agent we have never seen; after that
    // the header fields never change.
    const header =
      file && !offsets.has(id)
        ? parseAgentHeader(readHead(file.path))
        : { cc_version: null, model: null, prompt_preview: null };
    if (!ccVersion && header.cc_version) ccVersion = header.cc_version;
    const meta = file
      ? parseAgentMeta(readFileSafe(file.path.replace(/\.jsonl$/, ".meta.json")))
      : { agent_type: null, model: null };

    store.upsertWorkflowAgent({
      run_id: t.run_id,
      agent_id: id,
      label: m?.label ?? null, // labels exist only in the manifest — null on a live run
      phase_index: m?.phase_index ?? null,
      phase_title: m?.phase_title ?? null,
      idx: m?.idx ?? null,
      model: m?.model ?? header.model ?? meta.model ?? null,
      // Rule 6: a transcript with no journal mention is running while ACTIVE, done once quiet.
      state: m?.state ?? j?.state ?? (file ? (quiet ? "done" : "running") : null),
      attempt: m?.attempt ?? null,
      journal_key: j?.journal_key ?? null,
      last_tool: m?.last_tool ?? null,
      last_tool_summary: m?.last_tool_summary ?? null,
      prompt_preview: m?.prompt_preview ?? header.prompt_preview ?? null,
      started_at: m?.started_at ?? null,
      duration_ms: m?.duration_ms ?? null,
      tool_calls: m?.tool_calls ?? null,
    });

    if (!file) continue;
    const before = offsets.get(id) ?? 0;
    const r = takeUsage(store, {
      path: file.path,
      offset: before,
      sessionId: t.session_id, // PARENT session id — the keystone (C3)
      runId: t.run_id,
      agentId: id,
    });
    if (r.offset !== before) store.setWorkflowAgentOffset(t.run_id, id, r.offset);
    if (r.recorded) recorded = true;
  }

  const phases = manifest?.phases.length ? manifest.phases : script.phases;
  store.upsertWorkflowRun({
    run_id: t.run_id,
    session_id: t.session_id,
    dir: t.dir,
    name: manifest?.name ?? script.name ?? null,
    summary: manifest?.summary ?? null,
    status: manifest?.status ?? null, // RAW
    error,
    // Before a manifest exists, the dir's birthtime is the best start we have
    // (~42s early on a sample); mtimeMs is the fallback where birthtime is 0.
    started_at: manifest?.started_at ?? Math.round(dirStat.birthtimeMs || dirStat.mtimeMs),
    ended_at: manifest?.ended_at ?? null,
    duration_ms: manifest?.duration_ms ?? null,
    agent_count: manifest?.agent_count ?? null,
    phases: phases.length ? JSON.stringify(phases) : null,
    cc_version: ccVersion,
    manifest_seen: !!manifest,
    // Stored whenever the FILE exists, parsed or not: a corrupt manifest that is
    // later fixed in place must still re-trigger on its new mtime.
    manifest_mtime: manifestMtime,
    last_seen_at: mtime, // the DIR's mtime, not the tick's clock
    schema_ok: !error,
    total_tokens_reported: manifest?.total_tokens_reported ?? null,
  });

  // Cross-check §5.8 — PRESENCE, not proportion. Claude Code's `totalTokens` is
  // not comparable to our rollup (24x–276x across 19 manifests), so the only
  // sound signal is "it says tokens were burned and we ingested none".
  if (manifest && quiet && (manifest.total_tokens_reported ?? 0) > 0) {
    const row = store.db
      .query(
        `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens +
                            cache_create_5m_tokens + cache_create_1h_tokens), 0) AS t
         FROM usage WHERE run_id = $r`
      )
      .get({ $r: t.run_id }) as { t: number };
    if (row.t === 0 && logOnce(`${t.run_id}:no-tokens`, "manifest reports tokens but no usage rows were ingested")) {
      bumpDegraded();
    }
  }

  return recorded || dirMoved || manifestNew || manifestRewritten || !prev;
}

/** One tick. Discovery is per-session `readdir` (~100µs), never a glob — the only
 *  global glob in this feature is the one-time startup backfill. */
export function scanWorkflows(store: Store, now: number): { changed: boolean } {
  let changed = false;
  const targets = new Map<string, RunTarget>();

  for (const s of store.listSessions()) {
    if (!s.transcript_path) continue;
    const runsDir = join(sessionDirFor(s.transcript_path), "subagents", "workflows");
    for (const n of readdirSafe(runsDir)) {
      if (!n.startsWith("wf_")) continue;
      targets.set(n, { run_id: n, session_id: s.id, dir: join(runsDir, n) });
    }
  }
  for (const r of store.workflowRunsToScan(now - WF_RECHECK_MS)) {
    if (!targets.has(r.run_id)) targets.set(r.run_id, { run_id: r.run_id, session_id: r.session_id, dir: r.dir });
  }

  for (const t of targets.values()) {
    try {
      if (scanRun(store, t, now)) changed = true;
    } catch (err) {
      // Per-run isolation: one unreadable run can never break the others, the
      // stale sweep, or session cost tailing. Counted once per run, not per tick.
      if (logOnce(t.run_id, err)) bumpDegraded();
    }
  }
  return { changed };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/ && bun run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/workflows.ts tests/workflows.test.ts
git commit -m "feat(workflows): scanWorkflows — discovery, liveness, structure and cost tailing"
```

---

### Task 13: startup backfill + the 5s tick in `index.ts` (§1.1, §1.2)

**Files:**
- Modify: `src/server/workflows.ts` (append `backfillWorkflows`)
- Modify: `src/server/index.ts` (second `setInterval` + one-time backfill before `server.listen`)
- Test: `tests/workflows.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `scanRun` (Task 12), `CLAUDE_PROJECTS_DIR` / `WORKFLOWS_ENABLED` / `WF_TICK_MS` (Task 7).
- Produces: `export function backfillWorkflows(store: Store, now: number, root?: string): { runs: number }` — `root` defaults to `CLAUDE_PROJECTS_DIR` so tests can point it at a temp tree.

**Needs Task 12.**

- [ ] **Step 1: Write the failing tests**

Append to `tests/workflows.test.ts` (add `backfillWorkflows` to the import):

```ts
describe("backfillWorkflows", () => {
  /** ~/.claude/projects/<slug>/<sessionId>/subagents/workflows/wf_* */
  function makeTree() {
    const root = mkdtempSync(join(tmpdir(), "am-bf-"));
    const sessionDir = join(root, "-home-u-repo", "sess-1");
    const runDir = join(sessionDir, "subagents", "workflows", "wf_old");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "agent-a1.jsonl"), agentLine("bf-1"));
    return { root, runDir };
  }

  it("finds run dirs by path structure and resolves the session from the dir's third parent", () => {
    const { root } = makeTree();
    const store = new Store(openDb(":memory:"));
    // The session exists but its transcript_path points somewhere else entirely —
    // resolution must come from the run dir's own path, not string-matching.
    store.applyEvent("sess-1", { status: "ended", project: "repo", branch: "main", transcript_path: "/elsewhere/x.jsonl", last_activity_at: 1 }, 1);

    expect(backfillWorkflows(store, NOW, root).runs).toBe(1);
    const row = store.db.query("SELECT run_id, session_id, project FROM workflow_runs").get();
    expect(row).toEqual({ run_id: "wf_old", session_id: "sess-1", project: "repo" });
    const usage = store.db.query("SELECT session_id, run_id, project FROM usage").get();
    expect(usage).toEqual({ session_id: "sess-1", run_id: "wf_old", project: "repo" });
  });

  it("still ingests a run whose session row is missing, bucketing it under unknown", () => {
    const { root } = makeTree();
    const store = new Store(openDb(":memory:"));
    expect(backfillWorkflows(store, NOW, root).runs).toBe(1);
    // Skipping it would silently drop spend — the one thing this feature exists
    // to prevent. The existing queries already bucket a NULL project as 'unknown'.
    expect(store.costByProject()).toEqual([{ project: "unknown", costUsd: 5, tokens: 1_000_000 }]);
  });

  it("is idempotent — a second backfill records nothing new", () => {
    const { root } = makeTree();
    const store = new Store(openDb(":memory:"));
    backfillWorkflows(store, NOW, root);
    backfillWorkflows(store, NOW, root);
    const n = store.db.query("SELECT COUNT(*) AS c FROM usage").get() as { c: number };
    expect(n.c).toBe(1);
  });

  it("returns 0 runs for a root that does not exist", () => {
    const store = new Store(openDb(":memory:"));
    expect(backfillWorkflows(store, NOW, "/no/such/root").runs).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/workflows.test.ts` — Expected: FAIL, `backfillWorkflows is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/server/workflows.ts` (add `CLAUDE_PROJECTS_DIR` to the config import):

```ts
/** One-time startup pass over every run dir on disk. This is the ONLY place a
 *  global glob is allowed (~1ms for 20 dirs).
 *
 *  Each hit is resolved to its session by PATH STRUCTURE, never by string-matching
 *  `transcript_path`: the session dir is the run dir's third parent and the
 *  session id is that directory's basename. A run whose session id is absent from
 *  `sessions` is still ingested — recordUsage's subquery yields NULL project, which
 *  the cost queries already bucket under 'unknown'. Dropping it would lose spend.
 *
 *  Every run here is a first sight on a fresh DB, so this is also where scanRun's
 *  once-per-run cross-slug script lookup (§1.3) happens for historical runs — at
 *  backfill time, never on a 5s tick. On a warm DB the run rows already exist and
 *  scanRun skips it. */
export function backfillWorkflows(
  store: Store,
  now: number,
  root: string = CLAUDE_PROJECTS_DIR
): { runs: number } {
  let runs = 0;
  for (const slug of readdirSafe(root)) {
    for (const sessionId of readdirSafe(join(root, slug))) {
      const runsDir = join(root, slug, sessionId, "subagents", "workflows");
      for (const name of readdirSafe(runsDir)) {
        if (!name.startsWith("wf_")) continue;
        const target: RunTarget = { run_id: name, session_id: sessionId, dir: join(runsDir, name) };
        try {
          scanRun(store, target, now);
          runs++;
        } catch (err) {
          if (logOnce(name, err)) bumpDegraded(); // once per run per cause (§5.5)
        }
      }
    }
  }
  return { runs };
}
```

In `src/server/index.ts`, extend the config import and add the workflow imports:

```ts
import { PORT, HOST, DB_PATH, STALE_MS, DEAD_MS, SWEEP_INTERVAL_MS, WF_TICK_MS, WORKFLOWS_ENABLED } from "./config.ts";
import { scanWorkflows, backfillWorkflows, logOnce, bumpDegraded } from "./workflows.ts";
```

Add the second interval **after** the existing 60s sweep block (which stays untouched):

```ts
// A SECOND interval, deliberately separate from the 60s sweep: a live run must
// feel live. This tick must NEVER call pushState() — buildState() is 243ms and a
// 5s full-state broadcast would burn ~5% CPU permanently. Usage it records
// therefore does not reach the cost panels until the next 60s sweep; that
// asymmetry is accepted.
if (WORKFLOWS_ENABLED) {
  setInterval(() => {
    try {
      scanWorkflows(store, Date.now());
    } catch (err) {
      // A whole-tick failure is one cause, not one per 5s: logOnce returns true
      // only when it actually logged, and the counter follows it (§5.5).
      if (logOnce("wf-scan", err)) bumpDegraded();
    }
  }, WF_TICK_MS);
}
```

And the one-time backfill immediately before `server.listen(...)` (after the repricing block from Task 3):

```ts
if (WORKFLOWS_ENABLED) {
  try {
    const t0 = Date.now();
    const { runs } = backfillWorkflows(store, t0);
    console.log(`[wf-backfill] runs=${runs} in ${Date.now() - t0}ms`);
  } catch (err) {
    if (logOnce("wf-backfill", err)) bumpDegraded();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/ && npx vitest run && bun run typecheck` — Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/server/workflows.ts src/server/index.ts tests/workflows.test.ts
git commit -m "feat(server): 5s workflow tick + one-time startup backfill

Lands ~\$1,124 of previously-invisible workflow spend on PAST days. Prior
days on #/cost will jump noticeably — that spend was always real."
```

---

### Task 14 (ops): backfill the live DB and verify the gate

**Files:** none.

**Prerequisite:** Task 4 (ops) must already have run, or the backfill bakes $786 of $0.00 rows in permanently.

- [ ] **Step 1: Confirm the pricing fix is live in the DB**

```bash
sqlite3 -readonly ~/.local/share/agent-monitor/agent-monitor.sqlite \
  "SELECT COUNT(*) FROM usage WHERE cost_usd = 0 AND model IN ('claude-opus-5','claude-sonnet-5');"
```
Expected: `0`. **If this is not 0, stop and finish Task 4 first.**

- [ ] **Step 2: Record the "before" total**

```bash
sqlite3 -readonly ~/.local/share/agent-monitor/agent-monitor.sqlite \
  "SELECT ROUND(SUM(cost_usd),2) FROM usage;"
```

- [ ] **Step 3: Restart the service so the backfill runs**

```bash
systemctl --user restart am-server.service
journalctl --user -u am-server.service -n 20 --no-pager | grep -E 'wf-backfill|listening'
```
Expected: a `[wf-backfill] runs=21 in <N>ms` line (count drifts as you work), then the listening line. If the grep is empty, re-run it — the backfill reads ~116 multi-MB transcripts and takes tens of seconds on first pass.

- [ ] **Step 4: Verify the gate**

```bash
sqlite3 -readonly ~/.local/share/agent-monitor/agent-monitor.sqlite \
  "SELECT COUNT(*) AS rows, ROUND(SUM(cost_usd),2) AS usd FROM usage WHERE run_id IS NOT NULL;
   SELECT COALESCE(project,'unknown') AS p, ROUND(SUM(cost_usd),2) FROM usage WHERE run_id IS NOT NULL GROUP BY p ORDER BY 2 DESC;
   SELECT COUNT(*) FROM workflow_runs;
   SELECT COUNT(*) FROM workflow_agents;"
```
Expected: ~15,000 rows totalling roughly **$1,124**; every project bucket is a **real project name — no `unknown` row**; ~21 runs; ~116+ agents.

If an `unknown` bucket does appear, it means a run's owning session is absent from `sessions`. That is designed-for, not a bug (§1.1, accepted risk 8) — record which run and move on.

- [ ] **Step 5: Confirm the dashboard**

Open `http://localhost:4317/#/cost`. Past days have jumped. Cross-check one run's spend:

```bash
sqlite3 -readonly ~/.local/share/agent-monitor/agent-monitor.sqlite \
  "SELECT run_id, ROUND(SUM(cost_usd),2) FROM usage WHERE run_id IS NOT NULL GROUP BY run_id ORDER BY 2 DESC LIMIT 5;"
```

- [ ] **Step 6: Merge the branch**

```bash
git checkout main && git merge --no-ff feat/workflow-cost-ingestion
```

---

## Step 3 — `feat/workflows-history`

**Delivers:** store read queries, `GET /api/workflows`, the `#/workflows` page, the AppBar link. **No DDL** — step 2 already wrote the structural columns.

**Gate:** the history page lists every completed run with phases and per-agent drill-down.

```bash
git checkout -b feat/workflows-history
```

### Task 15: `workflowHistory()` + usage rollups (§2, §3.2)

**Files:**
- Modify: `src/server/store.ts` (append to the `// --- workflows ---` block)
- Test: `tests/cost-store.test.ts` (append — this is where usage-rollup tests live by repo convention, not `store.test.ts`)

**Interfaces:**
- Consumes: `deriveRunState` (Task 7); `TOKEN_SUM` (existing module const).
- Produces:
  ```ts
  export interface WorkflowAgentView {
    agent_id: string; label: string | null; phase_index: number | null; phase_title: string | null;
    idx: number | null; model: string | null; state: string | null; attempt: number | null;
    last_tool: string | null; last_tool_summary: string | null; prompt_preview: string | null;
    started_at: number | null; ended_at: number | null; duration_ms: number | null;
    tool_calls: number | null; tokens: number; costUsd: number;
  }
  export interface WorkflowRun {
    run_id: string; session_id: string; project: string; branch: string | null;
    name: string | null; summary: string | null; status: string | null; state: string;
    error: string | null; started_at: number | null; ended_at: number | null;
    duration_ms: number | null; agent_count: number | null;
    phases: { title: string; detail: string | null }[];
    cc_version: string | null; schema_ok: boolean; total_tokens_reported: number | null;
    costUsd: number; tokens: number; agents: WorkflowAgentView[];
  }
  Store.workflowHistory(
    opts?: { since?: number; until?: number; limit?: number },
    now?: number
  ): WorkflowRun[]
  ```

**Note (deliberate superset):** `WorkflowAgentView` carries the history-only fields too, and Task 20's `LiveWorkflow.agents` reuses it verbatim. §3.1 lists a narrower live agent shape; a superset breaks no consumer and keeps one row-mapper instead of two.

- [ ] **Step 1: Write the failing tests**

Append to `tests/cost-store.test.ts` inside `describe("Store usage rows", …)`:

```ts
  /** A run with two agents: a1 cost $3 / 30 tok, a2 cost $1 / 10 tok. */
  function seedRun(store: Store, runId: string, startedAt: number) {
    store.applyEvent("p", { status: "working", project: "alpha", branch: "main", last_activity_at: 1 }, 1);
    store.upsertWorkflowRun({
      run_id: runId, session_id: "p", dir: `/d/${runId}`, name: "research", status: "completed",
      manifest_seen: true, last_seen_at: startedAt, started_at: startedAt, duration_ms: 1234,
      agent_count: 2, total_tokens_reported: 99,
      phases: JSON.stringify([{ title: "Explore", detail: "d" }, { title: "Judge", detail: null }]),
    });
    store.upsertWorkflowAgent({ run_id: runId, agent_id: "a1", label: "map", phase_index: 1, phase_title: "Explore", state: "done" });
    store.upsertWorkflowAgent({ run_id: runId, agent_id: "a2", label: "judge", phase_index: 2, phase_title: "Judge", state: "abandoned" });
    store.recordUsage({ uuid: `${runId}-1`, sessionId: "p", model: "claude-opus-5", tokens: tok(30), at: startedAt, cost: 3, runId, agentId: "a1" });
    store.recordUsage({ uuid: `${runId}-2`, sessionId: "p", model: "claude-opus-5", tokens: tok(10), at: startedAt, cost: 1, runId, agentId: "a2" });
  }

  it("workflowHistory embeds agents with their usage rollups and a run total", () => {
    const T = 1_700_000_000_000;
    seedRun(store, "wf_a", T);
    const runs = store.workflowHistory({}, T + 60 * 60 * 1000);
    expect(runs.length).toBe(1);
    const r = runs[0];
    expect(r.costUsd).toBeCloseTo(4, 6);
    expect(r.tokens).toBe(40);
    expect(r.project).toBe("alpha");
    expect(r.phases).toEqual([{ title: "Explore", detail: "d" }, { title: "Judge", detail: null }]);
    expect(r.schema_ok).toBe(true);
    expect(r.agents.map((a) => a.agent_id).sort()).toEqual(["a1", "a2"]);
    const a1 = r.agents.find((a) => a.agent_id === "a1")!;
    expect(a1.costUsd).toBeCloseTo(3, 6);
    expect(a1.tokens).toBe(30);
    expect(a1.phase_title).toBe("Explore");
  });

  it("workflowHistory derives run state from liveness, not from the stored status", () => {
    const T = 1_700_000_000_000;
    seedRun(store, "wf_a", T);
    expect(store.workflowHistory({}, T + 60 * 60 * 1000)[0].state).toBe("settled");
    expect(store.workflowHistory({}, T + 1000)[0].state).toBe("running"); // dir still warm
  });

  it("workflowHistory filters on started_at (since inclusive, until exclusive) and drops NULL starts when bounded", () => {
    const T = 1_700_000_000_000;
    seedRun(store, "wf_a", T);
    seedRun(store, "wf_b", T + 5000);
    store.upsertWorkflowRun({ run_id: "wf_null", session_id: "p", dir: "/d/n" }); // started_at NULL
    expect(store.workflowHistory({}, T).map((r) => r.run_id)).toContain("wf_null"); // unbounded includes it
    expect(store.workflowHistory({ since: T + 1 }, T).map((r) => r.run_id)).toEqual(["wf_b"]);
    expect(store.workflowHistory({ until: T + 1 }, T).map((r) => r.run_id)).toEqual(["wf_a"]);
  });

  it("workflowHistory orders newest-first and clamps limit to 1..500", () => {
    const T = 1_700_000_000_000;
    seedRun(store, "wf_a", T);
    seedRun(store, "wf_b", T + 5000);
    expect(store.workflowHistory({}, T).map((r) => r.run_id)).toEqual(["wf_b", "wf_a"]);
    expect(store.workflowHistory({ limit: 1 }, T).map((r) => r.run_id)).toEqual(["wf_b"]); // limit caps RUNS
    expect(store.workflowHistory({ limit: 0 }, T).length).toBe(1); // clamped up to 1
    expect(store.workflowHistory({ limit: 99999 }, T).length).toBe(2); // clamped down to 500
  });

  it("workflowHistory buckets a run with no resolvable project under 'unknown' and yields 0s with no usage", () => {
    store.upsertWorkflowRun({ run_id: "wf_ghost", session_id: "ghost", dir: "/d/g", started_at: 1 });
    const r = store.workflowHistory({}, 2)[0];
    expect(r.project).toBe("unknown");
    expect(r.costUsd).toBe(0);
    expect(r.tokens).toBe(0);
    expect(r.agents).toEqual([]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/cost-store.test.ts` — Expected: FAIL, `store.workflowHistory is not a function`.

- [ ] **Step 3: Write the implementation**

Add the two interfaces near `WorkflowRunScanRow` in `src/server/store.ts`:

```ts
export interface WorkflowAgentView {
  agent_id: string;
  label: string | null;
  phase_index: number | null;
  phase_title: string | null;
  idx: number | null;
  model: string | null;
  state: string | null;
  attempt: number | null;
  last_tool: string | null;
  last_tool_summary: string | null;
  prompt_preview: string | null;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  tool_calls: number | null;
  tokens: number;
  costUsd: number;
}

export interface WorkflowRun {
  run_id: string;
  session_id: string;
  project: string;
  branch: string | null;
  name: string | null;
  summary: string | null;
  status: string | null;
  state: string;
  error: string | null;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  agent_count: number | null;
  phases: { title: string; detail: string | null }[];
  cc_version: string | null;
  schema_ok: boolean;
  total_tokens_reported: number | null;
  costUsd: number;
  tokens: number;
  agents: WorkflowAgentView[];
}
```

Add `import { deriveRunState } from "./workflows.ts";` at the top of `store.ts`, then append to the `// --- workflows ---` block:

```ts
  /** Turn raw workflow_runs rows into API views: parse `phases` back from JSON,
   *  derive the liveness state, and join the per-agent usage rollup. Per-agent
   *  tokens and cost are NOT stored — they are derived from `usage`, so there is
   *  one priced source of truth and it works live, before any manifest exists. */
  private hydrateWorkflowRuns(rows: Record<string, any>[], now: number): WorkflowRun[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.run_id as string);
    const ph = ids.map((_, i) => `$r${i}`).join(", ");
    const params: Record<string, string> = {};
    ids.forEach((id, i) => (params[`$r${i}`] = id));

    const rollup = this.db
      .query(
        `SELECT run_id, agent_id, SUM(cost_usd) AS cost, SUM${TOKEN_SUM} AS tokens
         FROM usage WHERE run_id IN (${ph}) GROUP BY run_id, agent_id`
      )
      .all(params) as { run_id: string; agent_id: string | null; cost: number; tokens: number }[];
    const byAgent = new Map<string, { cost: number; tokens: number }>();
    const byRun = new Map<string, { cost: number; tokens: number }>();
    for (const r of rollup) {
      byAgent.set(`${r.run_id} ${r.agent_id ?? ""}`, { cost: r.cost, tokens: r.tokens });
      const t = byRun.get(r.run_id) ?? { cost: 0, tokens: 0 };
      byRun.set(r.run_id, { cost: t.cost + r.cost, tokens: t.tokens + r.tokens });
    }

    const agentRows = this.db
      .query(`SELECT * FROM workflow_agents WHERE run_id IN (${ph}) ORDER BY run_id, idx, agent_id`)
      .all(params) as Record<string, any>[];
    const agentsByRun = new Map<string, WorkflowAgentView[]>();
    for (const a of agentRows) {
      const roll = byAgent.get(`${a.run_id} ${a.agent_id}`) ?? { cost: 0, tokens: 0 };
      const list = agentsByRun.get(a.run_id) ?? [];
      list.push({
        agent_id: a.agent_id,
        label: a.label,
        phase_index: a.phase_index,
        phase_title: a.phase_title,
        idx: a.idx,
        model: a.model,
        state: a.state,
        attempt: a.attempt,
        last_tool: a.last_tool,
        last_tool_summary: a.last_tool_summary,
        prompt_preview: a.prompt_preview,
        started_at: a.started_at,
        ended_at: a.ended_at,
        duration_ms: a.duration_ms,
        tool_calls: a.tool_calls,
        costUsd: roll.cost,
        tokens: roll.tokens,
      });
      agentsByRun.set(a.run_id, list);
    }

    const sessionStatus = new Map(
      (this.db.query(`SELECT id, status FROM sessions`).all() as { id: string; status: string }[]).map((s) => [
        s.id,
        s.status,
      ])
    );

    return rows.map((r) => {
      let phases: { title: string; detail: string | null }[] = [];
      try {
        if (r.phases) phases = JSON.parse(r.phases as string);
      } catch {
        phases = [];
      }
      const roll = byRun.get(r.run_id) ?? { cost: 0, tokens: 0 };
      return {
        run_id: r.run_id,
        session_id: r.session_id,
        project: r.project ?? "unknown", // matches costByProject's bucket
        branch: r.branch ?? null,
        name: r.name,
        summary: r.summary,
        status: r.status,
        state: deriveRunState(
          {
            manifest_seen: r.manifest_seen === 1,
            status: r.status,
            last_seen_at: r.last_seen_at,
            session_status: sessionStatus.get(r.session_id) ?? "ended",
          },
          now
        ),
        error: r.error,
        started_at: r.started_at,
        ended_at: r.ended_at,
        duration_ms: r.duration_ms,
        agent_count: r.agent_count,
        phases,
        cc_version: r.cc_version,
        schema_ok: r.schema_ok === 1,
        total_tokens_reported: r.total_tokens_reported,
        costUsd: roll.cost,
        tokens: roll.tokens,
        agents: agentsByRun.get(r.run_id) ?? [],
      };
    });
  }

  /** Completed + in-flight runs for the history page, newest first. `since`/`until`
   *  filter on `started_at` (since inclusive, until exclusive), matching
   *  rangeClause()'s convention; runs with a NULL start drop out whenever either
   *  bound is given. `limit` caps RUNS, not agents, and is clamped to 1..500.
   *  Agents are embedded: one endpoint, one round trip, no per-row expand fetch. */
  workflowHistory(
    opts: { since?: number; until?: number; limit?: number } = {},
    now: number = Date.now()
  ): WorkflowRun[] {
    const conds: string[] = [];
    const params: Record<string, number> = {};
    if (opts.since !== undefined) {
      conds.push("started_at >= $since");
      params.$since = opts.since;
    }
    if (opts.until !== undefined) {
      conds.push("started_at < $until");
      params.$until = opts.until;
    }
    const limit = Math.min(500, Math.max(1, Math.round(opts.limit ?? 100)));
    const rows = this.db
      .query(
        `SELECT * FROM workflow_runs ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}
         ORDER BY started_at DESC LIMIT ${limit}`
      )
      .all(params) as Record<string, any>[];
    return this.hydrateWorkflowRuns(rows, now);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/ && bun run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/store.ts tests/cost-store.test.ts
git commit -m "feat(store): workflowHistory with embedded agents and derived usage rollups"
```

---

### Task 16: `GET /api/workflows` (§3.2)

**Files:**
- Modify: `src/server/http.ts` (add a route block right after the `/api/cost/daily` block, ~line 153)
- Test: `tests/http.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `Store.workflowHistory` (Task 15).
- Produces: `GET /api/workflows?since=<ms>&until=<ms>&limit=100` returning `{ runs: WorkflowRun[] }`.

**Needs Task 15.**

- [ ] **Step 1: Write the failing tests**

Append to `tests/http.test.ts`:

```ts
describe("GET /api/workflows", () => {
  const T = 1_700_000_000_000;

  function seed(runId: string, startedAt: number) {
    store.applyEvent("p", { status: "working", project: "alpha", branch: "main", last_activity_at: 1 }, 1);
    store.upsertWorkflowRun({
      run_id: runId, session_id: "p", dir: `/d/${runId}`, name: "research", status: "completed",
      manifest_seen: true, last_seen_at: startedAt, started_at: startedAt,
    });
    store.upsertWorkflowAgent({ run_id: runId, agent_id: "a1", label: "map", state: "done" });
    const z = { input: 10, output: 0, cache_read: 0, cache_create_5m: 0, cache_create_1h: 0 };
    store.recordUsage({ uuid: `${runId}-1`, sessionId: "p", model: "claude-opus-5", tokens: z, at: startedAt, cost: 2.5, runId, agentId: "a1" });
  }

  it("returns runs with embedded agents and usage rollups", async () => {
    seed("wf_a", T);
    const body = (await (await fetch(`${base}/api/workflows`)).json()) as any;
    expect(body.runs.length).toBe(1);
    expect(body.runs[0].run_id).toBe("wf_a");
    expect(body.runs[0].project).toBe("alpha");
    expect(body.runs[0].costUsd).toBeCloseTo(2.5, 6);
    expect(body.runs[0].agents[0].agent_id).toBe("a1");
    expect(body.runs[0].agents[0].costUsd).toBeCloseTo(2.5, 6);
  });

  it("respects since/until/limit", async () => {
    seed("wf_a", T);
    seed("wf_b", T + 5000);
    const ranged = (await (await fetch(`${base}/api/workflows?since=${T + 1}`)).json()) as any;
    expect(ranged.runs.map((r: any) => r.run_id)).toEqual(["wf_b"]);
    const capped = (await (await fetch(`${base}/api/workflows?limit=1`)).json()) as any;
    expect(capped.runs.length).toBe(1);
  });

  it("ignores malformed params rather than erroring", async () => {
    const res = await fetch(`${base}/api/workflows?since=abc&until=xyz&limit=nope`);
    expect(res.status).toBe(200);
    expect(Array.isArray(((await res.json()) as any).runs)).toBe(true);
  });

  it("keeps workflows OUT of the state blob (buildState must not get slower)", () => {
    const state = buildState(store) as any;
    expect(state.workflows).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/http.test.ts`
Expected: FAIL — `/api/workflows` falls through to the 404 handler, so `body.runs` is undefined.

- [ ] **Step 3: Write the implementation**

In `src/server/http.ts`, add immediately after the `/api/cost/daily` block:

```ts
      // --- workflow run history; pull, not streamed (live runs use the SSE
      // `workflows` event instead — buildState() is 243ms and must not grow) ---
      if (method === "GET" && path === "/api/workflows") {
        const num = (v: string | null): number | undefined => {
          const n = v == null ? NaN : Number(v);
          return Number.isFinite(n) ? n : undefined;
        };
        const runs = store.workflowHistory({
          since: num(url.searchParams.get("since")),
          until: num(url.searchParams.get("until")),
          limit: num(url.searchParams.get("limit")),
        });
        json(res, 200, { runs });
        return;
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/http.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/http.ts tests/http.test.ts
git commit -m "feat(server): GET /api/workflows history endpoint with embedded agents"
```

---

### Task 17: web types, duration/when formatters, and `WorkflowsPage` (§4.2)

**Files:**
- Modify: `src/web/types.ts` (append `WorkflowAgentView`, `WorkflowRun`)
- Modify: `src/web/time.ts` (append `formatDuration`, `formatWhen`)
- Create: `src/web/components/WorkflowsPage.tsx`
- Create: `web-tests/time.test.ts`
- Create: `web-tests/WorkflowsPage.test.tsx`

**Interfaces:**
- Consumes: `GET /api/workflows` (Task 16); `formatUsd` / `formatTokens` / `prettyModel` / `costDailyRange` / `CostWindow` from `src/web/cost.ts`.
- Produces: `WorkflowAgentView` and `WorkflowRun` in `src/web/types.ts` (mirroring the server shapes exactly); `formatDuration(ms: number | null): string`; `formatWhen(ms: number | null): string`; `export function WorkflowsPage()`.

**Independent of Tasks 15 and 16** (the page is tested against a mocked `fetch`), but ship it after them so the page has a real endpoint to hit.

- [ ] **Step 1: Write the failing formatter tests**

Create `web-tests/time.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatDuration, formatWhen } from "../src/web/time.ts";

describe("formatDuration", () => {
  it("formats sub-minute, sub-hour and multi-hour spans", () => {
    expect(formatDuration(950)).toBe("1s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(185_000)).toBe("3m 5s");
    expect(formatDuration(3_840_000)).toBe("1h 4m");
  });
  it("renders a dash for null or negative input", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
  });
});

describe("formatWhen", () => {
  it("formats an epoch-ms instant as 'Mon D HH:MM' in local time", () => {
    const t = new Date(2026, 5, 16, 14, 3).getTime();
    expect(formatWhen(t)).toBe("Jun 16 14:03");
  });
  it("renders a dash for null", () => {
    expect(formatWhen(null)).toBe("—");
  });
});
```

- [ ] **Step 2: Run the formatter tests to verify they fail**

Run: `npx vitest run web-tests/time.test.ts`
Expected: FAIL — `formatDuration` / `formatWhen` are not exported.

- [ ] **Step 3: Implement the formatters**

Append to `src/web/time.ts`:

```ts
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A run/agent duration. Null or negative renders as an em dash. */
export function formatDuration(ms: number | null): string {
  if (ms == null || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** An absolute instant as "Jun 16 14:03", local time. Null renders as an em dash. */
export function formatWhen(ms: number | null): string {
  if (ms == null) return "—";
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${hh}:${mm}`;
}
```

- [ ] **Step 4: Write the failing page tests**

Create `web-tests/WorkflowsPage.test.tsx`:

```tsx
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { WorkflowsPage } from "../src/web/components/WorkflowsPage.tsx";
import type { WorkflowRun } from "../src/web/types.ts";

const T = new Date(2026, 5, 16, 14, 3).getTime();

const agent = (over: Partial<WorkflowRun["agents"][number]>): WorkflowRun["agents"][number] => ({
  agent_id: "a1", label: null, phase_index: null, phase_title: null, idx: null, model: null,
  state: "done", attempt: 1, last_tool: null, last_tool_summary: null, prompt_preview: null,
  started_at: null, ended_at: null, duration_ms: null, tool_calls: null, tokens: 0, costUsd: 0,
  ...over,
});

const RUNS: WorkflowRun[] = [
  {
    run_id: "wf_a", session_id: "s1", project: "alpha", branch: "main", name: "research",
    summary: null, status: "completed", state: "settled", error: null, started_at: T, ended_at: T + 1000,
    duration_ms: 185_000, agent_count: 2, phases: [{ title: "Explore", detail: null }],
    cc_version: "2.1.226", schema_ok: true, total_tokens_reported: 99, costUsd: 2, tokens: 100,
    agents: [
      agent({ agent_id: "a1", label: "map-codebase", phase_index: 1, phase_title: "Explore", model: "claude-sonnet-5", tokens: 60, costUsd: 1.5 }),
      agent({ agent_id: "a2", label: null, phase_index: null, state: "abandoned", tokens: 40, costUsd: 0.5 }),
    ],
  },
  {
    run_id: "wf_b", session_id: "s2", project: "beta", branch: null, name: null,
    summary: null, status: "brand-new-status", state: "settled", error: null, started_at: T - 86_400_000,
    ended_at: null, duration_ms: null, agent_count: 1, phases: [], cc_version: null, schema_ok: false,
    total_tokens_reported: null, costUsd: 9, tokens: 900, agents: [agent({ agent_id: "b1" })],
  },
];

function mockFetch(runs: unknown) {
  const fn = vi.fn().mockResolvedValue({ json: async () => ({ runs }) });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

afterEach(cleanup);
beforeEach(() => vi.restoreAllMocks());

describe("WorkflowsPage", () => {
  it("fetches and renders one row per run with formatted cells", async () => {
    mockFetch(RUNS);
    render(<WorkflowsPage />);
    expect(await screen.findByText("research")).toBeTruthy();
    expect(screen.getByText("wf_b")).toBeTruthy(); // name is null -> run_id fallback
    expect(screen.getByText("Jun 16 14:03")).toBeTruthy();
    expect(screen.getByText("3m 5s")).toBeTruthy();
    expect(screen.getByText("$9.00")).toBeTruthy();
  });

  it("renders an unknown status without rejecting it, marked as unknown", async () => {
    mockFetch(RUNS);
    render(<WorkflowsPage />);
    const cell = await screen.findByText("brand-new-status");
    expect(cell.getAttribute("data-status-known")).toBe("false");
    expect(screen.getByText("completed").getAttribute("data-status-known")).toBe("true");
  });

  it("shows a totals row summing agents, tokens and cost", async () => {
    mockFetch(RUNS);
    render(<WorkflowsPage />);
    await screen.findByText("research");
    const totals = screen.getByTestId("wf-totals");
    expect(within(totals).getByText("3")).toBeTruthy(); // 2 + 1 agents
    expect(within(totals).getByText("$11.00")).toBeTruthy(); // 2 + 9
  });

  it("sorts by cost descending when the Cost header is clicked", async () => {
    mockFetch(RUNS);
    render(<WorkflowsPage />);
    await screen.findByText("research");
    fireEvent.click(screen.getByRole("button", { name: /cost/i }));
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]).getByText("$9.00")).toBeTruthy(); // wf_b (9.0) first
  });

  it("refetches with the window's since param when the range changes", async () => {
    const fn = mockFetch(RUNS);
    render(<WorkflowsPage />);
    await screen.findByText("research");
    expect(String(fn.mock.calls[0][0])).toContain("since="); // default 14d
    fireEvent.click(screen.getByRole("button", { name: /^all$/i }));
    expect(String(fn.mock.calls.at(-1)![0])).not.toContain("since=");
  });

  it("expands a row into per-agent detail grouped under its phase", async () => {
    mockFetch(RUNS);
    render(<WorkflowsPage />);
    fireEvent.click(await screen.findByText("research"));
    expect(screen.getByText("Phase 1 · Explore")).toBeTruthy();
    expect(screen.getByText("map-codebase")).toBeTruthy();
    expect(screen.getByText("unphased")).toBeTruthy(); // the NULL phase_index agent groups last
    expect(screen.getByText("a2")).toBeTruthy(); // agentId fallback when label is null
    expect(screen.getByText("Sonnet 5")).toBeTruthy(); // prettyModel
  });

  it("shows an empty state when there are no runs", async () => {
    mockFetch([]);
    render(<WorkflowsPage />);
    expect(await screen.findByText(/no workflow runs/i)).toBeTruthy();
  });

  it("shows an error state when the fetch fails", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("boom")) as unknown as typeof fetch;
    render(<WorkflowsPage />);
    expect(await screen.findByText(/couldn.t load/i)).toBeTruthy();
  });
});
```

- [ ] **Step 5: Run the page tests to verify they fail**

Run: `npx vitest run web-tests/WorkflowsPage.test.tsx`
Expected: FAIL — cannot resolve `../src/web/components/WorkflowsPage.tsx`.

- [ ] **Step 6: Add the web types**

Append to `src/web/types.ts` (these mirror `src/server/store.ts`'s exported shapes exactly):

```ts
export interface WorkflowAgentView {
  agent_id: string;
  label: string | null;
  phase_index: number | null;
  phase_title: string | null;
  idx: number | null;
  model: string | null;
  state: string | null;
  attempt: number | null;
  last_tool: string | null;
  last_tool_summary: string | null;
  prompt_preview: string | null;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  tool_calls: number | null;
  tokens: number;
  costUsd: number;
}

export interface WorkflowRun {
  run_id: string;
  session_id: string;
  project: string;
  branch: string | null;
  name: string | null;
  summary: string | null;
  status: string | null;
  /** Derived liveness: "running" | "settled" | "orphaned". Typed as string
   *  because the server never validates Claude Code's vocabulary. */
  state: string;
  error: string | null;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  agent_count: number | null;
  phases: { title: string; detail: string | null }[];
  cc_version: string | null;
  schema_ok: boolean;
  total_tokens_reported: number | null;
  costUsd: number;
  tokens: number;
  agents: WorkflowAgentView[];
}
```

- [ ] **Step 7: Implement the page**

Create `src/web/components/WorkflowsPage.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import { formatUsd, formatTokens, prettyModel, costDailyRange, type CostWindow } from "../cost.ts";
import { formatDuration, formatWhen } from "../time.ts";
import type { WorkflowRun, WorkflowAgentView } from "../types.ts";

type SortKey = "when" | "workflow" | "project" | "status" | "duration" | "agents" | "tokens" | "cost";

const WINDOWS: CostWindow[] = [7, 14, 30, "all"];
const COLS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "when", label: "When", numeric: true },
  { key: "workflow", label: "Workflow", numeric: false },
  { key: "project", label: "Project/Branch", numeric: false },
  { key: "status", label: "Status", numeric: false },
  { key: "duration", label: "Duration", numeric: true },
  { key: "agents", label: "Agents", numeric: true },
  { key: "tokens", label: "Tokens", numeric: true },
  { key: "cost", label: "Cost", numeric: true },
];

// Known statuses get a colour; anything else renders grey rather than being
// rejected — Claude Code's vocabulary has already grown once ("failed").
const STATUS_CLASS: Record<string, string> = {
  completed: "text-working",
  running: "text-working",
  failed: "text-attention",
  killed: "text-attention",
  orphaned: "text-muted-foreground",
  settled: "text-muted-foreground",
};

function sortValue(r: WorkflowRun, key: SortKey): number | string {
  switch (key) {
    case "when":
      return r.started_at ?? 0;
    case "workflow":
      return r.name ?? r.run_id;
    case "project":
      return r.project;
    case "status":
      return r.status ?? r.state;
    case "duration":
      return r.duration_ms ?? 0;
    case "agents":
      return r.agents.length;
    case "tokens":
      return r.tokens;
    case "cost":
      return r.costUsd;
  }
}

/** Agents grouped under their 1-based phase, with unphased agents last. */
function byPhase(agents: WorkflowAgentView[]): { title: string; agents: WorkflowAgentView[] }[] {
  const groups = new Map<number, WorkflowAgentView[]>();
  const unphased: WorkflowAgentView[] = [];
  for (const a of agents) {
    if (a.phase_index == null) unphased.push(a);
    else groups.set(a.phase_index, [...(groups.get(a.phase_index) ?? []), a]);
  }
  const out = [...groups.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([idx, list]) => ({ title: `Phase ${idx} · ${list[0].phase_title ?? ""}`.trim(), agents: list }));
  if (unphased.length) out.push({ title: "unphased", agents: unphased });
  return out;
}

export function WorkflowsPage() {
  // Named `range`, not `window`, exactly as in CostDailyPage: a state variable
  // called `window` shadows the DOM global for the whole component body.
  const [range, setRange] = useState<CostWindow>(14);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "when", dir: "desc" });
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    const { since } = costDailyRange(range, Date.now());
    const qs = since != null ? `?since=${since}&limit=500` : "?limit=500";
    fetch(`/api/workflows${qs}`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        setRuns(Array.isArray(body?.runs) ? (body.runs as WorkflowRun[]) : []);
        setStatus("ok");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  const sorted = useMemo(() => {
    const copy = [...runs];
    const { key, dir } = sort;
    copy.sort((a, b) => {
      const av = sortValue(a, key);
      const bv = sortValue(b, key);
      const c = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return dir === "asc" ? c : -c;
    });
    return copy;
  }, [runs, sort]);

  const totals = useMemo(
    () =>
      sorted.reduce(
        (t, r) => ({ agents: t.agents + r.agents.length, tokens: t.tokens + r.tokens, cost: t.cost + r.costUsd }),
        { agents: 0, tokens: 0, cost: 0 }
      ),
    [sorted]
  );

  const toggleSort = (col: { key: SortKey; numeric: boolean }) =>
    setSort((s) =>
      s.key === col.key
        ? { key: col.key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key: col.key, dir: col.numeric ? "desc" : "asc" }
    );

  const toggleOpen = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="mx-auto max-w-6xl px-4 pb-12">
      <header className="sticky top-0 z-10 -mx-4 mb-4 flex flex-wrap items-center gap-3 border-b border-border bg-background/85 px-4 py-3 backdrop-blur">
        <a href="#/" className="text-sm text-muted-foreground transition hover:text-foreground">
          ← Dashboard
        </a>
        <span className="font-semibold tracking-tight text-foreground">Workflow runs</span>
        <div className="ml-auto inline-flex h-9 items-center overflow-hidden rounded-lg border border-border bg-muted text-sm text-muted-foreground">
          {WINDOWS.map((w) => (
            <button
              key={String(w)}
              type="button"
              onClick={() => setRange(w)}
              className={`flex h-full items-center px-3 leading-none transition hover:text-foreground ${
                range === w ? "bg-chip text-foreground" : ""
              }`}
            >
              {w === "all" ? "All" : `${w}d`}
            </button>
          ))}
        </div>
      </header>

      {/* Same four states, in the same order, as CostDailyPage: error → loading →
          empty → table. Without the loading branch the totals row renders "0 runs"
          for one frame on every window change. */}
      {status === "error" ? (
        <p className="px-2 py-8 text-center text-sm text-muted-foreground">Couldn’t load workflow runs.</p>
      ) : status === "loading" ? (
        <p className="px-2 py-8 text-center text-sm text-muted-foreground">Loading…</p>
      ) : sorted.length === 0 ? (
        <p className="px-2 py-8 text-center text-sm text-muted-foreground">No workflow runs in this window.</p>
      ) : (
        <table className="w-full border-collapse font-mono text-2xs">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              {COLS.map((c) => (
                <th
                  key={c.key}
                  aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                  className={`px-2 py-1.5 font-semibold ${c.numeric ? "text-right" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(c)}
                    className="inline-flex items-center gap-1 uppercase tracking-wider transition hover:text-foreground"
                  >
                    {c.label}
                    {sort.key === c.key && <span aria-hidden="true">{sort.dir === "asc" ? "▲" : "▼"}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const label = r.status ?? r.state;
              const known = Object.prototype.hasOwnProperty.call(STATUS_CLASS, label);
              return [
                <tr
                  key={r.run_id}
                  onClick={() => toggleOpen(r.run_id)}
                  className="cursor-pointer border-b border-border/50 hover:bg-card-hover"
                >
                  <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{formatWhen(r.started_at)}</td>
                  <td className="px-2 py-1 font-semibold text-foreground">
                    {r.name ?? r.run_id}
                    {!r.schema_ok && (
                      <span className="ml-1.5 rounded-full border border-border bg-chip px-1.5 py-0.5 text-[0.65rem] text-muted-foreground">
                        structure unavailable
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">
                    {r.project} · {r.branch ?? "—"}
                  </td>
                  <td data-status-known={String(known)} className={`px-2 py-1 ${STATUS_CLASS[label] ?? "text-muted-foreground/70"}`}>
                    {label}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{formatDuration(r.duration_ms)}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{r.agents.length}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-muted-foreground/70">{formatTokens(r.tokens)}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-foreground">{formatUsd(r.costUsd)}</td>
                </tr>,
                open.has(r.run_id) ? (
                  <tr key={`${r.run_id}-detail`} className="border-b border-border/50 bg-card/40">
                    <td colSpan={COLS.length} className="px-3 py-2">
                      {byPhase(r.agents).map((g) => (
                        <div key={g.title} className="mb-2 last:mb-0">
                          <div className="mb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                            {g.title}
                          </div>
                          {g.agents.map((a) => (
                            <div key={a.agent_id} className="flex flex-wrap items-baseline gap-2 py-0.5">
                              <span className="font-semibold text-foreground">{a.label ?? a.agent_id}</span>
                              <span className="text-muted-foreground">{a.model ? prettyModel(a.model) : "—"}</span>
                              <span className="text-muted-foreground">{a.state ?? "—"}</span>
                              <span className="text-muted-foreground/70">attempt {a.attempt ?? 1}</span>
                              <span className="text-muted-foreground/70">{formatDuration(a.duration_ms)}</span>
                              <span className="tabular-nums text-muted-foreground/70">{formatTokens(a.tokens)}</span>
                              <span className="tabular-nums text-foreground">{formatUsd(a.costUsd)}</span>
                              {a.last_tool_summary && (
                                <span className="truncate text-muted-foreground/70">▸ {a.last_tool_summary}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      ))}
                    </td>
                  </tr>
                ) : null,
              ];
            })}
            <tr data-testid="wf-totals" className="border-t border-border font-semibold text-foreground">
              <td className="px-2 py-1" />
              <td className="px-2 py-1">{sorted.length} runs</td>
              <td className="px-2 py-1" />
              <td className="px-2 py-1" />
              <td className="px-2 py-1" />
              <td className="px-2 py-1 text-right tabular-nums">{totals.agents}</td>
              <td className="px-2 py-1 text-right tabular-nums">{formatTokens(totals.tokens)}</td>
              <td className="px-2 py-1 text-right tabular-nums">{formatUsd(totals.cost)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run web-tests/time.test.ts web-tests/WorkflowsPage.test.tsx && bun run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/web/types.ts src/web/time.ts src/web/components/WorkflowsPage.tsx web-tests/time.test.ts web-tests/WorkflowsPage.test.tsx
git commit -m "feat(web): WorkflowsPage sortable run table with per-phase agent drill-down"
```

---

### Task 18: `#/workflows` route + AppBar link (§4.2)

**Files:**
- Modify: `src/web/App.tsx` (the ternary at line 33 becomes a switch)
- Modify: `src/web/components/AppBar.tsx` (add a link beside the Cost link, ~line 38)
- Test: `web-tests/App.test.tsx` (append a case; update the `global.fetch` stub)

**Interfaces:**
- Consumes: `WorkflowsPage` (Task 17), `useHashRoute()` (existing).
- Produces: `#/workflows` renders `WorkflowsPage`; `#/cost` still renders `CostDailyPage`; anything else renders `Board`.

**Needs Task 17.**

- [ ] **Step 1: Write the failing test**

In `web-tests/App.test.tsx`, widen the `global.fetch` stub in `beforeEach` so both pages can load:

```tsx
  global.fetch = vi.fn().mockResolvedValue({ json: async () => ({ rows: [], runs: [] }) }) as unknown as typeof fetch;
```

and append inside `describe("App routing", …)`:

```tsx
  it("renders the workflows page at #/workflows", async () => {
    window.location.hash = "#/workflows";
    const App = (await import("../src/web/App.tsx")).default;
    render(<App />);
    expect(await screen.findByText("Workflow runs")).toBeTruthy();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run web-tests/App.test.tsx`
Expected: FAIL — at `#/workflows`, App still renders `<Board>`, so "Workflow runs" is absent.

- [ ] **Step 3: Wire the route and the nav link**

In `src/web/App.tsx`, add the import and replace the final `return`:

```tsx
import { WorkflowsPage } from "./components/WorkflowsPage.tsx";
```

```tsx
  const route = useHashRoute();
  if (route === "#/cost") return <CostDailyPage />;
  if (route === "#/workflows") return <WorkflowsPage />;
  return <Board state={state} />;
```

In `src/web/components/AppBar.tsx`, add a link immediately after the existing `#/cost` link:

```tsx
        <a
          href="#/workflows"
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-muted px-3 text-sm leading-none text-muted-foreground transition hover:text-foreground"
        >
          <span aria-hidden="true">⚙</span>
          <span>Workflows</span>
        </a>
```

(The live-count badge on this link is added in Task 24, once the `workflows` prop exists.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run && bun run typecheck`
Expected: PASS — including the untouched `web-tests/AppBar.test.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/web/App.tsx src/web/components/AppBar.tsx web-tests/App.test.tsx
git commit -m "feat(web): hash route to WorkflowsPage + AppBar nav link"
```

---

### Task 19 (ops): build, restart, verify the history page

**Files:** none.

- [ ] **Step 1: Run the full suites**

```bash
cd /home/lunatic/projects/work/agent-monitor && bun test tests/ && npx vitest run && bun run typecheck
```
Expected: all green.

- [ ] **Step 2: Build the bundle, then restart — in that order, one command**

The server serves `dist/web` off disk, so building first means the restarted process serves the new bundle immediately. Chaining them removes the skew window entirely.

```bash
cd /home/lunatic/projects/work/agent-monitor && bun run web:build && systemctl --user restart am-server.service
```
Expected: a successful vite build, then a clean restart.

- [ ] **Step 3: Verify the endpoint and the page**

```bash
curl -s "http://localhost:4317/api/workflows?limit=3" | head -c 600
```
Expected: `{"runs":[{"run_id":"wf_…","project":"agent-monitor",…,"agents":[…]}]}`.

Then open `http://localhost:4317/#/workflows`: every completed run is listed, the Cost column totals to roughly the $1,124 from Task 14 over the "All" window, and clicking a row expands per-phase agent detail.

- [ ] **Step 4: Merge the branch**

```bash
git checkout main && git merge --no-ff feat/workflows-history
```

---

## Step 4 — `feat/workflows-live`

**Delivers:** the `workflows` SSE event, the 5s broadcast, `liveWorkflows()`, the `subscribe()` change, the `WorkflowsSection` board strip, the `wf` badge on `SessionCard`, and `workflows_degraded` in `buildState()`.

**Gate:** a live run appears within 5s and its tokens tick.

**Restart gotcha (from project memory):** `buildState()` gains `workflows_degraded` in this step. The web rebuild and the service restart happen in the **same command** (Task 24), and the web consumer tolerates the field being missing — typed `workflows_degraded?: number` and read as `?? 0`. Server-restart-on-rebuild skew has bitten this repo before.

```bash
git checkout -b feat/workflows-live
```

### Task 20: `liveWorkflows()`, `workflows_degraded`, and the second SSE event on connect (§3.1, §5.9)

**Files:**
- Modify: `src/server/store.ts` (append to the `// --- workflows ---` block; import `WF_RECHECK_MS`)
- Modify: `src/server/http.ts` (`buildState` at lines 62-75; the `/api/stream` block at lines 156-165)
- Test: `tests/cost-store.test.ts` (append)
- Test: `tests/http.test.ts` (append)

**Interfaces:**
- Consumes: `hydrateWorkflowRuns` (Task 15), `workflowsDegraded()` (Task 7).
- Produces:
  ```ts
  export interface LiveWorkflow {
    run_id: string; session_id: string; project: string; branch: string | null;
    name: string | null; status: string | null; state: string;
    started_at: number | null;
    phase: { index: number; total: number; title: string } | null;
    schema_ok: boolean; costUsd: number; tokens: number; agents: WorkflowAgentView[];
  }
  Store.liveWorkflows(now?: number): LiveWorkflow[]
  ```
  plus one new **top-level** scalar on `buildState()`: `workflows_degraded: number`.

- [ ] **Step 1: Write the failing store tests**

Append to `tests/cost-store.test.ts` inside `describe("Store usage rows", …)` (`seedRun` from Task 15 is already in scope):

```ts
  it("liveWorkflows returns unsettled runs only, with rollups and a 1-based phase pill", () => {
    const T = 1_700_000_000_000;
    seedRun(store, "wf_live", T);
    // Warm dir -> running; the same run an hour later is settled and drops out.
    const live = store.liveWorkflows(T + 1000);
    expect(live.length).toBe(1);
    expect(live[0].run_id).toBe("wf_live");
    expect(live[0].state).toBe("running");
    expect(live[0].costUsd).toBeCloseTo(4, 6);
    expect(live[0].tokens).toBe(40);
    expect(live[0].agents.length).toBe(2);
    // phases.length is 2 and the highest agent phase_index is 2 -> "Phase 2/2 · Judge"
    expect(live[0].phase).toEqual({ index: 2, total: 2, title: "Judge" });
    expect(store.liveWorkflows(T + 60 * 60 * 1000)).toEqual([]);
  });

  it("liveWorkflows keeps an orphaned run visible and reports phase: null with no phases", () => {
    store.upsertWorkflowRun({ run_id: "wf_orph", session_id: "ghost", dir: "/d/o", started_at: 1000, last_seen_at: 1000 });
    const live = store.liveWorkflows(2000);
    expect(live.length).toBe(1);
    expect(live[0].state).toBe("orphaned"); // no manifest, purged session
    expect(live[0].phase).toBeNull();
    expect(live[0].project).toBe("unknown"); // COALESCE, matching costByProject
  });

  it("liveWorkflows drops runs older than the 24h recheck window", () => {
    store.upsertWorkflowRun({ run_id: "wf_ancient", session_id: "p", dir: "/d/a", started_at: 1, last_seen_at: 1 });
    expect(store.liveWorkflows(1 + 25 * 60 * 60 * 1000)).toEqual([]);
  });
```

- [ ] **Step 2: Write the failing http tests**

Append to `tests/http.test.ts`:

```ts
describe("workflows on the stream", () => {
  it("emits BOTH state and workflows on connect", async () => {
    const res = await fetch(`${base}/api/stream`);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let seen = dec.decode((await reader.read()).value);
    if (!seen.includes("event: workflows")) seen += dec.decode((await reader.read()).value);
    expect(seen).toContain("event: state");
    expect(seen).toContain("event: workflows");
    await reader.cancel();
  });

  it("exposes workflows_degraded as a top-level scalar, not nested under cost", () => {
    const state = buildState(store) as any;
    expect(typeof state.workflows_degraded).toBe("number");
    expect(state.cost.workflows_degraded).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test tests/cost-store.test.ts tests/http.test.ts`
Expected: FAIL — `store.liveWorkflows is not a function`; `state.workflows_degraded` is undefined.

- [ ] **Step 4: Write the implementation**

In `src/server/store.ts`, add `WF_RECHECK_MS` to the config import, declare the interface beside `WorkflowRun`:

```ts
export interface LiveWorkflow {
  run_id: string;
  session_id: string;
  project: string;
  branch: string | null;
  name: string | null;
  status: string | null;
  state: string;
  started_at: number | null;
  /** 1-based verbatim, so a pill reads `Phase ${index}/${total}` with no arithmetic. */
  phase: { index: number; total: number; title: string } | null;
  schema_ok: boolean;
  costUsd: number;
  tokens: number;
  agents: WorkflowAgentView[];
}
```

and append to the `// --- workflows ---` block:

```ts
  /** Runs to show on the board strip: everything unsettled within the 24h recheck
   *  window. Orphaned runs stay visible deliberately — the state is self-healing,
   *  so a run whose files move again flips back to running.
   *
   *  This is the ONLY payload the 5s tick broadcasts. It must never grow into a
   *  buildState()-sized query. */
  liveWorkflows(now: number = Date.now()): LiveWorkflow[] {
    const rows = this.db
      .query(
        `SELECT * FROM workflow_runs
         WHERE last_seen_at IS NULL OR last_seen_at > $cutoff
         ORDER BY started_at DESC`
      )
      .all({ $cutoff: now - WF_RECHECK_MS }) as Record<string, any>[];

    return this.hydrateWorkflowRuns(rows, now)
      .filter((r) => r.state !== "settled")
      .map((r) => {
        // Current phase = the highest 1-based phase_index any agent carries.
        // Titles come from the manifest/script skeleton; without either there is
        // genuinely no label -> null, and the card says so in words (§4.1).
        const index = r.agents.reduce((m, a) => (a.phase_index != null && a.phase_index > m ? a.phase_index : m), 0);
        const total = r.phases.length;
        const title = index > 0 ? (r.phases[index - 1]?.title ?? r.agents.find((a) => a.phase_index === index)?.phase_title ?? "") : "";
        return {
          run_id: r.run_id,
          session_id: r.session_id,
          project: r.project,
          branch: r.branch,
          name: r.name,
          status: r.status,
          state: r.state,
          started_at: r.started_at,
          phase: index > 0 && total > 0 ? { index, total, title } : null,
          schema_ok: r.schema_ok,
          costUsd: r.costUsd,
          tokens: r.tokens,
          agents: r.agents,
        };
      });
  }
```

In `src/server/http.ts`, add `import { workflowsDegraded } from "./workflows.ts";` and extend `buildState` with **exactly one** top-level scalar — no arrays, no joins:

```ts
export function buildState(store: StoreType) {
  return {
    sessions: store.listSessions(),
    todos: store.listTodos(),
    activity: store.recentActivity(ACTIVITY_LIMIT),
    stats: store.toolStats(),
    // A scalar sibling of sessions/todos/activity/stats/cost — NOT nested in cost,
    // and never an array. buildState() is already 243ms; it must not get slower.
    workflows_degraded: workflowsDegraded(),
    cost: {
      ...store.costSummary(startOfLocalDay(Date.now())),
      byProject: store.costByProject(),
      byBranch: store.costByBranch(),
    },
  };
}
```

and add the second write in the `/api/stream` block, right after the existing `state` write:

```ts
        res.write(`event: state\ndata: ${JSON.stringify(buildState(store))}\n\n`);
        res.write(`event: workflows\ndata: ${JSON.stringify(store.liveWorkflows())}\n\n`);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/ && bun run typecheck` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/store.ts src/server/http.ts tests/cost-store.test.ts tests/http.test.ts
git commit -m "feat(server): liveWorkflows(), workflows_degraded scalar, workflows event on connect"
```

---

### Task 21: broadcast `workflows` from the 5s tick (§1.2, §3.1)

**Files:**
- Modify: `src/server/workflows.ts` (widen `scanWorkflows`'s return)
- Modify: `src/server/index.ts` (broadcast inside the existing workflow interval)
- Test: `tests/workflows.test.ts` (append)

**Interfaces:**
- Changes: `scanWorkflows(store, now)` now returns `{ changed: boolean; live: LiveWorkflow[] }` (it returned `{ changed: boolean }` from Task 12). Every existing call site already destructures `changed` only, so nothing else breaks.
- The `bumpDegraded` import in `index.ts` is already there from Task 13; this task only rewrites the body of the interval.

**Needs Task 20.**

- [ ] **Step 1: Write the failing test**

Append to `tests/workflows.test.ts`:

```ts
describe("scanWorkflows live payload", () => {
  it("returns the live run list alongside the changed flag", () => {
    const { store, runDir } = makeRun({ agents: ["a1"] });
    setMtime(runDir, NOW - 1000);
    const first = scanWorkflows(store, NOW);
    expect(first.changed).toBe(true);
    expect(first.live.map((w) => w.run_id)).toEqual(["wf_t1"]);
    expect(first.live[0].costUsd).toBeCloseTo(5, 6);
    expect(first.live[0].agents[0].agent_id).toBe("a1");
  });

  it("returns an empty live list once every run has settled", () => {
    const { store, runDir } = makeRun({ agents: ["a1"], manifest: fixture("wf_eb7bf7e8-8a5.manifest.json") });
    setMtime(runDir, NOW - 60 * 60 * 1000);
    scanWorkflows(store, NOW);
    const again = scanWorkflows(store, NOW);
    expect(again.changed).toBe(false);
    expect(again.live).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/workflows.test.ts`
Expected: FAIL — `first.live` is undefined.

- [ ] **Step 3: Write the implementation**

In `src/server/workflows.ts`, change `scanWorkflows`'s signature and final return (add `LiveWorkflow` to the `store.ts` type import):

```ts
export function scanWorkflows(store: Store, now: number): { changed: boolean; live: LiveWorkflow[] } {
```
```ts
  return { changed, live: store.liveWorkflows(now) };
```

In `src/server/index.ts`, broadcast from inside the workflow interval:

```ts
if (WORKFLOWS_ENABLED) {
  setInterval(() => {
    try {
      const { changed, live } = scanWorkflows(store, Date.now());
      // Broadcast ONLY on change — a tick that just re-stats and finds nothing
      // sends nothing. And never pushState(): buildState() is 243ms.
      if (changed) sse.broadcast("workflows", live);
    } catch (err) {
      // Unchanged from Task 13: the counter is gated on logOnce's boolean, so a
      // tick that fails every 5s counts once, not 720 times an hour (§5.5).
      if (logOnce("wf-scan", err)) bumpDegraded();
    }
  }, WF_TICK_MS);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/ && bun run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/workflows.ts src/server/index.ts tests/workflows.test.ts
git commit -m "feat(server): broadcast the workflows SSE event from the 5s tick, on change only"
```

---

### Task 22: `WorkflowRunCard` + `WorkflowsSection` (§4.1)

**Files:**
- Modify: `src/web/types.ts` (append `LiveWorkflow`; add `workflows_degraded?: number` to `State`)
- Create: `src/web/workflowStatus.ts` (extracted from `WorkflowsPage.tsx`)
- Modify: `src/web/components/WorkflowsPage.tsx` (import the extracted map instead of its local copy)
- Create: `src/web/components/WorkflowRunCard.tsx`
- Create: `src/web/components/WorkflowsSection.tsx`
- Create: `web-tests/WorkflowRunCard.test.tsx`

**Interfaces:**
- Consumes: `WorkflowAgentView` (Task 17), `usePersistedToggle`, `useNow`, `formatUsd`/`formatTokens`/`prettyModel`, `formatDuration`.
- Produces:
  ```ts
  // src/web/types.ts
  export interface LiveWorkflow { /* mirrors src/server/store.ts's LiveWorkflow exactly */ }
  export interface State { …; workflows_degraded?: number }   // OPTIONAL — see the skew gotcha

  // src/web/workflowStatus.ts
  export function statusKnown(label: string): boolean;
  export function statusClass(label: string): string;

  export function WorkflowRunCard({ w }: { w: LiveWorkflow }): JSX.Element;
  export function WorkflowsSection({ workflows }: { workflows: LiveWorkflow[] }): JSX.Element | null;
  ```

**Independent of Task 23** (both components are tested through props alone).

- [ ] **Step 1: Write the failing tests**

Create `web-tests/WorkflowRunCard.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkflowRunCard } from "../src/web/components/WorkflowRunCard.tsx";
import { WorkflowsSection } from "../src/web/components/WorkflowsSection.tsx";
import type { LiveWorkflow } from "../src/web/types.ts";

const agent = (over: Partial<LiveWorkflow["agents"][number]>): LiveWorkflow["agents"][number] => ({
  agent_id: "a1", label: null, phase_index: null, phase_title: null, idx: null, model: null,
  state: "running", attempt: 1, last_tool: null, last_tool_summary: null, prompt_preview: null,
  started_at: null, ended_at: null, duration_ms: null, tool_calls: null, tokens: 0, costUsd: 0,
  ...over,
});

const live = (over: Partial<LiveWorkflow> = {}): LiveWorkflow => ({
  run_id: "wf_abc", session_id: "s1", project: "alpha", branch: "feat/x", name: "research",
  status: null, state: "running", started_at: Date.now() - 185_000, phase: null, schema_ok: true,
  costUsd: 1.25, tokens: 512_000,
  agents: [agent({ agent_id: "a1", label: "map-codebase", model: "claude-sonnet-5", tokens: 300_000, costUsd: 1 })],
  ...over,
});

beforeEach(() => localStorage.clear());

describe("WorkflowRunCard", () => {
  it("shows the workflow name, project/branch, live cost and tokens", () => {
    render(<WorkflowRunCard w={live()} />);
    expect(screen.getByText("research")).toBeTruthy();
    expect(screen.getByText("alpha · feat/x")).toBeTruthy();
    expect(screen.getByText("$1.25")).toBeTruthy();
    expect(screen.getByText("512K tok")).toBeTruthy();
  });

  it("falls back to the run id when the workflow has no name", () => {
    render(<WorkflowRunCard w={live({ name: null })} />);
    expect(screen.getByText("wf_abc")).toBeTruthy();
  });

  it("says 'phases resolve on completion' when no phase is known", () => {
    // Not a bug to engineer away: the manifest is written once, at terminal
    // state, so a live run genuinely has no label->phase mapping.
    render(<WorkflowRunCard w={live({ phase: null })} />);
    expect(screen.getByText("phases resolve on completion")).toBeTruthy();
  });

  it("renders the 1-based phase pill verbatim when a phase is known", () => {
    render(<WorkflowRunCard w={live({ phase: { index: 2, total: 4, title: "Judge" } })} />);
    expect(screen.getByText("Phase 2/4 · Judge")).toBeTruthy();
  });

  it("falls back to the agentId when an agent has no label (the common live case)", () => {
    render(<WorkflowRunCard w={live({ agents: [agent({ agent_id: "ad673b79", label: null })] })} />);
    expect(screen.getByText("ad673b79")).toBeTruthy();
  });

  it("renders an unknown status without rejecting it, marked as unknown", () => {
    render(<WorkflowRunCard w={live({ status: "brand-new-status" })} />);
    expect(screen.getByText("brand-new-status").getAttribute("data-status-known")).toBe("false");
  });

  it("shows the structure-unavailable badge when the manifest parsed to zero agents", () => {
    render(<WorkflowRunCard w={live({ schema_ok: false })} />);
    expect(screen.getByText("structure unavailable")).toBeTruthy();
  });

  it("collapses the per-agent rows and remembers it per run", () => {
    render(<WorkflowRunCard w={live()} />);
    expect(screen.getByText("map-codebase")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /research/ }));
    expect(screen.queryByText("map-codebase")).toBeNull();
    expect(localStorage.getItem("am-wf-wf_abc")).toBe("true");
  });
});

describe("WorkflowsSection", () => {
  it("renders nothing at all when there are no live runs (zero vertical footprint)", () => {
    const { container } = render(<WorkflowsSection workflows={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders a card per live run behind a collapsible header", () => {
    render(<WorkflowsSection workflows={[live(), live({ run_id: "wf_two", name: "spec-plan" })]} />);
    expect(screen.getByRole("button", { name: /Workflows \(2\)/ })).toBeTruthy();
    expect(screen.getByText("research")).toBeTruthy();
    expect(screen.getByText("spec-plan")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web-tests/WorkflowRunCard.test.tsx`
Expected: FAIL — cannot resolve `../src/web/components/WorkflowRunCard.tsx`.

- [ ] **Step 3: Add the web types**

Append to `src/web/types.ts`:

```ts
export interface LiveWorkflow {
  run_id: string;
  session_id: string;
  project: string;
  branch: string | null;
  name: string | null;
  status: string | null;
  state: string;
  started_at: number | null;
  phase: { index: number; total: number; title: string } | null;
  schema_ok: boolean;
  costUsd: number;
  tokens: number;
  agents: WorkflowAgentView[];
}
```

and add one OPTIONAL field to `State`:

```ts
export interface State {
  sessions: Session[];
  todos: Todo[];
  activity: Activity[];
  stats: ToolStat[];
  cost: Cost;
  /** OPTIONAL on purpose: a rebuilt bundle can briefly talk to a server that
   *  predates the field (the restart-skew gotcha). Always read it as `?? 0`. */
  workflows_degraded?: number;
}
```

- [ ] **Step 4: Extract the shared status helper**

Create `src/web/workflowStatus.ts`:

```ts
// Known statuses get a colour; anything else renders grey rather than being
// rejected. Claude Code's vocabulary has already grown once ("failed"), so this
// map is a display hint, never a validator.
const WF_STATUS_CLASS: Record<string, string> = {
  completed: "text-working",
  running: "text-working",
  failed: "text-attention",
  killed: "text-attention",
  orphaned: "text-muted-foreground",
  settled: "text-muted-foreground",
};

export function statusKnown(label: string): boolean {
  return Object.prototype.hasOwnProperty.call(WF_STATUS_CLASS, label);
}

export function statusClass(label: string): string {
  return WF_STATUS_CLASS[label] ?? "text-muted-foreground/70";
}
```

In `src/web/components/WorkflowsPage.tsx`, delete the local `STATUS_CLASS` const and import the helpers instead:

```tsx
import { statusClass, statusKnown } from "../workflowStatus.ts";
```
and change the status cell to:
```tsx
                  <td data-status-known={String(statusKnown(label))} className={`px-2 py-1 ${statusClass(label)}`}>
                    {label}
                  </td>
```
(delete the now-unused `const known = …` line above it).

While in that file, also surface the recorded `cc_version` (§5.7) so fixtures get re-checked after a Claude Code upgrade. Add this immediately **after** the closing `</table>`, still inside the `) : (` branch — wrap the table and this line in a fragment (`<>…</>`):

```tsx
          {sorted.find((r) => r.cc_version)?.cc_version && (
            <p className="mt-3 px-2 text-2xs text-muted-foreground/70">
              format last verified on {sorted.find((r) => r.cc_version)!.cc_version}
            </p>
          )}
```

(`sorted` defaults to `started_at DESC`, so the first row carrying a version is the newest run's.) Add a test for it in `web-tests/WorkflowsPage.test.tsx`:

```tsx
  it("surfaces the newest run's Claude Code version so fixtures get re-checked after an upgrade", async () => {
    mockFetch(RUNS);
    render(<WorkflowsPage />);
    expect(await screen.findByText(/format last verified on 2\.1\.226/)).toBeTruthy();
  });
```

- [ ] **Step 5: Implement `WorkflowRunCard`**

Create `src/web/components/WorkflowRunCard.tsx`:

```tsx
import type { LiveWorkflow } from "../types.ts";
import { formatUsd, formatTokens, prettyModel } from "../cost.ts";
import { formatDuration } from "../time.ts";
import { statusClass, statusKnown } from "../workflowStatus.ts";
import { usePersistedToggle } from "../usePersistedToggle.ts";

const AGENT_DOT: Record<string, string> = {
  running: "bg-working animate-pulse",
  done: "bg-idle",
  abandoned: "bg-attention/60",
};

export function WorkflowRunCard({ w }: { w: LiveWorkflow }) {
  const [collapsed, toggleCollapsed] = usePersistedToggle(`am-wf-${w.run_id}`);
  const label = w.status ?? w.state;
  const title = w.name ?? w.run_id;

  return (
    <div className="am-fade-in mb-2 rounded-lg border border-border bg-card p-3 shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          className="inline-flex items-center gap-2 font-medium text-foreground transition hover:text-primary"
        >
          <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
          {title}
        </button>
        <span className="rounded-full border border-border bg-chip px-2 py-0.5 text-2xs text-muted-foreground">
          {w.project} · {w.branch ?? "—"}
        </span>
        <span data-status-known={String(statusKnown(label))} className={`text-2xs font-semibold ${statusClass(label)}`}>
          {label}
        </span>
        {!w.schema_ok && (
          <span className="rounded-full border border-border bg-chip px-2 py-0.5 text-2xs text-muted-foreground">
            structure unavailable
          </span>
        )}
        <span className="ml-auto font-mono text-2xs text-muted-foreground/70">
          {/* Ticks because WorkflowsSection re-renders at 1Hz via useNow(). */}
          {w.started_at != null ? formatDuration(Date.now() - w.started_at) : "—"}
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-2xs">
        <span className="rounded-full border border-border bg-chip px-2 py-0.5 text-muted-foreground">
          {w.phase ? `Phase ${w.phase.index}/${w.phase.total} · ${w.phase.title}` : "phases resolve on completion"}
        </span>
        <span className="text-foreground">{formatUsd(w.costUsd)}</span>
        <span className="text-muted-foreground/70">{formatTokens(w.tokens)} tok</span>
      </div>

      {!collapsed && (
        <div className="mt-2 flex flex-col gap-1">
          {w.agents.map((a) => (
            <div key={a.agent_id} className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-2xs">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${AGENT_DOT[a.state ?? ""] ?? "bg-idle"}`} />
              {/* Labels live only in the manifest, so agentId is the common live case. */}
              <span className="truncate text-foreground">{a.label ?? a.agent_id}</span>
              <span className="text-muted-foreground/70">{a.model ? prettyModel(a.model) : "—"}</span>
              <span className="tabular-nums text-muted-foreground/70">{formatTokens(a.tokens)}</span>
              {a.last_tool && <span className="truncate text-working/80">▸ {a.last_tool}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Implement `WorkflowsSection`**

Create `src/web/components/WorkflowsSection.tsx`:

```tsx
import type { LiveWorkflow } from "../types.ts";
import { useNow } from "../useNow.ts";
import { usePersistedToggle } from "../usePersistedToggle.ts";
import { WorkflowRunCard } from "./WorkflowRunCard.tsx";

/** Live workflow strip. Renders NOTHING when no run is live — zero vertical
 *  footprint on non-workflow days, which matters given how hard the board is
 *  already fighting for space. Inner-scrolls like TodosSection. */
export function WorkflowsSection({ workflows }: { workflows: LiveWorkflow[] }) {
  // 1Hz re-render so each card's elapsed timer ticks.
  useNow();
  const [collapsed, toggleCollapsed] = usePersistedToggle("am-workflows-collapsed");
  if (workflows.length === 0) return null;

  return (
    <section className="mt-7">
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          className="inline-flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground transition hover:text-foreground"
        >
          <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
          ⚙ Workflows ({workflows.length})
        </button>
        <a href="#/workflows" className="text-2xs text-muted-foreground transition hover:text-foreground">
          history →
        </a>
      </div>
      {!collapsed && (
        <div className="am-fade-in max-h-[40vh] overflow-y-auto pr-1">
          {workflows.map((w) => (
            <WorkflowRunCard key={w.run_id} w={w} />
          ))}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run && bun run typecheck` — Expected: PASS, including the untouched `WorkflowsPage` tests.

- [ ] **Step 8: Commit**

```bash
git add src/web/types.ts src/web/workflowStatus.ts src/web/components/WorkflowRunCard.tsx src/web/components/WorkflowsSection.tsx src/web/components/WorkflowsPage.tsx web-tests/WorkflowRunCard.test.tsx
git commit -m "feat(web): WorkflowsSection live strip + WorkflowRunCard"
```

---

### Task 23: plumb the `workflows` SSE event through `api.ts`, `App`, `Board`, `AppBar`, `SessionCard` (§3.1, §4.1)

**Files:**
- Modify: `src/web/api.ts:8-12` (`subscribe` takes a handlers object)
- Modify: `src/web/App.tsx` (second piece of state, held OUTSIDE `State`)
- Modify: `src/web/components/Board.tsx` (new optional prop, render the section, degraded banner, `wf` badge set)
- Modify: `src/web/components/AppBar.tsx` (optional `workflows` prop → live-count badge)
- Modify: `src/web/components/SessionCard.tsx` (optional `wf` prop → badge)
- Test: `web-tests/Board.test.tsx` (extend)
- Test: `web-tests/SessionCard.test.tsx` (extend)
- Test: `web-tests/App.test.tsx` (extend)

**Interfaces:**
- Changes: `subscribe(handlers: { onState: (s: State) => void; onWorkflows?: (w: LiveWorkflow[]) => void }): () => void` — was `subscribe(onState)`. `App.tsx` is the only call site.
- `Board({ state, workflows = [] })`, `AppBar({ state, workflows = [] })`, `SessionCard({ …, wf = false })` — every new prop is **optional with a default**, so `web-tests/AppBar.test.tsx` and the existing `SessionCard`/`Board` tests keep passing untouched.

**Needs Task 22.**

- [ ] **Step 1: Write the failing tests**

Append to `web-tests/Board.test.tsx`:

```tsx
import type { LiveWorkflow } from "../src/web/types.ts";

const liveRun: LiveWorkflow = {
  run_id: "wf_abc", session_id: "s1", project: "browns", branch: "main", name: "research",
  status: null, state: "running", started_at: Date.now() - 1000, phase: null, schema_ok: true,
  costUsd: 1, tokens: 10, agents: [],
};

describe("Board workflows strip", () => {
  it("renders no workflows section when there are zero live runs", () => {
    render(<Board state={state} />);
    // The AppBar always carries a "Workflows" LINK, so scope this to the section
    // toggle BUTTON to avoid a false positive.
    expect(screen.queryByRole("button", { name: /Workflows \(/ })).toBeNull();
  });

  it("renders the strip and flags the owning session when a run is live", () => {
    render(<Board state={state} workflows={[liveRun]} />);
    expect(screen.getByRole("button", { name: /Workflows \(1\)/ })).toBeTruthy();
    expect(screen.getByTitle("owns a live workflow run")).toBeTruthy(); // the wf badge on s1
  });

  it("warns when workflow data looks degraded", () => {
    render(<Board state={{ ...state, workflows_degraded: 3 }} />);
    expect(screen.getByText(/workflow data looks off/i)).toBeTruthy();
  });

  it("does not warn when the server predates workflows_degraded (field absent)", () => {
    render(<Board state={state} />);
    expect(screen.queryByText(/workflow data looks off/i)).toBeNull();
  });
});
```

Append to `web-tests/SessionCard.test.tsx`:

```tsx
describe("SessionCard workflow badge", () => {
  afterEach(cleanup);

  it("shows a wf badge when the session owns a live run", () => {
    render(<SessionCard s={base} wf />);
    expect(screen.getByTitle("owns a live workflow run")).toBeTruthy();
  });

  it("omits the badge by default", () => {
    render(<SessionCard s={base} />);
    expect(screen.queryByTitle("owns a live workflow run")).toBeNull();
  });
});
```

Append to `web-tests/App.test.tsx` inside `describe("App routing", …)` — replace the `vi.mock` at the top of the file so the test can drive the handlers:

```tsx
let handlers: any = null;
vi.mock("../src/web/api.ts", () => ({
  fetchState: () => Promise.resolve(EMPTY_STATE),
  subscribe: (h: any) => {
    handlers = h;
    return () => {};
  },
}));
```

```tsx
  it("feeds the workflows SSE event into the board, outside the state blob", async () => {
    window.location.hash = "#/";
    const App = (await import("../src/web/App.tsx")).default;
    render(<App />);
    await screen.findByText("agent-monitor");
    expect(typeof handlers.onWorkflows).toBe("function");
    act(() =>
      handlers.onWorkflows([
        { run_id: "wf_abc", session_id: "s1", project: "p", branch: null, name: "research", status: null,
          state: "running", started_at: Date.now(), phase: null, schema_ok: true, costUsd: 0, tokens: 0, agents: [] },
      ])
    );
    expect(screen.getByRole("button", { name: /Workflows \(1\)/ })).toBeTruthy();
  });
```

(add `act` to the `@testing-library/react` import in that file).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web-tests/Board.test.tsx web-tests/SessionCard.test.tsx web-tests/App.test.tsx`
Expected: FAIL — `Board` has no `workflows` prop, `SessionCard` has no `wf` prop, `handlers.onWorkflows` is undefined.

- [ ] **Step 3: Change `subscribe()`**

Replace `subscribe` in `src/web/api.ts`:

```ts
import type { State, TodoStatus, LiveWorkflow } from "./types.ts";

/** One EventSource, two event types. Workflows are deliberately NOT part of the
 *  `state` blob: that snapshot costs 243ms to build and is pushed at 60s, while
 *  the workflow strip refreshes every 5s. */
export function subscribe(handlers: {
  onState: (s: State) => void;
  onWorkflows?: (w: LiveWorkflow[]) => void;
}): () => void {
  const es = new EventSource("/api/stream");
  es.addEventListener("state", (e) => handlers.onState(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("workflows", (e) => handlers.onWorkflows?.(JSON.parse((e as MessageEvent).data)));
  return () => es.close();
}
```

- [ ] **Step 4: Hold the workflows list in `App`**

In `src/web/App.tsx`, add the state and pass it down:

```tsx
import type { State, LiveWorkflow } from "./types.ts";
```
```tsx
  const [workflows, setWorkflows] = useState<LiveWorkflow[]>([]);
```
```tsx
    const unsub = subscribe({ onState: apply, onWorkflows: setWorkflows });
```
```tsx
  return <Board state={state} workflows={workflows} />;
```

Workflow updates are applied straight through `setWorkflows` — no `runViewTransition`, because a 5s token tick is not a layout change worth animating.

- [ ] **Step 5: Thread it through `Board`**

In `src/web/components/Board.tsx`:

```tsx
import type { State, Session, Activity, LiveWorkflow } from "../types.ts";
import { WorkflowsSection } from "./WorkflowsSection.tsx";
```
```tsx
export function Board({ state, workflows = [] }: { state: State; workflows?: LiveWorkflow[] }) {
```
Inside the component, before the `return`:
```tsx
  // Computed once per render rather than passing the array down to every card.
  const wfSessions = new Set(workflows.map((w) => w.session_id));
```
Change the AppBar call and add the strip + banner between `TodosSection` and the Sessions `Lane`:
```tsx
      <AppBar state={state} workflows={workflows} />
```
```tsx
          <TodosSection todos={state.todos} />

          {(state.workflows_degraded ?? 0) > 0 && (
            <div className="mt-4 rounded-lg border border-attention/25 bg-attention/10 px-3 py-2 text-2xs text-attention">
              ⚠ workflow data looks off — Claude Code may have changed format
            </div>
          )}

          <WorkflowsSection workflows={workflows} />
```
and pass the badge into each card:
```tsx
                      cost={state.cost.perSession[s.id]}
                      wf={wfSessions.has(s.id)}
```

- [ ] **Step 6: Badge the `AppBar` link and the `SessionCard`**

In `src/web/components/AppBar.tsx`:

```tsx
import type { State, LiveWorkflow } from "../types.ts";
```
```tsx
export function AppBar({ state, workflows = [] }: { state: State; workflows?: LiveWorkflow[] }) {
```
and give the `#/workflows` link a live-count badge, hidden at zero:
```tsx
        <a
          href="#/workflows"
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-muted px-3 text-sm leading-none text-muted-foreground transition hover:text-foreground"
        >
          <span aria-hidden="true">⚙</span>
          <span>Workflows</span>
          {workflows.length > 0 && (
            <span className="rounded-full bg-working/20 px-1.5 text-2xs text-working">{workflows.length}</span>
          )}
        </a>
```

In `src/web/components/SessionCard.tsx`, add the optional prop and render the badge beside the project name:

```tsx
export function SessionCard({
  s,
  latestTool,
  latestDetail,
  cost,
  wf = false,
}: {
  s: Session;
  latestTool?: string;
  latestDetail?: string | null;
  cost?: SessionCost;
  wf?: boolean;
}) {
```
```tsx
      <div className="flex items-center gap-1.5 font-medium text-foreground">
        {s.project}
        {wf && (
          <span
            title="owns a live workflow run"
            className="rounded-full border border-border bg-chip px-1.5 py-0.5 font-mono text-2xs text-working"
          >
            wf
          </span>
        )}
      </div>
```
(replacing the existing `<div className="font-medium text-foreground">{s.project}</div>`).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run && bun run typecheck`
Expected: PASS — including `web-tests/AppBar.test.tsx`, which still renders `<AppBar state={state} />` with no second prop.

- [ ] **Step 8: Commit**

```bash
git add src/web/api.ts src/web/App.tsx src/web/components/Board.tsx src/web/components/AppBar.tsx src/web/components/SessionCard.tsx web-tests/Board.test.tsx web-tests/SessionCard.test.tsx web-tests/App.test.tsx
git commit -m "feat(web): subscribe to the workflows SSE event and render the live strip"
```

---

### Task 24 (ops): rebuild, restart, verify a live run

**Files:** none.

**The version-skew gotcha applies here.** Build and restart in **one chained command** so no browser can load the new bundle against the old server.

- [ ] **Step 1: Run the full suites**

```bash
cd /home/lunatic/projects/work/agent-monitor && bun test tests/ && npx vitest run && bun run typecheck
```
Expected: all green.

- [ ] **Step 2: Build then restart, in one command**

```bash
cd /home/lunatic/projects/work/agent-monitor && bun run web:build && systemctl --user restart am-server.service
```
Expected: vite build succeeds, then the unit restarts cleanly. Hard-reload the dashboard tab afterwards so the browser drops the cached bundle.

- [ ] **Step 3: Verify the stream carries both events**

```bash
timeout 3 curl -sN http://localhost:4317/api/stream | head -c 400
```
Expected: an `event: state` frame followed by an `event: workflows` frame.

```bash
curl -s http://localhost:4317/api/state | python3 -c "import json,sys; d=json.load(sys.stdin); print('workflows_degraded=', d.get('workflows_degraded'))"
```
Expected: `workflows_degraded= 0` (a non-zero value means a fixture needs re-checking against the current Claude Code version — see §5.7).

- [ ] **Step 4: Verify a live run end-to-end**

Start any Claude Code workflow in another terminal, then watch `http://localhost:4317/#/`:
- the strip appears above the Sessions lane within ~5s,
- its token and cost figures move on their own,
- the owning session card carries a `wf` badge,
- the AppBar "Workflows" link shows a live count,
- a run with no script anywhere shows *"phases resolve on completion"* — that is expected, not a bug (15 of 20 runs have a script under their own session dir, 3 more only under a sibling slug, 2 have none).

If no workflow is running, force the path instead:

```bash
sqlite3 -readonly ~/.local/share/agent-monitor/agent-monitor.sqlite \
  "SELECT run_id, status, manifest_seen, last_seen_at FROM workflow_runs ORDER BY last_seen_at DESC LIMIT 5;"
```
and confirm the newest run's `last_seen_at` advances while a workflow writes.

- [ ] **Step 5: Confirm the kill switch**

```bash
systemctl --user show am-server.service -p Environment
```
If the scanner ever needs disabling, `AM_WORKFLOWS=0` in the unit's environment turns it off entirely with no other change.

- [ ] **Step 6: Merge the branch**

```bash
git checkout main && git merge --no-ff feat/workflows-live
```

---

## Self-Review

**Spec coverage**

| Spec section | Task(s) |
|---|---|
| §0a rates + alias re-point (not `haiku`) | 1 |
| §0b delete-and-reingest incl. in-process re-tail, `app_meta` marker, runs before `listen()` | 2, 3, **4 (ops)** |
| §1.1 discovery, agent-set = files, missing-session fallback | 12, 13 |
| §1.2 4 config constants + second `setInterval` + `logOnce` (boolean-returning) + kill switch | 7, 13, 21 |
| §1.3 `parseManifest` / `parseJournal` / `parseAgentMeta` / `parseScriptMeta` / prompt_preview at 160 | 8, 9, 10 |
| §1.3 script lookup: primary under `<sessionDir>`, once-per-run cross-slug fallback at discovery/backfill | 10 (`findScriptFile`, `findScriptAcrossSlugs`), 12 (`!prev` gate), 13 (backfill is first sight) |
| §1.4 liveness state machine, un-settle on motion, file-growth hedge, orphan | 7 (`deriveRunState`), 12 (hedge) |
| §1.4 manifest-rewrite detection via `manifest_mtime`, `last_seen_at` unchanged | 5 (DDL), 11 (upsert + scan row), 12 (trigger) |
| §1.5 `takeUsage` refactor, `statSync` short-circuit, parent sessionId, run/agent columns, sidechain skip on the parent path | 6 |
| §2 both tables (incl. `manifest_mtime`), `usage` ALTERs, indexes, no FKs, derived per-agent cost | 5, 11, 15 |
| §3.1 separate `workflows` SSE event, both events on connect, `workflows_degraded` scalar, `subscribe()` change | 20, 21, 23 |
| §3.2 `GET /api/workflows` with embedded agents, range/limit, no pagination | 15, 16 |
| §4.1 `WorkflowsSection`, `WorkflowRunCard`, "phases resolve on completion", `wf` badge | 22, 23 |
| §4.2 `#/workflows` page, columns, totals row, per-phase expand, routing + AppBar link | 17, 18 |
| §5 tolerant parsing, raw status, `schema_ok`, `cc_version`, presence cross-check, degraded counter gated on `logOnce`, kill switch | 7 (`logOnce`), 8, 9, 12, 13, 20, 21, 22 |
| §6 all named test files and fixture rules | 7 (fixtures), 8–13, 15–18, 20–23 |
| §7 four branches, one merge each, gates, announcements, restart ordering | step headers, 4, 14, 19, 24 |

**Placeholder scan:** none — every code step carries full content; no "similar to Task N", no "add error handling".

**Type consistency:**
- `takeUsage(store, {path, offset, sessionId, runId?, agentId?, skipSidechain?}) → {offset, recorded}` — defined in Task 6. `tailUsage` (Task 6) is the **only** caller that sets `skipSidechain: true`; Task 12's workflow call deliberately omits it.
- `ParsedUsage.sidechain: boolean` — added in Task 6 and read only inside `takeUsage`. No other consumer of `parseUsageLine` exists.
- `logOnce(key, err) → boolean` — defined in Task 7; every one of the six call sites (four in Task 12, one in Task 13's backfill, and the shared `index.ts` interval/backfill catches in Tasks 13 and 21) gates `bumpDegraded()` on its return. No call site bumps without it, and no call site discards a `true`.
- `findScriptFile(sessionDir, runId)` / `findScriptAcrossSlugs(sessionDir, runId)` — both defined in Task 10, both called only from `scanRun` (Task 12); the cross-slug one behind the `!prev` discovery gate.
- `manifest_mtime` flows DDL (Task 5) → `WorkflowRunUpsert` + `WorkflowRunScanRow` + `WF_SCAN_COLS` (Task 11) → `scanRun`'s re-parse trigger and upsert (Task 12). It is deliberately **not** in `WorkflowRun` / `LiveWorkflow`: `hydrateWorkflowRuns` maps fields explicitly, so the extra column never reaches the API.
- `deriveRunState({manifest_seen: boolean, status, last_seen_at, session_status}, now)` — defined in Task 7, called in Tasks 12 (with `prev.manifest_seen === 1`) and 15 (with `r.manifest_seen === 1`). The DB column is `INTEGER`; both call sites convert.
- `WorkflowAgentUpsert` field names match the `workflow_agents` columns one-for-one and match `ManifestAgent`'s field names, so Task 12's spread-free mapping lines up.
- `WorkflowAgentView` / `WorkflowRun` / `LiveWorkflow` are declared once in `src/server/store.ts` (Tasks 15, 20) and mirrored verbatim in `src/web/types.ts` (Tasks 17, 22).
- `scanWorkflows` returns `{changed}` in Task 12 and `{changed, live}` from Task 21 — the widening is called out in Task 21's Interfaces block.
- `statusClass` / `statusKnown` live in `src/web/workflowStatus.ts` (Task 22) and are used by both `WorkflowsPage` and `WorkflowRunCard`.
