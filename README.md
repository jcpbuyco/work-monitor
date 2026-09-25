# agent-monitor

Live dashboard for parallel Claude Code sessions + agent-authored todos.

## What it does

- Each Claude Code session reports status automatically (via hooks): **working / needs you / idle**.
- A pinned web dashboard shows **todos on top** - a single collapsible open-to-do list (✓ to complete a card, ✕ to delete; completed todos live behind a paginated **Done** dialog) - and **live sessions below** (auto-grouped by status).
- Agents record todos via an MCP tool (`add_todo`) - just say *"add a todo for this"* - for any task, reminder, or hand-off; the agent fills in the context (branch, spec path, what's left, who it's for).

## Adding a todo (from an agent)

Any Claude Code session can drop a todo onto the dashboard through the `add_todo` MCP tool - no shell, no flags. Just tell the agent in plain language:

> "Add a todo to verify the checkout flow on mobile before we ship - it's for QA, on branch `feat/checkout`."

The agent calls the tool, filling in whatever context it has:

```jsonc
add_todo({
  "title":   "Verify checkout flow on mobile",          // required
  "note":    "Payment sheet clipped on iOS Safari - retest before shipping.", // optional
  "for_who": "QA",                       // optional - who it's for / who you're handing off to
  "branch":  "feat/checkout",            // optional
  "project": "storefront",               // optional
  "links":   ["docs/specs/checkout.md"]  // optional
})
```

Only `title` is required; everything else is optional (a quick `add_todo({ "title": "Run db migration" })` works too). The card shows up instantly in the **To do** column (pushed live over SSE).

To close it out, click the **✓** on the card (it moves into the **Done** dialog), or have the agent do it:

```jsonc
update_todo({ "id": "<id>", "status": "done" })   // or "todo" to reopen
```

An agent can call `list_todos()` (optionally `list_todos({ "status": "todo" })`) first to see what's already open and avoid duplicates.

## Architecture

One long-running Bun process (`am-server`, on `127.0.0.1:4317`) exposes:
- a **REST API** - `POST /events` (hook ingestion), `GET /api/state`, `GET /api/stream` (SSE), `/api/todos` CRUD;
- an **MCP endpoint** at `/mcp` (Streamable HTTP) with tools `add_todo`, `list_todos`, `update_todo`;
- the built **dashboard** (React + Vite + Tailwind).

State lives in SQLite (`~/.local/share/agent-monitor/agent-monitor.sqlite`, WAL mode). Session status is driven by a small state machine over hook events: a tool-use heartbeat (`PostToolUse`) keeps actively-working sessions marked **working**. A two-tier staleness sweep handles sessions that quiet down: a **working** session silent for 10 minutes drops to **idle** (still shown), and **any** session silent for 30 minutes is retired and removed from the board (a closed terminal or crash sends no `session_end`, so prolonged silence is the only tell). A clean exit (`SessionEnd`) removes a session immediately.

## Install / activate

```bash
bun install
bun run web:build
bun run setup     # installs systemd user service, merges hooks, registers MCP
```

`bun run setup` will:
- install + start a `systemd --user` service running the server on `127.0.0.1:4317`,
- merge hook entries into `~/.claude/settings.json` (it backs the file up to `settings.json.am-backup` first, and is idempotent - safe to re-run),
- register the `agent-monitor` MCP server at user scope.

Then open **http://127.0.0.1:4317** and pin the tab. **Restart any open Claude Code sessions** so they pick up the new hooks + MCP.

## Multi-harness setup

agent-monitor ingests three coding-agent CLIs: **Claude Code**, **Codex**, and **Cursor** (`cursor-agent`).
`bun run setup` configures whichever of these are installed on this machine automatically - it detects each one by its home directory (`~/.codex`, `~/.cursor`) and skips the ones that are absent.

### Codex

When `~/.codex` exists, `bun run setup` additionally:
- merges hook entries into `~/.codex/hooks.json` (backs it up to `hooks.json.am-backup` first, and preserves any other tool's entries - it is idempotent, safe to re-run).
- checks `~/.codex/config.toml` for `hooks = true` under `[features]`, and prints the exact lines to add if it is missing.
  Setup never rewrites `config.toml` itself.
- prints a reminder that Codex requires **hook trust**: the next interactive `codex` run will ask to trust the new hooks, and `codex exec` only runs hooks that have already been trusted (or pass `--dangerously-bypass-hook-trust`).
- registers the `agent-monitor` MCP server with `codex mcp add` when the `codex` binary is on `PATH` (best effort - it prints the manual command on failure).

Once hooks are trusted, a `codex exec` (or interactive `codex`) session reports to the dashboard the same way a Claude Code session does, including nested under whichever session spawned it.
Token usage and cost are read from Codex's own rollout files (`~/.codex/sessions/**/rollout-*.jsonl`), including a one-time startup scan that backfills any session the server missed while it was down.

### Cursor

When `~/.cursor` exists, `bun run setup` merges `{"mcpServers": {"agent-monitor": {...}}}` into `~/.cursor/mcp.json` (backed up first, other servers preserved).
**No `~/.cursor/hooks.json` is written.**
`cursor-agent` already parses `~/.claude/settings.json`/`.claude/settings.local.json` through its own Claude-compat layer and runs the exact same `am-hook.sh` commands that `bun run setup` installs for Claude Code - a second, native hooks file would just double-deliver every event.

Cursor never writes token/cost data to disk anywhere, and its own hooks don't carry it either, so cost for Cursor sessions always shows as **n/a** on the dashboard - this is a known, permanent gap, not a bug.
Everything else (status, tool activity, project/branch, nesting under a parent session) works the same as Claude Code and Codex.

### How harness detection works

Every hook event reaches the same `POST /events` endpoint.
The server tells harnesses apart, in order: a payload carrying `cursor_version` (or a `transcript_path` under `~/.cursor/`) is Cursor; a `transcript_path` under `~/.codex/` (or the query string's `harness=codex`, set by Codex's own hooks.json entries) is Codex; anything else is Claude Code.
A session spawned by another one (a Bash `codex exec`/`cursor-agent` call, or a nested `claude` session) is linked to its parent via `am-hook.sh`'s own `pcc`/`pcx` query parameters (`$CLAUDE_CODE_SESSION_ID`/`$CODEX_THREAD_ID`, when set), falling back to the scratchpad-cwd naming convention when neither is available.

## Dev

- `bun run server` - run the server in the foreground.
- `bun run web:dev` - Vite dev server on :5317 (proxies `/api`, `/events`, `/mcp` to :4317).
- `bun test tests/` - backend tests. `bun run web:test` - frontend test.

## Config

- `AM_PORT` (default `4317`)
- `AM_DB_PATH` (default `~/.local/share/agent-monitor/agent-monitor.sqlite`)

## Uninstall

```bash
systemctl --user disable --now am-server.service
claude mcp remove agent-monitor --scope user
# then restore ~/.claude/settings.json from settings.json.am-backup
# (or remove the agent-monitor hook entries by hand)
```

## Roadmap (v2)

The server is already fully HTTP (REST + HTTP-transport MCP) and the dashboard is responsive, so the planned cloud/phone access is mostly "host the server + add a bearer token + login" - not a rewrite. See `docs/superpowers/specs/2026-06-14-agent-monitor-design.md`.
