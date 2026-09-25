# Multi-harness visibility, cost correctness, workflow fidelity, and server performance

Date: 2026-09-25.
Branch: `feat/multi-harness-and-fixes`.
Research reports backing every claim here: `wf_9191c893-074` (codex, cursor, claude-wf, ui, arch).

## 0. Goals

1. Show every coding agent that runs on this machine, not only Claude Code: Codex CLI and Cursor CLI sessions, Claude Task subagents, workflow agents, and which session spawned which.
2. Every number on screen is correct or explicitly marked as unknown.
   Never render an unknown as `$0.00`.
3. The server stays responsive under heavy hook traffic (many parallel agents).
4. Workflows render faithfully live and in history, against Claude Code 2.1.265+ formats.
5. Usability fixes from the UI audit.

Non-goals: token/cost for Cursor (Cursor never writes usage to disk; hooks do not carry it).
Codex native sub-agent rollouts (zero organic samples locally) are out of scope; documented as a known gap.

## 1. Server performance and the events table (workstream A1)

### 1.1 Coalesced broadcasts

- Replace every direct `pushState()` (http.ts POST /events, todo CRUD, MCP `onChange`, the 60s sweep) with `scheduleState()`: a trailing-edge throttle.
  If no broadcast happened in the last `STATE_THROTTLE_MS` (1000), broadcast on the next macrotask (`setTimeout 0`) so a single event still feels instant; otherwise schedule exactly one broadcast at `lastBroadcast + STATE_THROTTLE_MS`.
  Multiple calls inside a window collapse to one.
- Implement it as a small reusable `createThrottle(fn, ms, clock?)` in `src/server/throttle.ts` with fake-timer-friendly tests.
- `GET /api/state` stays synchronous but must be cheap (see 1.2, 1.3).

### 1.2 Events: real columns, valid JSON, incremental tool stats

- Migration adds to `events`: `tool_name TEXT`, `duration_ms REAL`, `agent_id TEXT`, `harness TEXT`.
  Index `idx_events_type_id ON events(type, id)` for the recent-activity query.
- At ingest, extract `tool_name`, `duration_ms` (if numeric), `agent_id` (payload `agent_id`), and harness into the columns.
- Payload storage: never slice raw JSON.
  Build a compacted object: drop `tool_response`, `tool_output`, `output`, `content` (Cursor `beforeReadFile`), `last_assistant_message`, `edits`; truncate every remaining string value longer than 2000 chars (recursively, depth-limited) with a trailing `…`; then `JSON.stringify`.
  If still over 8000 chars, keep only `{session_id, cwd, tool_name, tool_input: <summary string>, hook_event_name}`.
  The stored payload is always valid JSON.
- New table `tool_stats(harness TEXT NOT NULL, tool TEXT NOT NULL, calls INTEGER NOT NULL, timed INTEGER NOT NULL, total_ms REAL NOT NULL, PRIMARY KEY(harness, tool))`, upserted on every `activity` insert inside the same transaction.
- One-time backfill (guarded by `app_meta` key `events_columns_v1`): populate the new columns for historic rows (`json_extract` for valid rows, regex `"tool_name":"([^"]+)"` and `"agent_id":"([^"]+)"` for truncated invalid rows; harness `cursor` when payload contains `"cursor_version"`, else `claude`), then rebuild `tool_stats` from `events` in one `INSERT ... SELECT ... GROUP BY`.
- `toolStats()` reads `tool_stats` (sum over harness per tool, plus per-harness breakdown) and must be under 5 ms.
- `recentActivity(limit)` reads columns first and parses payload only for the detail summary; rows whose payload fails to parse still appear (tool from the column).
  It also returns `agent_id`, `harness` and, when the agent is a known workflow agent or Task subagent, its label.

### 1.3 Cached cost aggregates

