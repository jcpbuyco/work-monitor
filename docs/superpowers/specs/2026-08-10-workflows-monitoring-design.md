# Workflows monitoring — design

- **Status:** approved (brainstorm), pending implementation plan
- **Date:** 2026-08-10
- **Topic:** show Claude Code workflow runs (live + history) on the dashboard, and
  fold their token spend into the existing cost tracking

## Summary

Claude Code's workflow subsystem spawns fan-out subagent runs whose transcripts live
under `~/.claude/projects/<slug>/<sessionId>/subagents/workflows/wf_*/`. The monitor
does not read them today, so **13.4% of all spend on this machine is invisible** and
a running workflow shows on the board as a single silent session card.

This feature adds:

1. **Cost integration** — workflow agent transcripts are tailed into the *existing*
   `usage` table, so every cost view already in the product (CostPanel,
   CostBreakdown, `costByProject` / `costByBranch` / `costDaily`, per-session cost on
   `SessionCard`) becomes correct with **zero query changes**.
2. **Live view** — a `WorkflowsSection` strip above the Sessions lane, visible only
   while a run is live, showing phase, agent states, ticking tokens and live cost.
3. **History** — a `#/workflows` page cloned from `CostDailyPage`: window picker,
   sortable table, row-expand to phases and per-agent detail.

Ingestion is **file polling only** — no new hooks, no `fs.watch`, no PID registry,
strictly read-only on `~/.claude`.

## Goals

- Workflow spend lands in `usage` with correct `project` / `branch` attribution,
  live and backfilled.
- A running workflow is legible on the board within ~5s of anything changing.
- Completed runs are browsable with phase and per-agent drill-down.
- A Claude Code format change degrades the *presentation*, never the *cost*.

## Non-goals (decided, not deferred-with-regret)

- No transcript viewer. `prompt_preview` (160 chars) and `last_tool_summary` only.
- No run control (kill/retry/rerun). This is a read-only dashboard.
- No hooks, no `settings.json` change, no `fs.watch`, no PID/`/proc` liveness.
- No storage of `script` / `args` / `logs` / `result` blobs — bulk we would never
  render, and it is work content.
- No per-agent token/cost columns in the schema (derived from `usage`).
- No pagination on the history endpoint. No CSV/export, no charts.

## Verified constraints

These were measured on this machine during the design phase. **Do not re-derive
them; treat them as inputs.**

They are a **dated snapshot (2026-08-10)** of a directory that grows while you work.
Counts (runs, transcripts, dollars, rows) will have drifted by the time this is
implemented — that is expected and never invalidates a design decision. Anywhere a
count appears below, read it as "as surveyed on 2026-08-10". The survey then covered
**20 run dirs / 19 manifests / 18 script files / 116 agent transcripts** across
**3 parent sessions**; every count in this document is against that survey.

