# work-monitor

Live dashboard for parallel Claude Code sessions + agent-authored hand-off todos.

## What it does

- Each Claude Code session reports status automatically (via hooks): **working / needs you / idle**.
- A pinned web dashboard shows a two-lane kanban: **hand-offs on top** (you drag through `To hand off → Handed off → Done`), **live sessions below** (auto-grouped by status — you never drag these).
- Agents record hand-off todos via an MCP tool (`record_handoff`) — just say *"set a hand-off todo for this"* and the agent fills in the context (branch, spec path, what's left, who it's for).

## Architecture

One long-running Bun process (`wm-server`, on `127.0.0.1:4317`) exposes:
- a **REST API** — `POST /events` (hook ingestion), `GET /api/state`, `GET /api/stream` (SSE), `/api/todos` CRUD;
- an **MCP endpoint** at `/mcp` (Streamable HTTP) with tools `record_handoff`, `list_todos`, `update_handoff`;
- the built **dashboard** (React + Vite + Tailwind).

State lives in SQLite (`~/.local/share/work-monitor/work-monitor.sqlite`, WAL mode). Session status is driven by a small state machine over hook events, with a staleness sweep that retires crashed sessions.

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
