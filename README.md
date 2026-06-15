# work-monitor

Live dashboard for parallel Claude Code sessions + agent-authored todos.

## What it does

- Each Claude Code session reports status automatically (via hooks): **working / needs you / idle**.
- A pinned web dashboard shows **todos on top** — a single collapsible open-to-do list (✓ to complete a card, ✕ to delete; completed todos live behind a paginated **Done** dialog) — and **live sessions below** (auto-grouped by status).
- Agents record todos via an MCP tool (`add_todo`) — just say *"add a todo for this"* — for any task, reminder, or hand-off; the agent fills in the context (branch, spec path, what's left, who it's for).

## Adding a todo (from an agent)

Any Claude Code session can drop a todo onto the dashboard through the `add_todo` MCP tool — no shell, no flags. Just tell the agent in plain language:

> "Add a todo to verify the checkout flow on mobile before we ship — it's for QA, on branch `feat/checkout`."

The agent calls the tool, filling in whatever context it has:

```jsonc
add_todo({
  "title":   "Verify checkout flow on mobile",          // required
  "note":    "Payment sheet clipped on iOS Safari — retest before shipping.", // optional
  "for_who": "QA",                       // optional — who it's for / who you're handing off to
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

One long-running Bun process (`wm-server`, on `127.0.0.1:4317`) exposes:
- a **REST API** — `POST /events` (hook ingestion), `GET /api/state`, `GET /api/stream` (SSE), `/api/todos` CRUD;
- an **MCP endpoint** at `/mcp` (Streamable HTTP) with tools `add_todo`, `list_todos`, `update_todo`;
- the built **dashboard** (React + Vite + Tailwind).

State lives in SQLite (`~/.local/share/work-monitor/work-monitor.sqlite`, WAL mode). Session status is driven by a small state machine over hook events: a tool-use heartbeat (`PostToolUse`) keeps actively-working sessions marked **working**, and a staleness sweep retires ones that go silent for 10 minutes (e.g. a closed terminal).

## Install / activate

```bash
bun install
bun run web:build
bun run setup     # installs systemd user service, merges hooks, registers MCP
```

`bun run setup` will:
- install + start a `systemd --user` service running the server on `127.0.0.1:4317`,
- merge hook entries into `~/.claude/settings.json` (it backs the file up to `settings.json.wm-backup` first, and is idempotent — safe to re-run),
- register the `work-monitor` MCP server at user scope.

Then open **http://127.0.0.1:4317** and pin the tab. **Restart any open Claude Code sessions** so they pick up the new hooks + MCP.

## Dev

- `bun run server` — run the server in the foreground.
- `bun run web:dev` — Vite dev server on :5317 (proxies `/api`, `/events`, `/mcp` to :4317).
- `bun test tests/` — backend tests. `bun run web:test` — frontend test.

## Config

- `WM_PORT` (default `4317`)
- `WM_DB_PATH` (default `~/.local/share/work-monitor/work-monitor.sqlite`)

## Uninstall

```bash
systemctl --user disable --now wm-server.service
claude mcp remove work-monitor --scope user
# then restore ~/.claude/settings.json from settings.json.wm-backup
# (or remove the work-monitor hook entries by hand)
```

## Roadmap (v2)

The server is already fully HTTP (REST + HTTP-transport MCP) and the dashboard is responsive, so the planned cloud/phone access is mostly "host the server + add a bearer token + login" — not a rewrite. See `docs/superpowers/specs/2026-06-14-work-monitor-design.md`.