| # | Fact | Evidence |
|---|------|----------|
| C1 | **$1,123.94 of workflow spend is untracked** — 106 transcripts, 14,995 usage rows, 2.31B tokens — against $7,254.90 the DB tracks (13.4%). | Priced every workflow agent transcript with the repo's own `usage.ts` + `pricing.ts`. |
| C2 | **`RATES` in `pricing.ts` lacks `claude-sonnet-5` and `claude-opus-5`.** $786.01 of the $1,123.94 would price at **$0**. Pre-existing bug: the DB already holds **1,985 `claude-opus-5` rows at $0.00** from normal sessions. | `src/server/pricing.ts` lines 15–25; DB query. |
| C3 | **Agent transcript lines carry `sessionId` = the PARENT session id**, and `isSidechain: true`. `recordUsage()` stamps project/branch via `(SELECT … FROM sessions WHERE id = $s)`, so passing the parent id lights up every existing aggregation. | `head -1 …/wf_3b398ae6-146/agent-ad673b7945d8642df.jsonl` → `sessionId` `df8a5ade-…`, the id already in `sessions`. Verified twice, independently. |
| C4 | **Zero uuid overlap** between a parent transcript and its agents' transcripts (137 vs 658 uuids, 0 shared). Ingestion is cleanly additive and idempotent for free via the `message_uuid` PK. | Set intersection over both files. |
| C5 | **`buildState()` costs 243ms / 43.5KB**, of which `toolStats()` alone is **232ms** (full scan of 98,534 events). A 5s full-state tick would burn ~5% CPU permanently. | Timed against the live DB. |
| C6 | **A manifest is NOT terminal.** Run `wf_3b398ae6-146` had a `status:"failed"` manifest at 09:27:58 with agent transcripts still appending at **09:33:46** — 6 minutes later. The manifest was then **rewritten**: it now reads `"completed"` with mtime 09:41:16, later than every agent file. | `stat` on the manifest vs `ls --time-style=full-iso` on the run dir. |
| C7 | **`started`-without-`result` does not mean running.** A *completed* run (`wf_eb7bf7e8-8a5`) has **6 `started` / 3 `result`** over 6 distinct keys. Another (`wf_57b2617f-124`) has 13 `started` / 10 `result` over **10** keys — retries reuse a key with a fresh `agentId`. | `jq` over every `journal.jsonl`. |
| C8 | **The PID registry `~/.claude/sessions/<pid>.json` lags badly** — it reported 09:15 while that session's agent files were being written at 09:30. Rejected. | Direct comparison. |
| C9 | **Session dir = `transcript_path` minus `.jsonl`**, exact — manifests at `<sessionDir>/workflows/<runId>.json` and run dirs at `<sessionDir>/subagents/workflows/<runId>/` hold for **20 of 20** runs. **Scripts do not**: `<sessionDir>/workflows/scripts/<workflowName>-<runId>.js` resolves for only **15 of 20**. When a session's cwd moves into a subdirectory, Claude Code writes that run's script under a *different project slug* carrying the *same* sessionId (e.g. `wf_57b2617f-124`'s run dir is under `…-malta-scoping/85441d1f-…` but its script is under `…-malta-scoping-browns-commerce/85441d1f-…`). Manifests and run dirs never split this way. | Path survey across all 20 runs. |
| C10 | Discovery cost: `readdirSync` of a live session's workflows dir ≈ **100µs**; the one-time startup glob over `~/.claude/projects/*/*/subagents/workflows/wf_*` ≈ **1ms for 20 dirs**. | Timed. |
| C11 | Format drift is already observed: one manifest carries an extra `args` key; `lastToolSummary` is present on only 85/104 manifest agent entries; 32 of 116 `agent-*.meta.json` files omit `model` entirely; 2 runs have no script file anywhere; 5 more have one only under a sibling slug (C9); and the status vocabulary has exceeded the expected `completed`/`killed` — `failed` was observed live on `wf_3b398ae6-146` (C6) before that manifest was rewritten, so all 19 manifests on disk now read `completed` and the transient value is invisible to a survey. Transcript `version` is **2.1.226** on recent runs, **2.1.220** on older ones. | Survey of all 19 manifests + 116 agent transcripts. |
| C12 | Agent transcripts reach **6.3MB** (largest observed; 3 exceed 5MB) and would be polled every 5s. `tailUsage()` currently `readFileSync`s the whole file every pass. This is the strongest single argument for the `statSync` short-circuit in §1.5. | `ls -la` on run dirs. |

## On-disk layout we read

```
~/.claude/projects/<slug>/
  <sessionId>.jsonl                       ← parent transcript (already tailed)
  <sessionId>/
    workflows/
      <runId>.json                        ← MANIFEST (written at terminal, REWRITTEN on resume)
      scripts/<workflowName>-<runId>.js   ← optional; the only LIVE source of phase titles.
                                            NOT reliably under this slug — see C9
    subagents/workflows/<runId>/
      journal.jsonl                       ← {type:"started"|"result", key, agentId, result?}
      agent-<agentId>.jsonl               ← the transcript we price (up to 6.3MB)
      agent-<agentId>.meta.json           ← {agentType, spawnDepth, model?}  (48–65 bytes;
                                            the 48-byte form has no `model`)
```

`journal.jsonl`'s `key` is an opaque content hash (`v2:<sha256>`), **not** a human
label — it is a grouping key only and is never rendered. Human labels
(`read:saga`, `verify:suites`) exist only in the manifest, which is why a live run
can show agent ids but not names (§4.1, accepted risk 2).

Manifest keys actually present: `runId`, `workflowName`, `status`, `startTime`,
`timestamp`, `durationMs`, `agentCount`, `totalTokens`, `totalToolCalls`, `phases`
(`[{title, detail}]`), `summary`, `result`, `script`, `scriptPath`, `args`, `logs`,
`taskId`, `defaultModel`, `workflowProgress`. Every one of those is present on all 19
manifests surveyed; `args` is the sole exception, appearing on exactly 1 of them.

Observed types, which pin the column mappings in §2: `startTime` is **epoch ms**
(number) → `started_at`; `timestamp` is an **ISO 8601 string** → `ended_at` via
`Date.parse` (a manifest is only ever written at a terminal moment, so its
`timestamp` is the end); `durationMs` number; `summary` string; `result` object;
`logs` array.

`workflowProgress` is a **mixed** array. Entries with `type === "workflow_agent"`
carry: `index`, `label`, `phaseIndex`, `phaseTitle`, `agentId`, `model`, `state`,
`startedAt`, `queuedAt`, `attempt`, `lastToolName`, `lastToolSummary`,
`promptPreview`, `lastProgressAt`, `tokens`, `toolCalls`, `durationMs`,
`resultPreview`. Entries of other types (`workflow_phase`, carrying `index` and
`title`) are **filtered out**, never destructured.

**`index` and `phaseIndex` are 1-based**, and `max(phaseIndex) === phases.length` on
every manifest surveyed. Both are stored **verbatim** (no rebasing), so a phase pill
reads `Phase ${phaseIndex}/${phases.length}` directly.

The manifest lists only the *winning* agent per journal key: `wf_57b2617f-124` has
10 `workflow_agent` entries and `agentCount: 10`, but 13 `agent-*.jsonl` files and 13
journal agentIds. `attempt` is `1` on all 104 surveyed entries — a retry produces a
**new agentId absent from the manifest**, not an incremented `attempt`. So `attempt`
is a display field only and is never used to detect retries (§1.3 rule 2 does that).

## Architecture

```
                    ┌── 5s WF_TICK ──► scanWorkflows() ──► workflow_runs / workflow_agents
                    │                        │                    │
  ~/.claude (RO) ───┤                        └── takeUsage() ─► usage (run_id, agent_id)
                    │                                                │
                    └── 60s SWEEP (untouched) ─► tailUsage() ────────┘
                                                                     │
   sse.broadcast("workflows", liveRuns) ◄── payload differs? ────────┤
   sse.broadcast("state", …)            ◄── 60s cadence ─────────────┘
                                                     GET /api/workflows ──► #/workflows
```

Five units:

| Unit | File | Role |
|---|---|---|
| Parsers | `src/server/workflows.ts` (new) | pure: `sessionDirFor`, `parseManifest`, `parseJournal`, `parseAgentMeta`, `parseScriptMeta`, `deriveRunState`; plus the two path lookups `findScriptFile` / `findScriptAcrossSlugs` (§1.3) |
| Scanner | `src/server/workflows.ts` | impure: `scanWorkflows(store, now)` → `{ changed }` (bookkeeping only — the broadcast gate is `workflowTick`'s payload diff, §3.1) |
| Tail core | `src/server/usage.ts` | `takeUsage(store, {path, offset, sessionId, runId, agentId})`, used by both paths; `tailUsage()` becomes a wrapper over it |
| Store | `src/server/store.ts` | `upsertWorkflowRun`, `upsertWorkflowAgent`, `runsToScan`, `workflowHistory`, `liveWorkflows` |
| Web | `WorkflowsSection`, `WorkflowRunCard`, `WorkflowsPage` (new, in `src/web/components/`) | live strip + history page |

Existing files that change, so a plan can size the work: `src/server/db.ts`
(migration), `src/server/config.ts` (4 constants), `src/server/index.ts` (second
`setInterval`, repricing routine), `src/server/http.ts` (`/api/workflows`, second
`event:` line on connect, `workflows_degraded` in `buildState`), `src/server/pricing.ts`
(§0a), `src/web/api.ts` (`subscribe` handlers), `src/web/App.tsx` (route switch,
workflows state), `src/web/types.ts` (`LiveWorkflow`, `WorkflowRun`,
`workflows_degraded?`), `src/web/components/Board.tsx`, `AppBar.tsx`, `SessionCard.tsx`.

---

## 0. Pricing prerequisite — ships FIRST, alone

**Sequencing is load-bearing.** `recordUsage()` is `INSERT OR IGNORE` on
`message_uuid`, so a row inserted at the wrong price is *never* repriced. Backfilling
15k workflow rows before fixing `RATES` would bake $786 of $0.00 into the DB and
force a redo.

**Step 0a — add the missing rates** to `RATES` in `src/server/pricing.ts`:

```ts
"claude-opus-5":   { input: 5,  output: 25 },
"claude-sonnet-5": { input: 3,  output: 15 },
```

Placed above the `-4-*` entries. In `FAMILY_ALIAS`, **`opus` and `sonnet` only** are
re-pointed:

```ts
opus:   "claude-opus-5",     // was claude-opus-4-8
sonnet: "claude-sonnet-5",   // was claude-sonnet-4-6
haiku:  "claude-haiku-4-5",  // UNCHANGED — there is no claude-haiku-5 rate
fable:  "claude-fable-5",    // unchanged
mythos: "claude-mythos-5",   // unchanged
```

**Do not re-point `haiku`.** No `claude-haiku-5` exists in `RATES` and none is being
added; re-pointing it would send every bare `haiku` to `costOf`'s unknown-model
branch and cost it $0 — reintroducing the exact bug this step exists to fix.

Note what the alias re-point does and does not buy. Pricing reads
`message.model` from the transcript line, and every workflow agent transcript
surveyed emits a **fully-qualified** id (`claude-sonnet-5`, `claude-opus-5`,
`claude-fable-5`, `claude-haiku-4-5-20251001`) — never a bare alias. The bare aliases
live in `agent-*.meta.json` (`{"model":"sonnet"}`, 70 of 116 files) and are used for
**display and per-agent model attribution only**. So the re-point is about (a) not
mis-labelling a current-tier agent as a 4-series model in the UI, and (b) keeping
`canonicalModel()` grouping stable if a transcript ever does emit a bare alias. The
$786 is recovered by the `RATES` additions alone.

**Step 0b — reprice the existing $0.00 rows** (the re-ingest trick recorded in
project memory). The routine is self-contained and does **not** depend on the sweep:

1. Collect the owning sessions first:
   `SELECT DISTINCT session_id FROM usage WHERE cost_usd = 0 AND model IN ('claude-opus-5','claude-sonnet-5')`.
2. Drop any session whose `transcript_path` is NULL or whose file no longer exists —
   its rows are unrecoverable and deleting them would lose token history for nothing.
3. `DELETE FROM usage WHERE cost_usd = 0 AND model IN ('claude-opus-5','claude-sonnet-5') AND session_id IN (<kept>)`.
   The model filter is load-bearing: it leaves the 18 `<synthetic>` $0.00 rows, which
   are legitimately free, untouched.
4. `UPDATE sessions SET usage_offset = 0` for each kept session.
5. **Re-tail those sessions in-process, immediately** — `tailUsage()` over each,
   sourced from `listSessions({includeEnded:true})`. `INSERT OR IGNORE` on
   `message_uuid` means the surviving rows are no-ops and only the deleted ones
   come back, now at the correct price.

Step 5 is not optional and cannot be delegated. **All 1,985 affected rows belong to
`ended` sessions** (10 sessions, all ended), and `sessionsToTail()` filters
`status != 'ended'`, so the 60s sweep would never re-insert a single one. The step-2
workflow backfill does not help either: it tails `agent-*.jsonl` files, not the
parent transcripts these rows came from. Without step 5, step 1 is a pure deletion
and its own gate ("`#/cost` shows non-zero opus-5 spend") cannot pass.

Repricing is a one-shot maintenance routine in `src/server/index.ts`, gated behind
`AM_REPRICE=1` for the manual first run and guarded by a marker row so a restart
cannot re-run it. There is no key/value table today, so `migrate()` gains a minimal
one:

```sql
CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT);
-- marker: key = 'reprice_5_series_done', value = epoch ms
```

The routine runs **before** `server.listen()`, so no request observes the
half-deleted state, and steps 3–5 run inside a single transaction — a crash between
the DELETE and the re-tail must not be possible.

**Announce in the commit message:** cost history for past days will visibly jump.
That is correct — the spend was always real — but it is jarring on the `#/cost` page.

---

## 1. Ingestion

### 1.1 Discovery — no hot-path globbing

```ts
const sessionDir = session.transcript_path.replace(/\.jsonl$/, "");  // C9, exact
const runsDir    = join(sessionDir, "subagents", "workflows");
```

- **Steady state:** iterate `store.listSessions()` (non-ended only), `readdirSync`
  each `runsDir`, filter `wf_*`. ~2 dirs today, ~100µs (C10). `ENOENT` → skip.
- **Startup backfill (once):** glob
  `~/.claude/projects/*/*/subagents/workflows/wf_*`. ~1ms for 20 dirs (C10). This is
  the only place a **tree-wide** glob is allowed; the one other cross-slug lookup
  (§1.3's script fallback) is pinned to a single sessionId and a single runId and
  runs at most once per run. Resolve each hit to its session by
  **path structure, not by string-matching `transcript_path`**: the session dir is
  the run dir's third parent (`…/<sessionId>/subagents/workflows/<runId>` →
  `…/<sessionId>`) and the sessionId is that directory's basename. Look the id up in
  `sessions`.
- **A run dir whose sessionId is not in `sessions` is still ingested.** `recordUsage`'s
  subquery yields NULL project/branch, which the existing cost queries already bucket
  under `'unknown'` — the same treatment pre-attribution rows get. Skipping it would
  silently drop spend, which is the one thing this feature exists to prevent. All 3
  sessions owning runs today are present with project **and** branch, so today this
  branch is dead code; it exists so a purged session cannot cost us money.
- **Never** recompute the project slug from `cwd`. The stored `transcript_path` is
  the single source of truth for a *session's* dir; the run dir's own path is the
  source of truth during backfill.

**Agent set = the run dir's `agent-*.jsonl` files.** Not the manifest, not the
journal. `wf_57b2617f-124` has 13 transcripts against a 10-entry manifest; keying off
the manifest would lose 3 agents' tokens. Each `agent-<id>.jsonl` yields one
`workflow_agents` row (PK `(run_id, agent_id)`), which the journal and manifest then
*enrich* — never gate. An agent id present in the journal or manifest with no
transcript file still gets a row (label/state only, `offset = 0`).

### 1.2 The tick

New in `src/server/config.ts`, beside `SWEEP_INTERVAL_MS`:

```ts
/** Workflow scan cadence. A live run must feel live; 60s freezes the card. */
export const WF_TICK_MS = 5 * 1000;
/** Run dir mtime unchanged this long ⇒ stop tailing (ACTIVE → SETTLED). The same
 *  window, combined with a missing manifest, is what reads as `orphaned` — a
 *  display state only, never persisted. Both uses are deliberate (§1.4 rules 2, 4). */
export const WF_QUIET_MS = 10 * 60 * 1000;
/** Settled runs younger than this are re-stat'd to catch resumed appends (C6). */
export const WF_RECHECK_MS = 24 * 60 * 60 * 1000;
/** Kill switch. AM_WORKFLOWS=0 disables the scanner entirely. */
export const WORKFLOWS_ENABLED = process.env.AM_WORKFLOWS !== "0";
```

A **second** `setInterval` in `src/server/index.ts`. The existing 60s sweep is
**untouched** — existing behaviour and tests stay valid.

```ts
if (WORKFLOWS_ENABLED) setInterval(() => workflowTick(store, sse, Date.now()), WF_TICK_MS);

// workflows.ts — the tick body lives here so it is testable without the server:
export function workflowTick(store, hub, now) {
  try {
    scanWorkflows(store, now);                       // `changed` is NOT the gate (§3.1)
    const payload = store.liveWorkflows(now);
    const serialized = JSON.stringify(payload);
    if (lastBroadcast === serialized) return;        // identical payload ⇒ silence
    lastBroadcast = serialized;
    hub.broadcast("workflows", payload);
  } catch (err) { if (logOnce("wf-scan", err)) bumpDegraded(); }
}
```

The whole tick is inside one `try/catch` (the `toolStats()` precedent) so a workflow
parse error can never break the stale sweep or session cost tailing.

`logOnce(key, err)` is **new** — no such helper exists today. Model it on the
`warned` Set in `src/server/pricing.ts`: a module-level `Set<string>` in
`src/server/workflows.ts`, one `console.warn` per key per process. Keys are per run
id (§5.5's "once per run, not per tick"). It **returns `true` only on the pass that
actually logged**, and `bumpDegraded()` is called *only* when it does — so
`workflows_degraded` counts once per run per cause rather than once per 5s tick
(§5.5, §5.9).

Note what this tick deliberately does *not* do: it never calls `pushState()`. Usage
rows it records therefore do not reach `SessionCard`'s per-session cost or the cost
panels until the next 60s sweep. That is the asymmetry §3.2 accepts, stated here
because "why didn't the session card move" is the obvious first bug report.

**Gating:** if no run is unsettled, the tick is the `readdir` and returns. It never
touches settled runs except the bounded `WF_RECHECK_MS` re-stat below.

### 1.3 Parsing (pure functions, `src/server/workflows.ts`)

`parseManifest(text) → ManifestView | null`

- Never destructure. Every field read through a tolerant getter with a default.
- `workflowProgress` filtered by `e?.type === "workflow_agent"`; anything else is
  ignored (`workflow_phase` observed today, more will come).
- `status` is stored **raw, verbatim** — no enum, no validation. Known values get a
  colour; unknown ones render grey (C11: `failed` already broke the expected
  vocabulary).
- A manifest missing `workflowProgress` still yields status/duration/tokens.
  Degraded, not broken.

`parseJournal(lines) → Map<agentId, AgentState>` — the reduction rules (C7):

1. Ignore any line whose `type` is not `started` or `result`. Unknown types are
   counted toward `workflows_degraded`, never thrown on.
2. Group by `key` (the opaque `v2:<sha256>`, stored as `workflow_agents.journal_key`
   and never rendered). **The last `agentId` seen for a key in file order wins** —
   file order, not a timestamp, since journal lines carry none; earlier agentIds for
   that key become `abandoned`. This is what dedupes retries — C7's
   13-started / 10-result / 10-key run yields 10 winners + 3 abandoned.
3. A key whose winning agentId has a `result` line ⇒ that agent is `done`.
4. A key whose winning agentId has no `result` ⇒ `running` **only when the manifest
   is absent**. When a manifest exists it always overrides — C7's completed
   6-started / 3-result / 6-key run has 3 keys with no result and would otherwise
   show 3 phantom running agents forever.
5. Superseded agentIds keep their own row (state `abandoned`) so their tokens still
   attribute; they are collapsed behind the run card, not hidden.
6. An agent transcript with **no** journal mention at all (possible mid-write) gets
   state `running` while the run is ACTIVE and `done` once it settles. Cost tailing
   never consults the journal — it is driven by the file list (§1.1).

`parseAgentMeta` reads the 48–65 byte `agent-<id>.meta.json` for `model` (usually a
bare alias — `canonicalModel()` handles it). **32 of 116 meta files omit `model`
entirely** (the 48-byte form is exactly `{"agentType":…,"spawnDepth":1}`), so the
fallback is not an edge case: model then comes from the agent transcript's first line
carrying a `message.model`, else `null`. Meta `model` is **display only** — never a
pricing input (§0a).

`parseScriptMeta` reads `<sessionDir>/workflows/scripts/<name>-<runId>.js` for the
run name and phase skeleton, matching by the `-<runId>.js` suffix (never by the
manifest's `scriptPath`, whose filename is unreliable — C11). **Optional and
best-effort:** of 20 runs, 15 resolve under their own session dir, **3 more resolve
only under a sibling project slug** carrying the same sessionId (C9), and 2 have no
script anywhere.

**Decision: primary lookup under `<sessionDir>`, then one narrow cross-slug
fallback.** When the primary lookup misses, look for
`~/.claude/projects/*/<sessionId>/workflows/scripts/*-<runId>.js`. The projects root
is derived by **path structure**, not config: `<sessionDir>` is
`<root>/<slug>/<sessionId>`, so the root is two levels up — the same
resolve-by-structure rule §1.1 uses for backfill, and it keeps the search inside the
tree that already holds the run. The glob is pinned to **one** sessionId and **one**
runId: a `readdir` per project slug, never a tree walk.

**It runs at most ONCE per run — on the tick that discovers the run (the pass that
first writes its row) or during the startup backfill — and NEVER on a steady-state
5s tick.** The cheap primary `readdir` stays on the tick, so a script written late
under the session's own dir is still picked up; only a late-written *sibling-slug*
script is missed. This buys back 3 of the 5 misses (18 of 20 runs resolve a script).
The 2 genuine absences degrade exactly as before: the card renders *"phases resolve
on completion"* (§4.1) and the completed run gets full phases from its manifest
anyway.

`prompt_preview` is captured once from the agent transcript's first line, via
`truncate(text, 160)` from `derive.ts` — the length **must** be passed explicitly;
`truncate`'s default is `MAX_INTENT_LEN` (140), not 160.

### 1.4 Liveness state machine

Two independent signals — **structure** and **motion** — deliberately not conflated.

```
                 ┌───────────────────────────────────────────────┐
  discovered ──► │ ACTIVE: tail every agent-*.jsonl each tick     │
                 └───┬───────────────────────────────────────────┘
                     │ last_seen_at unchanged for WF_QUIET_MS
                     ▼
                 ┌───────────────────────────────────────────────┐
                 │ SETTLED: stop tailing; re-stat cheaply        │
                 └───┬───────────────────────────────────────────┘
                     │ last_seen_at advanced (dir mtime moved, OR any
                     │ agent-*.jsonl / journal.jsonl file's mtime moved)
                     └──────────────► back to ACTIVE  (un-settle)
```

**Rules, in force order:**

1. **Manifest present ⇒ terminal FOR STRUCTURE ONLY.** It fixes labels, phases,
   states, durations. It does **not** stop cost tailing (C6 — a `failed` manifest was
   followed by 6 minutes of appends and then rewritten to `completed`). Any
   implementation that seals on `manifest_seen` permanently loses resumed spend.
2. **Tailing stops on quiet, not on manifest.** A run leaves ACTIVE only when
   `last_seen_at` has not advanced for `WF_QUIET_MS`.
3. **Un-settle on motion.** Each tick, settled runs with
   `now - last_seen_at < WF_RECHECK_MS` get one `statSync` on the run dir AND on
   every known `agent-*.jsonl`/`journal.jsonl`; `last_seen_at` is the MAX of all of
   those mtimes, so any one of them moving un-settles the run. Because a resume
   spawns a **new** agentId (hence a new file), the dir mtime bumps; an append to an
   *already-tracked* transcript instead bumps that FILE's own mtime, which is caught
   the same way — no separate size-vs-offset liveness hedge is needed, since the
   file's mtime already IS the disk-truth signal `last_seen_at` folds in. (Comparing
   size against the stored `offset` still happens on this same pass, but only to
   decide whether to pay for a tail read — never as a liveness input; a transcript
   stuck with an unterminated final line satisfies `size > offset` forever, and must
   still settle once its mtime stops advancing.) Beyond 24h a run is final.
4. **Orphan** = display state, computed at read time, never persisted as a status:
   `no manifest AND now - last_seen_at > WF_QUIET_MS`, **or** the owning session row
   is `ended`. Self-healing — if files move again the run flips back to running.
   1 of the 20 observed run dirs had no manifest, and a hard-killed CLI never writes
   one, so without this it would read "running" forever.
5. **PID registry rejected** (C8). mtime is strictly better and costs nothing.

`last_seen_at` is **the blend**:

```
last_seen_at = max(run dir mtime, journal.jsonl mtime, every agent-*.jsonl mtime)
```

— as of the last tick that looked *properly*, not "the tick that last looked". It
only advances when the disk does; never a fabricated `now` reading, on growth or
otherwise, or rules 2 and 4 could never fire.

**That one number is also the full-pass trigger.** A run gets a full pass when its
blend exceeds the persisted value, **or** an agent file's size exceeds its stored
`offset`, **or** the manifest is newly present / newly rewritten (`manifest_mtime`,
below). Nothing else. In particular the trigger must **not** be the raw dir mtime:
an ordinary long-running workflow's dir is touched once, at creation, and never
again, so a journal append — or a transcript append — would be invisible, and every
agent the journal records before its transcript exists would never be ingested.

Every full pass persists `last_seen_at` = that same blend. **The quiet path — the
cheap re-stat that early-returns — persists nothing at all**, and needs no rule to
say so: "quiet" now *means* the blend did not advance, so there is by construction
nothing new to write.

`manifest_seen` is **sticky and always read from the persisted row**. This pass's
parse result (`!!manifest`) says only whether the manifest was readable *this
second*; it must never feed state derivation, at run level or agent level. A
manifest that parsed once and then becomes unreadable (permissions, a half-replaced
file) leaves the run **settled** — it logs once under a `:manifest-read` key,
degrades the counter once, and changes nothing else. Treating that momentary `null`
as "no manifest" would flip the run settled → orphaned → settled on alternating
ticks and, because an orphan is never "settled", would also bypass the early return
forever.

The manifest lives **outside** the run dir, so neither its arrival nor an in-place
rewrite moves the run dir's mtime. `manifest_mtime` — the manifest's mtime as of the
last parse (§2) — carries that signal instead: `manifestMtime > manifest_mtime` is a
re-parse trigger alongside "the blend advanced", "an agent file grew" and "manifest
newly present", and the stored value is refreshed on every parse. That is what catches
C6's rewrite (`failed` at 09:27:58 → `completed` at 09:41:16, run dir untouched)
without overloading `last_seen_at`, whose definition stays exactly as above. A run
whose stored `manifest_mtime` is NULL while a manifest exists re-parses once and
then converges.

```ts
deriveRunState(
  run: { manifest_seen: boolean; status: string | null; last_seen_at: number | null;
         session_status: string },
  now: number
): "running" | "settled" | "orphaned"
```

Pure, no I/O, no agent argument — everything it needs is on `run`. Unit-tested
directly (§6). The scanner supplies `session_status` from the `sessions` row; the
file-growth hedge in rule 3 lives in the scanner, not here, because it needs `statSync`.

### 1.5 Cost tailing — `takeUsage()` refactor

`tailUsage()` is refactored into a path-based core that both callers share:

```ts
export function takeUsage(store: Store, t: {
  path: string; offset: number; sessionId: string;
  runId?: string; agentId?: string;
}): { offset: number; recorded: boolean }
```

- **`statSync` short-circuit:** `size === offset` ⇒ return immediately, no read. With
  multi-megabyte agent transcripts polled at 5s (C12: largest observed 6.3MB) this is
  the difference between idle and re-reading tens of MB a minute. The existing session
  path gets the same win for free.
- Reads from `offset` positionally rather than `readFileSync`-then-slice.
- `offset < 0` or `offset > size` ⇒ reset to 0 and re-read, preserving `tailUsage()`'s
  existing shrink/rotate handling. Returns the byte offset of the last newline, so a
  partially-written final line is never consumed — also unchanged.
- Persistence stays with the caller: sessions write `sessions.usage_offset`,
  workflow agents write `workflow_agents.offset`. `tailUsage(store, session)` remains
  as a thin wrapper over `takeUsage` that does that write, so `src/server/http.ts`
  and the 60s sweep in `src/server/index.ts` need no change.
- **`sessionId` is the PARENT session id** (C3). This is the keystone: `recordUsage`'s
  existing subquery stamps `project`/`branch` from the `sessions` row, so every cost
  aggregation is correct with no query change and no git call. All 3 parent sessions
  owning runs exist in `sessions` with project **and** branch, so the backfill
  produces **no `unknown` bucket** today (the fallback in §1.1 covers the case where a
  future session row is missing).
- `runId`/`agentId` are passed straight through into the new nullable `usage` columns.
- **Double-count guard on the parent path.** The session wrapper passes
  `skipSidechain: true`, so a parent-transcript line carrying `isSidechain: true`
  **or** an `agentId` field is skipped and never priced. Today this is a **no-op** —
  0 such lines exist in any parent transcript on this machine (verified) — but it
  neutralises the one failure mode `message_uuid` cannot: Claude Code folding agent
  lines into the parent transcript under fresh uuids (accepted risk 6). The workflow
  path deliberately does **not** set the flag: *every* agent transcript line carries
  `isSidechain: true` (C3), so skipping there would ingest nothing.
- Idempotent via `message_uuid` PK + `INSERT OR IGNORE`, with zero overlap against
  parent transcripts (C4). A restart mid-backfill cannot double-apply.

---

## 2. Data model

Added to `migrate()` in `src/server/db.ts`, following the existing
`CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` idempotent-ALTER pattern.

```sql
CREATE TABLE IF NOT EXISTS workflow_runs (
  run_id                TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL,
  project               TEXT,
  branch                TEXT,
  name                  TEXT,
  summary               TEXT,
  status                TEXT,            -- RAW passthrough, never an enum
  error                 TEXT,            -- our parse-failure reason; NULL when schema_ok = 1
  started_at            INTEGER,         -- manifest.startTime (epoch ms); before a manifest
                                         -- exists, run dir birthtimeMs (verified non-zero here,
                                         -- ~42s early on a sample), falling back to mtimeMs
  ended_at              INTEGER,         -- Date.parse(manifest.timestamp); NULL until terminal
  duration_ms           INTEGER,
  agent_count           INTEGER,
  phases                TEXT,            -- JSON [{title, detail}], 1-based by position
  cc_version            TEXT,            -- `version` from the first agent transcript line
  manifest_seen         INTEGER NOT NULL DEFAULT 0,
  manifest_mtime        INTEGER,         -- manifest mtime as of the last parse; an
                                         -- in-place rewrite (C6) advances it and is
                                         -- a re-parse trigger (§1.4)
  last_seen_at          INTEGER,
  dir                   TEXT NOT NULL,
  schema_ok             INTEGER NOT NULL DEFAULT 1,
  total_tokens_reported INTEGER
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_started ON workflow_runs(started_at);

CREATE TABLE IF NOT EXISTS workflow_agents (
  run_id            TEXT NOT NULL,
  agent_id          TEXT NOT NULL,
  label             TEXT,            -- manifest only; NULL on a live run
  phase_index       INTEGER,         -- 1-based, verbatim from the manifest
  phase_title       TEXT,
  idx               INTEGER,         -- 1-based, run-global ordering
  model             TEXT,
  state             TEXT,
  attempt           INTEGER,
  journal_key       TEXT,            -- opaque v2:<sha256>; grouping only, never rendered
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

Plus two idempotent ALTERs on `usage` and one index:

```sql
ALTER TABLE usage ADD COLUMN run_id TEXT;     -- guarded by PRAGMA table_info(usage)
ALTER TABLE usage ADD COLUMN agent_id TEXT;
CREATE INDEX IF NOT EXISTS idx_usage_run ON usage(run_id);
```

**Decisions embedded in this schema:**

- **No `FOREIGN KEY`s**, even though `PRAGMA foreign_keys = ON`. `usage.session_id`
  and `events.session_id` already carry none; matching that prevents backfill inserts
  from failing against purged sessions.
- **Not stored:** `script` (5.5KB), `args` (8.4KB), `logs`, `result` (an object of
  `{files, keyFacts, risks, summary}`), `resultPreview`. Bulk we would never render,
  containing work content.
- **Not stored: per-agent tokens or cost.** Both are derived, reusing the `TOKEN_SUM`
  SQL fragment already defined at the top of `src/server/store.ts` (every existing
  cost query interpolates it as `SUM${TOKEN_SUM}`):

  ```sql
  SELECT run_id, agent_id, SUM(cost_usd) AS cost, SUM(input_tokens + output_tokens +
         cache_read_tokens + cache_create_5m_tokens + cache_create_1h_tokens) AS tokens
  FROM usage WHERE run_id = $r GROUP BY run_id, agent_id
  ```

  One priced source of truth, no drift, and it works **live, before any manifest
  exists**. The manifest's unpriced `totalTokens` is kept only as
  `total_tokens_reported` for the cross-check in §5.
- **`error` is ours, not Claude Code's.** No manifest carries an error field. This
  column holds the one-line reason a parse degraded (`"manifest: unexpected token"`,
  `"manifest parsed 0 agents"`), written alongside `schema_ok = 0` and cleared on a
  clean re-parse. It is diagnostic text about *our* parser and never contains work
  content.
- `project`/`branch` on `workflow_runs` are stamped from the session row at first
  sight, matching `recordUsage`'s stamp-at-first-ingestion convention.
- `status` is `TEXT` with no CHECK constraint, deliberately (C11).

---

## 3. API and push

### 3.1 Live: a separate SSE event

**Workflows do NOT go in the `state` blob.** `buildState()` is already 243ms with
`toolStats()` at 232ms (C5); a 5s full-state tick would burn ~5% CPU permanently.
This discipline is the single most important non-obvious constraint in the design —
one careless `pushState()` in the fast tick regresses the whole dashboard.

`SseHub.broadcast(event, data)` already takes an event name and the client already
uses `es.addEventListener`, so this costs nothing new:

```ts
sse.broadcast("workflows", liveRuns);   // only when the serialized payload differs
```

`GET /api/stream` emits **both** on connect:

```ts
res.write(`event: state\ndata: ${JSON.stringify(buildState(store))}\n\n`);
res.write(`event: workflows\ndata: ${JSON.stringify(store.liveWorkflows())}\n\n`);
```

Payload — live/unsettled runs only (0–2 typical, ≤10 agents each):

```ts
interface LiveWorkflow {
  run_id: string; session_id: string; project: string; branch: string | null;
  name: string | null; status: string | null; state: "running" | "orphaned" | string;
  started_at: number | null; phase: { index: number; total: number; title: string } | null;
  schema_ok: boolean; costUsd: number; tokens: number;
  agents: { agent_id: string; label: string | null; model: string | null;
            state: string; attempt: number | null; last_tool: string | null;
            tokens: number; costUsd: number }[];
}
```

- `project` is `COALESCE(project, 'unknown')`, matching `costByProject` — the field is
  non-nullable in the payload even though the column is nullable.
- `phase.index` is the **1-based** `phaseIndex` verbatim and `phase.total` is
  `phases.length`, so `Phase ${index}/${total}` needs no arithmetic. `phase` is `null`
  whenever no manifest and no script skeleton is available (§4.1's copy case).
- `costUsd`/`tokens` at both levels come from the `usage` rollup (§2), never the
  manifest.

**Broadcast = payload diff, and nothing else.** Every tick, after the scan, the tick
computes `store.liveWorkflows(now)`, serializes it, and compares that string against
the last one broadcast (a single module-level value; production has one `Store` for
the process lifetime). It broadcasts — and updates the remembered string — **only
when the two differ**. The scanner's `changed` boolean is *not* the gate; it stays as
internal bookkeeping ("did this pass write anything durable") and nothing else keys
off it.

That is the whole contract, and it is deliberately the *only* one. Two earlier
attempts broadcast off signals *adjacent* to the payload — a remembered derived state
per run, an "un-settled" flag out of the scanner — and both failed the same way: the
signal and the payload were computed from different inputs, so they disagreed. One
flip-flopped every tick (19 identical-payload broadcasts measured over 20); the other
latched onto a false transition and masked the real one forever. Diffing the thing
actually being sent has nothing left to disagree with, and the two hard cases fall
out for free:

- An `ACTIVE → SETTLED` (or `running → orphaned`) flip caused **purely by the passage
  of time**, with nothing on disk moving, changes the payload — the state is derived
  at read time — so it broadcasts, with no separate transition cache.
- A transcript that grows every tick without changing cost or state does **not**
  change the payload, so it stays silent, however many full passes the disk motion
  legitimately forces.

The cost of this on a quiet tick is what makes it affordable: `liveWorkflows()`
applies the settled predicate **in SQL**, so a fully-settled system pays one query
that returns no rows (nothing is hydrated) plus a string compare. `buildState()`'s
243ms never comes near the 5s tick.

Two properties the payload **must** keep for the diff to be sound, both true today:
its serialization is stable (key order fixed by construction, row order by the
`ORDER BY` clauses), and **no field is derived from `now`** except the discrete
`state`. Elapsed/"running for" figures are computed client-side from `started_at`
(the board already re-renders at 1Hz via `useNow`). A clock-derived field in the
payload would make every tick a change and turn this into an unconditional 5s
broadcast.

`buildState()` gains exactly one **top-level** scalar: `workflows_degraded: number`
(§5) — a sibling of `sessions`/`todos`/`activity`/`stats`/`cost`, not nested inside
`cost`. No arrays, no joins — it must not get slower. The counter is in-memory and
process-lifetime; it resets on restart, which is the intended behaviour (a restart is
how you clear the banner after re-checking fixtures).

Client plumbing: `subscribe()` in `src/web/api.ts` currently registers a single
`state` listener and is the only `EventSource` consumer. It gains a second listener
and its signature becomes
`subscribe(handlers: { onState: (s: State) => void; onWorkflows?: (w: LiveWorkflow[]) => void })`.
Both call sites live in `App.tsx`.

### 3.2 History: pull

`GET /api/workflows?since=<ms>&until=<ms>&limit=100` → `{ runs: WorkflowRun[] }`,
where each run **embeds** its `agents[]` with usage rollups already joined in. One
endpoint, one round trip; 20 runs × ≤13 agents is trivial, and embedding removes the
per-row expand fetch and its loading state entirely.

- Follows the `/api/cost/daily` precedent exactly: optional epoch-ms params, malformed
  values ignored rather than 500, `json(res, 200, …)` helper. Reuse the same
  `num(v)` guard (`Number.isFinite` or `undefined`).
- `since`/`until` filter on **`workflow_runs.started_at`** — inclusive/exclusive
  respectively, matching `rangeClause()` in `store.ts`. Runs with a NULL `started_at`
  are excluded whenever either bound is given, included when neither is.
- `limit` caps **runs**, not agents; it is clamped to `1…500` and defaults to 100.
  Ordering is `started_at DESC` so the limit keeps the newest.
- **No pagination** (YAGNI on a personal machine).
- `GET /api/workflows/:runId` is **not** built. Add it only if the embed measurably
  bloats the response; default is no.
- `WorkflowRun` is the `workflow_runs` row (with `schema_ok` as a boolean and
  `phases` parsed back from JSON) plus `costUsd`, `tokens`, `state`, and `agents[]`.
  Each embedded agent is the `workflow_agents` row plus its `costUsd`/`tokens`
  rollup — the same agent shape `LiveWorkflow` uses, with the extra history-only
  fields (`phase_title`, `prompt_preview`, `last_tool_summary`, `duration_ms`).

Global cost panels keep their normal 60s cadence. Only the workflow strip is 5s-live.
This is an accepted, deliberate asymmetry.

---

## 4. UI

### 4.1 Board — `WorkflowsSection`

Rendered in `Board.tsx` **between `TodosSection` and the Sessions `Lane`** — todos
stay at the top of the board where they are today — and **only when at least one live
run exists**: zero vertical footprint on non-workflow days, which matters given the
recent commits fighting for board space (`911a538`, `0f71658`).

- Reuses the `max-h-[40vh] overflow-y-auto pr-1` + inner-scroll pattern from
  `TodosSection`, and `usePersistedToggle("am-workflows-collapsed")` for collapse.
- Live data arrives on the `workflows` SSE event, held in `App.tsx` state **separate
  from** `State` — it is not part of the state blob. `App.tsx` passes it to `Board`
  as a second prop (`<Board state={state} workflows={workflows} />`), and `Board`
  forwards it to both `WorkflowsSection` and `AppBar`. `AppBar` cannot read it from
  `state`, so it gains a `workflows` prop of its own; existing `AppBar` tests that
  render it with only `state` must keep passing, so the prop is optional and
  defaults to `[]`.

`WorkflowRunCard` shows:

- Workflow name (fallback: the run id), project/branch chip.
- Elapsed time, ticking via the existing `useNow()` 1Hz hook.
- Phase pill — `Phase 2/4 · Judge` when the manifest or script skeleton is known;
  otherwise the explicit copy **"phases resolve on completion"**. This is not a bug
  to be engineered away: the manifest is written exactly once at terminal state, so
  a live run genuinely has no label→phase mapping unless the script file exists.
  Saying so is the fix. Expect this copy on the runs with no script at all — 18 of
  20 resolve one once §1.3's cross-slug fallback is counted, 2 never will (C9).
- Agent chips: `label` when known, `agentId` fallback (which is the common live case,
  since labels exist only in the manifest); state dot (running / done / abandoned),
  model via `prettyModel()` from `src/web/cost.ts`, ticking tokens.
- Live cost via `formatUsd`, tokens via `formatTokens` — both from `src/web/cost.ts`.
- Collapsible per-agent rows (`usePersistedToggle` keyed `am-wf-<run_id>`).

`SessionCard` gains a small **`wf`** badge when that session owns a live run, so the
flat session model still reads correctly. It takes a `wf?: boolean` prop — `Board`
computes the owning-session set once per render
(`new Set(workflows.map(w => w.session_id))`) rather than passing the array down.
Optional and defaulting to `false`, so `web-tests/SessionCard.test.tsx` keeps passing
untouched.

### 4.2 `#/workflows` page

Cloned from `CostDailyPage.tsx` — same standalone shell (its own sticky header with a
`← Dashboard` link; `AppBar` is not rendered on this page, exactly as on `#/cost`),
same window picker (`7 / 14 / 30 / all` via `costDailyRange`, default `14`), same
sortable-table mechanics, same loading/error/empty states.

Columns, each mapping to one field:

| Column | Source | Sort |
|---|---|---|
| When | `started_at` | numeric, default **desc** |
| Workflow | `name ?? run_id` | text |
| Project/Branch | `project` + `branch ?? "—"` | text on `project` |
| Status | `status ?? state` | text |
| Duration | `duration_ms` | numeric |
| Agents | `agents.length` | numeric |
| Tokens | rollup `tokens` | numeric |
| Cost | rollup `costUsd` | numeric |

Plus a **totals row** summing Agents / Tokens / Cost over the rendered rows. Row click
expands an inline panel grouping agents under their phases (by `phase_index`, titled
from `phase_title`; agents with a NULL `phase_index` group last under "unphased"):
label, model, state, attempt, duration, tokens, cost, last tool
(`last_tool_summary`). Unknown statuses render grey.

Routing: `App.tsx`'s existing ternary becomes a small switch —
`#/cost → CostDailyPage`, `#/workflows → WorkflowsPage`, else `Board`. `AppBar` gains
a "Workflows" link next to "Cost", with a live-count badge (`workflows.length`,
hidden at zero) fed by the `workflows` prop threaded in §4.1.

---

## 5. Resilience

Everything except the transcript line format is undocumented and can change on any
Claude Code release. The strategy is **to split the feature by fragility so the
valuable half degrades last**.

**Cost ingestion depends on exactly three things:** the run-dir path convention
(`<sessionDir>/subagents/workflows/wf_*`, held by 20 of 20 runs — C9), the
`agent-*.jsonl` filename convention, and the `message.usage` line shape. That last
one is *shared with normal session tracking* — if it breaks, existing cost tracking
is equally broken. This introduces **no new fragility class**. The $1,124 rests on
the least breakable thing on disk.

Note what is *not* on that list: the manifest, the journal, the script file, the
meta file, `workflowProgress`, and every field name in them. All of those feed
structure only. This is the split the rest of this section is defending.

**Structure is the degradable half.** Concretely:

1. Tolerant field-by-field getters everywhere; **never destructure** a parsed object.
2. `workflowProgress` filtered by `e?.type === "workflow_agent"`.
3. Unknown journal line types ignored, not thrown on.
4. Unknown status strings stored raw and rendered grey. No enum that would reject a
   future value.
5. Every parse in `try/catch` yielding a **partial row** (the `toolStats()`
   precedent). Parse failures logged **once per run**, not per tick: `logOnce(key,
   err)` returns `true` only on the pass that actually logged, and every
   `bumpDegraded()` is gated on that boolean, so the degraded counter is
   once-per-run-per-cause too — a run whose manifest has been unparseable for an
   hour counts **1**, not 720.
6. `schema_ok = 0` and a **"structure unavailable"** badge when a manifest parses to
   zero agents while transcripts exist — the run still renders with transcript-derived
   tokens, cost and raw agentIds.
7. `cc_version` recorded per run from the `version` field on the first agent
   transcript line (2.1.226 on recent runs, 2.1.220 on older — C11). The UI surfaces
   "format last verified on \<version\>" against the newest run's value, so fixtures
   get re-checked after an upgrade.
8. **Cross-check — presence, not proportion.** Compare `total_tokens_reported`
   against the `usage` token rollup for that `run_id`, evaluated once per run when it
   is **both** `manifest_seen = 1` **and** settled (never while ACTIVE, where the
   manifest total is legitimately ahead of what has been tailed), and skipped when
   `total_tokens_reported` is NULL or 0. Because the disk-motion trigger of §1.4 is
   false by definition on the tick a run goes quiet, a run watched from ACTIVE gets
   **one forced full pass** when it first reads settled — and that shot is **spent on
   that one attempt whatever it finds**. If the manifest turns out to be unreadable
   the check is skipped, logged once and counted once toward `workflows_degraded`;
   it is a best-effort diagnostic, and re-forcing a pass every 5s forever waiting for
   a manifest that may never become readable is a worse failure than not running it.
   Uses the §2 `TOKEN_SUM` expression:

   ```sql
   SELECT SUM(input_tokens + output_tokens + cache_read_tokens +
              cache_create_5m_tokens + cache_create_1h_tokens) FROM usage WHERE run_id = $r
   ```

   **Flag when the rollup is 0 while `total_tokens_reported > 0`** — that is the
   silently-wrong-cost failure this check exists for: Claude Code says the run burned
   tokens and we ingested none.

   **A percentage-divergence threshold was designed in and then removed: the two
   numbers do not measure the same thing.** Measured across all 19 manifests, the
   rollup / reported ratio spans **24x to 276x** (median ≈ 94x), and
   `input+output` alone / reported spans **0.06x to 0.43x**. `totalTokens` appears to
   be a per-agent context figure, not a sum over messages — it is not a lower bound,
   an upper bound, or a fixed multiple of anything we compute. Any percentage gate
   would fire on 19 of 19 healthy runs and be muted within a day.

   Note what this costs: the presence check does **not** detect double-counting.
   That risk is carried instead by three things: `message_uuid` (a re-emitted
   sidechain line with the *same* uuid is dropped by `INSERT OR IGNORE`), C4's
   measured zero overlap, and the parent-path marker skip in §1.5 (a parent line
   carrying `isSidechain: true` or an `agentId` is never priced). What remains
   invisible is a fold carrying **neither marker** under a fresh uuid — see
   accepted risk 6.
9. `workflows_degraded` counter (parse failures + unknown line types + zero-agent
   manifests), each counted **once per run per cause** via §5.5's `logOnce` gate,
   exposed as a scalar in `buildState()`; the board shows *"workflow data looks off
   — Claude Code may have changed format"* when it is non-zero.
10. `AM_WORKFLOWS=0` kill switch. **Read-only on `~/.claude` always** — never write,
    never delete.

---

## 6. Testing

Mirrors the repo convention: pure logic in `tests/` (bun), components in
`web-tests/` (vitest + testing-library).

**`tests/workflows.test.ts`** — new, against fixtures **copied from a handful of the
real runs** with `script` / `args` / `result` / `resultPreview` stripped (they contain
work content). Fixtures live in `tests/fixtures/workflows/` and are **frozen copies**:
capture them once, then assert against the copies. Never assert against a path under
`~/.claude` — those files keep moving (`wf_de7ba892-786` was 1-started/0-result while
this spec was being written and is 2-started/1-result now).

- `sessionDirFor` — strips `.jsonl`, exact against real paths.
- `parseManifest` — the real ~50KB manifest; a **truncated** one; one with
  `workflowProgress` deleted (⇒ status/duration survive, `schema_ok=0`); one with an
  unknown `status` string (⇒ stored verbatim); mixed `workflowProgress` (⇒
  `workflow_phase` entries filtered out); assert `phaseIndex` / `index` survive
  **1-based**.
- `parseJournal` — **the 6-started / 3-result / 6-key journal from `wf_eb7bf7e8-8a5`**:
  with a manifest present assert 6 agents, none `running`; with the manifest absent
  assert 3 `running`. **The 13-started / 10-result / 10-key journal from
  `wf_57b2617f-124`**: assert 10 winning agents + 3 `abandoned`, last agentId per key
  in file order wins. A manifest-less live journal with one unmatched `started`
  (captured from `wf_de7ba892-786`) ⇒ that key is `running`.
- Agent-set union — a fixture run dir whose `agent-*.jsonl` files outnumber the
  manifest's `workflowProgress` entries (13 vs 10, from `wf_57b2617f-124`) yields
  **13** `workflow_agents` rows, not 10.
- `deriveRunState` — manifest present + recent mtime ⇒ still ACTIVE (C6 regression
  test); no manifest + quiet > `WF_QUIET_MS` ⇒ `orphaned`; owning session `ended` ⇒
  `orphaned`; mtime advances after settle ⇒ un-settled.
- Scanner (`scanWorkflows`, against a temp dir, not `~/.claude`) — agent file grows
  without a dir-mtime change ⇒ un-settled (rule 3's hedge); a settled run older than
  `WF_RECHECK_MS` is not re-stat'd; a tick with nothing unsettled reports
  `changed: false`.

**`tests/pricing.test.ts`** — **amend, not just extend.** Three existing assertions
encode the old aliases and will fail after §0a; updating them is part of step 1, not
an accident:

- `canonicalModel("opus")` → `"claude-opus-5"` (was `"claude-opus-4-8"`).
- `canonicalModel("sonnet")` → `"claude-sonnet-5"` (was `"claude-sonnet-4-6"`).
- `costOf("opus", …)`/`costOf("sonnet", …)` keep their current *values* (5/25 and
  3/15 are unchanged between tiers) — assert they stay non-zero rather than deleting
  the case.
- `canonicalModel("haiku")` → `"claude-haiku-4-5"` **unchanged**, plus a new
  regression asserting `costOf("haiku", 1M input) === 1` so nobody "finishes the job"
  by re-pointing it.
- New: `costOf("claude-opus-5", …)` and `costOf("claude-sonnet-5", …)` are non-zero.

**`tests/usage.test.ts`** — extend: `takeUsage` `size === offset` short-circuit does
no read; `run_id`/`agent_id` land on the row; parent-`sessionId` attribution stamps
project/branch; re-running is idempotent; **the §1.5 double-count guard** — a
synthetic parent transcript holding one ordinary line, one `isSidechain: true` line
and one line carrying `agentId` records **only the ordinary line**, while the same
marked line ingested through the workflow path (`runId`/`agentId` given) still
records; the existing `tailUsage` tests must pass **unchanged** through the new
wrapper (that is the refactor's safety net).

**`tests/cost-store.test.ts`** — extend (this is where usage-rollup tests live by
repo convention, not `store.test.ts`): per-agent `costUsd`/`tokens` rollup from
`usage` by `run_id`/`agent_id`; `workflowHistory` range filter on `started_at`;
`liveWorkflows` shape.

**`tests/store.test.ts`** — extend: `upsertWorkflowRun`/`upsertWorkflowAgent`
idempotency, and the idempotent-migration cases matching the existing
"idempotently adds …" tests (`workflow_runs`/`workflow_agents` created on a
pre-existing DB; `usage.run_id`/`agent_id` added to a pre-existing `usage` table).

**`tests/http.test.ts`** — extend: `GET /api/workflows` shape and range params;
malformed params ignored; `/api/stream` emits **both** `state` and `workflows` on
connect; the `state` blob does **not** contain a workflows array.

**`web-tests/WorkflowsPage.test.tsx`** and **`web-tests/WorkflowRunCard.test.tsx`** —
modeled directly on `CostDailyPage.test.tsx` (mocked `fetch`): renders rows, sort
toggle reorders, window change refetches, empty and error states, row-expand shows
per-agent rows; card renders "phases resolve on completion" when phases are absent,
falls back to `agentId` when `label` is null, and renders an unknown status greyed.

**`web-tests/Board.test.tsx`** — extend: no `WorkflowsSection` in the DOM when there
are zero live runs.

---

## 7. Ship order

Four branches, one merge each, matching the repo's merge-per-fix history. Every step
is independently useful and revertable.

| # | Branch | Delivers | Gate |
|---|--------|----------|------|
| 1 | `fix/pricing-rates-5-series` | `RATES` entries for opus-5/sonnet-5, `opus`/`sonnet` alias re-point (**not** `haiku`), and the delete-and-reingest repricing routine **including its own re-tail of the owning ended sessions** (§0b). | `tests/pricing.test.ts` amended and green; `#/cost` shows non-zero opus-5 spend and the row count is back to ~1,985. |
| 2 | `feat/workflow-cost-ingestion` | **The whole §2 migration** — `workflow_runs`, `workflow_agents`, `usage.run_id`/`agent_id`, indexes — plus the `takeUsage()` refactor, cost-only workflow scan, and one-time startup backfill. **No API, no UI.** | ~$1,124 appears in cost views, attributed to real projects/branches, no `unknown` bucket. |
| 3 | `feat/workflows-history` | Store read queries (`workflowHistory`, rollups), `GET /api/workflows`, `#/workflows` page, AppBar link. | History page lists every completed run with phases and per-agent drill-down. |
| 4 | `feat/workflows-live` | `workflows` SSE event, 5s ticker, `liveWorkflows()`, `api.ts` `subscribe()` change, `WorkflowsSection` board strip, `wf` badge on `SessionCard`, `workflows_degraded` in `buildState()`. | A live run appears within 5s and its tokens tick. |

**Both tables ship in step 2, not step 3.** A cost-only scan has to persist a
per-agent byte offset somewhere, and that somewhere is `workflow_agents.offset`;
`workflow_runs` comes along because the scanner needs `manifest_seen` / `last_seen_at`
to know what to tail. Step 3 adds no DDL — only read queries and presentation. Writing
the structural columns in step 2 is free (the scanner is already parsing) and means
step 3 has history to render the day it lands.

**Step 2 announcement:** ~$1,124 of spend lands on **past** days. Prior days on
`#/cost` will jump noticeably. Correct, but jarring — say so in the commit message.
Step 1 does the same thing on a smaller scale.

**Restart gotcha (from project memory):** `buildState()` gains
`workflows_degraded` in step 4. Restart `am-server.service` in the **same step** as
the web rebuild, and make the new web consumer tolerate the field being missing —
the server-restart-on-rebuild skew has bitten this repo before. Type it as
`workflows_degraded?: number` in `src/web/types.ts` and read it as `?? 0`.

---

## Accepted risks

These are known, priced, and accepted — not oversights.

1. **Semantic drift is undetectable by parsing.** If Claude Code keeps the JSON shape
   but changes meaning (writing a `result` for abandoned steps, reusing a `key` across
   logical steps), agent states go quietly wrong. The recorded `cc_version` is the
   only mitigation. Residual risk real.
2. **The live view is structurally poorer than history, by construction.** No amount
   of engineering fixes this without Claude Code emitting live structure. The UI says
   so explicitly instead of pretending.
3. **Post-24h resumes leak tokens.** `WF_RECHECK_MS` bounds the re-stat window. A run
   resumed more than a day after settling is missed. Judged not worth an unbounded
   re-scan.
4. **Orphan false positives on genuinely slow agents.** A 10-minute single tool call
   is mislabeled `orphaned` until writes resume. Self-healing, and the threshold trades
   against how long a hard-killed run lingers as "running".
5. **`toolStats()` at 232ms remains unfixed.** This feature routes around it rather
   than fixing it. Memoizing `toolStats` separately is the obvious follow-up and is
   explicitly out of scope here.
6. **A marker-less fold would still be invisible.** If Claude Code ever folds
   sidechain lines into the parent transcript under *new* uuids, `INSERT OR IGNORE`
   would not dedupe them. §1.5's guard covers the realistic shape of that change —
   parent tailing skips any line carrying `isSidechain: true` or an `agentId`, which
   is how every sidechain line is marked today (C3) — and it costs nothing, because
   0 lines in any parent transcript here carry either marker. **Residual, accepted:**
   a fold that drops *both* markers *and* uses fresh uuids would be counted twice,
   and no check in §5 would notice, because the manifest's `totalTokens` is not
   comparable to our rollup (§5.8). C4's measured zero overlap is the current
   evidence this is not happening; there is no ongoing detector for that case.
7. **Phase titles are still missing on some live runs.** Only 15 of 20 runs have a
   script under their own session dir (C9); §1.3's once-per-run cross-slug fallback
   lifts that to 18 of 20. The remaining 2 have no script anywhere and show
   *"phases resolve on completion"* for their whole live life, and a sibling-slug
   script written *after* the run is discovered is missed too, since the fallback
   never re-runs. Accepted: the alternative is paying for a cross-slug scan on every
   5s tick.
8. **Runs whose owning session was purged bucket under `unknown`.** Not observed
   today; the alternative — dropping their spend — is worse (§1.1).