- `Store` keeps a `usageVersion` counter bumped by every usage write (record, upsert, reprice, migration).
  `costByProject()`, `costByBranch()` and `costSummary()`'s all-time parts are memoized on `usageVersion` (and on the day start for "today").
  `buildState()` must take under 50 ms on a copy of the production DB (918 MB) when nothing changed, measured by a script in the plan.

### 1.4 Retention and backup

- Before the first run of any destructive migration in this spec (usage dedupe 2.2, events prune), copy the DB with `VACUUM INTO '<dir>/am-pre-multiharness-YYYYMMDD.sqlite'` once (guarded by `app_meta` key `backup_multiharness_done`), and log the path.
- Retention: hourly, delete `events` rows older than 30 days (all types; `tool_stats` keeps the aggregate).
  After the first prune, run a one-time `VACUUM` (guarded by `app_meta` key `events_vacuum_v1`) off the request path at startup.

### 1.5 Git resolution

- `resolveRepoInfo(cwd)` results are cached per cwd for 30 s.
- A git failure or timeout never downgrades a session whose project was already resolved from git: keep the previous project/branch.
  Only a brand-new session may fall back to the basename.
- Only main-agent events (no `agent_id` in payload) may change a session's `project`, `branch`, `cwd`, `status` or `attention_reason`.
  Subagent events still update `last_activity_at` and are stored as activity.

### 1.6 Session lifecycle

- `needs_you` sessions are exempt from the 30-minute dead sweep; they retire only after 24 h of silence (`NEEDS_YOU_DEAD_MS`).
- `idle` sessions carry an `idle_reason`: `stopped` (a stop event) or `quiet` (swept by `STALE_MS`).
  Add column `sessions.idle_reason TEXT`; the state payload exposes it.

## 2. Cost correctness (workstream A2)

### 2.1 Pricing table

Rates in USD per million tokens, per model, all five fields explicit (no global multipliers):

| canonical id | input | output | cache read | cache write 5m | cache write 1h |
|---|---|---|---|---|---|
| claude-fable-5-1 | 10 | 50 | 0.25 | 12.5 | 20 |
| claude-fable-5 | 10 | 50 | 1 | 12.5 | 20 |
| claude-mythos-5 | 10 | 50 | 1 | 12.5 | 20 |
| claude-opus-5-5 | 4 | 20 | 0.2 | 5 | 8 |
| claude-opus-5, -4-8, -4-7, -4-6, -4-5 | 5 | 25 | 0.5 | 6.25 | 10 |
| claude-sonnet-5 | 2 | 10 | 0.2 | 2.5 | 4 |
| claude-sonnet-4-6, -4-5 | 3 | 15 | 0.3 | 3.75 | 6 |
| claude-haiku-4-5 | 1 | 5 | 0.1 | 1.25 | 2 |
| gpt-5.5 | 5 | 30 | 0.5 | 0 | 0 |
| gpt-5.3-codex | 1.75 | 14 | 0.175 | 0 | 0 |

- `canonicalModel()` strips a trailing `[...]` suffix (`claude-opus-5-5[1m]`) and `-YYYYMMDD`, and maps bare aliases.
  `FAMILY_ALIAS.fable` becomes `claude-fable-5-1`; `opus` stays `claude-opus-5` (ambiguous, display-only fallback).
- `costOf()` returns `number | null`; `null` means unpriced.
  Unknown models log once, as today.
- `<synthetic>` usage lines are skipped before recording (no row, no warning).
- Export `RATES_VERSION`: a stable hash (e.g. FNV-1a of the sorted JSON of the rate table).

### 2.2 Usage deduplication per API message

- Claude Code writes one JSONL line per content block and repeats `message.usage` on each; the input and cache fields are identical, `output_tokens` grows (first line is a partial streaming count).
- Add `usage.message_key TEXT` with a UNIQUE index (partial: `WHERE message_key IS NOT NULL`).
  For Claude lines, `message_key = message.id + ":" + (requestId ?? "")`.
- `recordUsage` becomes an upsert on `message_key`: on conflict set `output_tokens = MAX(old, new)` and recompute `cost_usd`; keep the first row's `message_uuid`, `at`, attribution.
  Lines without `message.id` keep the old behaviour keyed by `message_uuid`.
- One-time migration (after the 1.4 backup; `app_meta` key `usage_dedupe_v1`): collapse historic rows on `(session_id, coalesce(agent_id,''), model, input_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens)` keeping the row with the smallest `at` and setting its `output_tokens` to the group MAX; delete the rest.
  The research validated this key: 30,296 groups vs 30,295 real message ids (2 collisions) on the 67k rows still on disk.
- Log before/after row counts and totals.

### 2.3 Generic repricing

- `usage.cost_usd` becomes nullable (SQLite: recreate not needed; new rows may write NULL because the column was `NOT NULL`: migrate by table rebuild inside a transaction, preserving all columns and indexes).
- At startup, if `app_meta.rates_version != RATES_VERSION`, recompute `cost_usd` for every row from its stored tokens and model in one transaction, then store the new version.
  This replaces `reprice.ts`'s hardcoded 5-series one-shot (delete that module, its marker handling and `AM_REPRICE`; keep its test intent as a generic-reprice test).
- Aggregations: `SUM(cost_usd)` ignores NULL; each aggregate also returns `unpricedTokens` (sum of all token fields where `cost_usd IS NULL`) and `unpricedModels`.
- Remove `HAVING c > 0` from the per-model breakdown; unpriced models appear with `costUsd: null`.

### 2.4 Task subagents (non-workflow)

- Files: `<sessionDir>/subagents/agent-<id>.jsonl` and `agent-<id>.meta.json` (`agentType`, `description`, `model`, `toolUseId`, `parentAgentId`, `spawnDepth`), where `sessionDir = transcript_path minus .jsonl`.
  Exclude `subagents/workflows/`.
- New table `subagents(agent_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_type TEXT, description TEXT, model TEXT, parent_agent_id TEXT, path TEXT NOT NULL, offset INTEGER NOT NULL DEFAULT 0, started_at INTEGER, last_seen_at INTEGER)`.
- The 60 s sweep (and a startup backfill over every session with a transcript path, plus a glob of `CLAUDE_PROJECTS_DIR/*/*/subagents/agent-*.jsonl` for sessions no longer in the table) tails each file with `takeUsage` (`sessionId` = parent, `agentId` = file id, `runId` = null); offsets persist in `subagents.offset`.
  Subagent lines are sidechain; dedupe via `message_key` makes re-tails safe.
- `model` in the table is the resolved `message.model` from the transcript when seen, else the meta alias.

## 3. Workflow fidelity (workstream A3)

- `parseJournal`: accept `launched` (run started, no agent) and `failed` (agent state `error`).
  Read `label` and `phase` from `started` lines.
  Unknown types still count, but degraded bumps once per run per cause, never per line, and the warm-restart cross-check pass must not re-bump a cause already recorded for that run (persist the per-run degraded causes in a `workflow_runs.degraded` TEXT column so a restart does not re-count; the counter reported in state is the number of runs with a degraded cause first seen in the last 24 h).
- `parseAgentMeta`: read `description` as label and `workflowPhase` as phase title; map the phase title to `phase_index` through the run's known phases (script header or manifest).
  Label/phase precedence: manifest > journal `started` > meta.
- Re-read the agent transcript header while the stored model is null or a bare alias (`opus`, `sonnet`, `haiku`, `fable`, `mythos`), not only on first sight.
- Zero-agent manifests: `agentCount === 0` or a top-level `error` is a valid run (`schema_ok = 1`, no degraded bump).
  Persist manifest `error` into `workflow_runs.error` (prefer it over any parser note) and `defaultModel` into a new `default_model` column, `totalToolCalls` into `total_tool_calls`.
- Agent state normalisation at read time: `progress` or `running` agents in a run whose status is `killed` or `failed` become `killed`; manifest `error` state stays `error`.
  Persist per-agent `error` / `lastAttemptReason` into `workflow_agents.error` and `fallbackModel` into `fallback_model`.
- Live agent activity: hook events carrying `agent_id` that matches a `workflow_agents` row update `last_tool`, `last_tool_summary`, `tool_calls` (+1 per activity) and `started_at` (first seen), so live cards show real motion before the manifest lands.
- API: `GET /api/workflows` returns runs WITHOUT agents plus `agent_counts {total, done, error, running, abandoned}`, supports `?q=` (name/project substring) and `?limit=&offset=`, and returns `total`.
  New `GET /api/workflows/:runId` returns one run with agents.
  Running runs report `duration_ms = now - started_at`.
- Board presence: `liveWorkflows` payload additionally carries `last_run` (most recent settled run: name, status, ended_at, cost, run_id) so the board can show it when nothing is live.

## 4. Multi-harness ingestion (workstream B1)

### 4.1 Model

- `sessions` gains `harness TEXT NOT NULL DEFAULT 'claude'`, `model TEXT`, `title TEXT`, `parent_session_id TEXT`, `harness_version TEXT`.
  `usage` gains `harness TEXT` (NULL means claude for old rows).
- `Harness = "claude" | "codex" | "cursor"`, defined once in `src/shared/harness.ts` and imported by server and web (add `src/shared` to both tsconfigs).

### 4.2 Hook transport

- `am-hook.sh <type> [harness]` appends `&harness=<harness>` when given, and `&pcc=$CLAUDE_CODE_SESSION_ID&pcx=$CODEX_THREAD_ID` when those env vars are set (URL-encoded; they are UUID-like).
  It stays fire-and-forget and prints nothing (Cursor treats empty stdout as continue).
- Server harness detection, first match wins:
  1. payload has `cursor_version` or `transcript_path` under `~/.cursor/`: `cursor` (Cursor runs the hooks in `~/.claude/settings.json` through its Claude-compat layer; this is how 325 Cursor sessions already arrive).
  2. `transcript_path` under `~/.codex/`, or query `harness=codex`: `codex`.
  3. otherwise `claude`.
- Parent: the first of `pcc`, `pcx` that is non-empty and differs from the event's session id.
  Fallback: a cwd matching `/tmp/claude-<uid>/<slug>/<uuid>/scratchpad` gives `parent_session_id = <uuid>`.
  Parent is set once and never overwritten.

### 4.3 Per-harness normalisation (in `src/server/harness/<name>.ts`, pure functions, table-tested)

- Cursor: cwd from `cwd` if non-empty else `workspace_roots[0]`; `session_id` = `session_id ?? conversation_id`; model from `model`; `harness_version` from `cursor_version`; hook names arrive via the Claude-compat mapping (`sessionStart`, `preToolUse`, `postToolUse`, `sessionEnd`, and interactive `beforeSubmitPrompt`/`stop` via `UserPromptSubmit`/`Stop`); `postToolUse` duration field is `duration` (ms) and maps to `duration_ms`.
  Intent: Cursor headless mode fires no prompt event, so when a cursor session has no intent and a `transcript_path`, read the first `role:"user"` line of the transcript and extract the text inside `<user_query>…</user_query>` (else the first text block), truncated.
- Codex: payload is Claude-shaped; `model` on every event but SessionEnd; `harness_version` from the rollout `session_meta.cli_version` when tailing.
  Map `PermissionRequest` to `notification` with message "Codex is waiting for approval".
- Claude: `session_start` carries `model` and `session_title` (persist into `model`/`title`); `model` on other events updates `sessions.model`.

### 4.4 Codex usage

- Tail the rollout at `transcript_path` with a Codex parser in `src/server/harness/codex-usage.ts`:
  price `event_msg` `token_count` lines using `info.last_token_usage` (present in every version, per-call); skip lines with null `info`.
  `message_key = "codex:" + session_id + ":" + info.total_token_usage.total_tokens` (cumulative total strictly increases per call, so repeated token_count lines collapse).
  Tokens: `input = input_tokens - cached_input_tokens`, `cache_read = cached_input_tokens`, `output = output_tokens` (reasoning is already inside output), cache writes 0.
  Model: the latest `turn_context.payload.model` seen in the chunk, else `sessions.model`.
- The usage tail dispatches by `sessions.harness`: claude parser, codex parser, cursor none.
- Startup backfill: scan `~/.codex/sessions/**/rollout-*.jsonl`; for each, read `session_meta` (id, cwd, cli_version; skip `thread_source == "subagent"`), upsert an `ended` session row (harness codex, project/branch via git resolution of cwd with basename fallback, started/ended from first/last timestamps), and ingest usage.
  Idempotent via `message_key`; guarded per file by a stored offset in a new `harness_files(path PRIMARY KEY, session_id, offset, mtime)` table.

### 4.5 Legacy backfill

- One-time (`app_meta` key `harness_backfill_v1`): sessions with any event whose payload contains `"cursor_version"` become `harness='cursor'`, with `model` from the latest such payload, `cwd`/`project` recomputed from `workspace_roots[0]` when the stored project is `unknown`, and `parent_session_id` from the scratchpad cwd pattern.
- Usage rows with `project = 'main'`: re-resolve from the session's cwd via git; update when git gives a different project.

### 4.6 Setup

- `bun run setup` additionally, when `~/.codex` exists: merge hook entries into `~/.codex/hooks.json` (backup to `hooks.json.am-backup`, preserve foreign entries such as herdr, prune stale ours by the same `OUR_HOOK_RE`) for `SessionStart→session_start`, `UserPromptSubmit→prompt`, `PreToolUse→tool_start`, `PostToolUse→activity`, `PermissionRequest→notification`, `Stop→stop`, `SessionEnd→session_end`, each command `am-hook.sh <type> codex` with `timeout: 5`.
  Check `~/.codex/config.toml` for `hooks = true` under `[features]`; if missing, print the exact lines to add (do not rewrite TOML).
  Print that Codex requires hook trust: the next interactive `codex` run asks to trust the new hooks; `codex exec` only runs trusted hooks.
  Register the MCP server for Codex with `codex mcp add agent-monitor --url http://127.0.0.1:<port>/mcp` when the `codex` binary exists (best effort; print the manual command on failure).
- Cursor: no hooks file is written (the Claude-compat path already delivers events; writing native entries would double-deliver).
  Register MCP by merging `{"mcpServers":{"agent-monitor":{"url":"http://127.0.0.1:<port>/mcp"}}}` into `~/.cursor/mcp.json` (backup first, preserve other servers).
- `settings-merge.ts` generalises: `mergeHookFile(settings, hookPath, table, harnessArg?)` used for both Claude and Codex.
- README documents all of this.

## 5. Web UI (workstreams B2 and B3)

### 5.1 Sessions (B2)

- Every session row shows a harness mark (Claude Code / Codex / Cursor: a small monochrome glyph plus accessible label, `title` with harness version) and a model pill (`prettyModel`, e.g. "Opus 5.5", "GPT-5.5", "Grok 4.7").
- Sessions list gets a harness filter (`Segmented`: All, Claude, Codex, Cursor with counts; persisted in `localStorage`).
- Child sessions (with `parent_session_id` pointing at a listed session) render nested under their parent, indented with a connector; orphans render top-level with a "spawned by <parent project>" hint.
- Live subagents: `SessionState` carries `subagents: [{agent_id, kind: "task"|"workflow", label, agent_type, model, last_tool, last_at}]` for agents active in the last 2 minutes; the row shows a compact "3 agents" chip that expands to the list.
- Cost cell: `$x.xx` when priced; `$x.xx+` with tooltip "some usage from unpriced models" when partially unpriced; `n/a` with tooltip "Cursor does not record token usage locally" for cursor.
- Idle rows show why: "stopped 3m ago" vs "quiet 12m".
- Needs-you rows show attention text and age.
- The workflow chip on a session row links to `#/workflows?run=<run_id>`.
- A+ max: branch and cost truncate before the task text.

### 5.2 Board chrome (B2)

- `App` tracks `ready` (first state received) and `connected` (SSE open, last message within 90 s).
  Before ready: skeleton rows, and the AppBar counts show `…`, never `0`.
  Disconnected: a thin warning bar "Reconnecting… data may be stale (last update 2m ago)".
- The AppBar renders on every route with the active route highlighted; sub-pages no longer drop it.
  The state fetch and SSE subscription happen once at App level for all routes.
- Sidebar order: Live Activity first, then Session cost, Cost breakdown, Tool usage.
- Live Activity rows show `<harness mark> <session label> · <agent label>` instead of the bare project; session label = project plus a short intent; filter by session via a select.
- Tool usage and cost breakdown headers say "all-time"; SESSION COST relabels "live total" to "open sessions" and "API-equiv" to "≈ API list price"; "today" to "today (local)".
- Unpriced usage: the cost panel lists unpriced models as "Model · unpriced · 12.3M tok".
- Degraded banner: shows only when runs degraded in the last 24 h, names the most recent run, and is dismissible (per run id, localStorage).
- Board shows the last workflow run line when nothing is live ("Last run: name · completed 2h ago · $4.39").
- Todos empty state: no emoji (no emoji font installed renders tofu); use a StatusGlyph.
- `ago()` gains days (`3d ago`) and switches to an absolute date after 7 days.
- Durations under 1 s render `<1s`.
- Meter bars sit under the label cell only.
- Truncated names carry `title`.
- Fonts: bundle Inter via `@fontsource-variable/inter`; mono stack `ui-monospace, "JetBrains Mono", "SFMono-Regular", Menlo, monospace` (drop Berkeley Mono).
- Phone width (390 px): no horizontal page scroll; AppBar controls collapse into an overflow menu below `sm`; session rows stack onto two lines.

### 5.3 Workflows and cost pages (B3)

- Workflows page: search box (`?q=`), project filter, day-grouped rows, 50 per page with "Load more", keyboard-accessible expanders (`button aria-expanded` in the name cell), lazy agent fetch on expand, deep link `#/workflows?run=<id>` auto-expands and scrolls to that run.
- Expanded run: summary line, manifest error in a mono danger block, per-agent rows with idx for duplicate labels, state colours for `error` and `killed`, no "attempt 1" noise (show attempts only when > 1), no live-blue styling on settled runs, model rendered "Opus 5 · 1M" for `[1m]` ids, fallback model noted.
- Agents column shows "7" or "11 (7 + 4 retried)".
- Running rows show live duration.
- Skeleton rows while loading on both pages.
- Tables become stacked cards below `md`.
- Cost page: per-day subtotal rows, window total in the header, unpriced rows labelled "unpriced" instead of `$0.00`, harness column, and a harness filter.

## 6. Verification

- `bun test tests/`, `bun run web:test`, `bun run typecheck`, `bun run web:build` all green after every workstream.
- Every behaviour above has a test (server: in-memory Store, fixtures under `tests/fixtures/`; web: vitest + testing-library).
- New fixtures captured from real data: a CC 2.1.282 workflow run (launched/failed journal lines, 7-key meta, manifest with `error`), a multi-line Claude message sharing `message.id`, a Codex 0.156 rollout (with `token_usage_record` and `token_count`), a pre-0.153 rollout, Cursor hook payloads (sessionStart, preToolUse, postToolUse, sessionEnd), and a Cursor agent transcript.
  Redact user content.
- E2E: restart the service on a copy of the production DB first, then on the real one; run a real `codex exec` and `cursor-agent -p` from a Claude session and watch them appear nested under the parent with harness and model; run a small Claude workflow and watch labels/phases appear live; check phone, 1280 and 1600 widths in both themes.
