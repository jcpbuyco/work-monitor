# work-monitor — Design Spec

- **Date:** 2026-06-14
- **Status:** Approved (ready for implementation planning)
- **Author:** jcpbuyco (with Claude)

## Problem

When running multiple Claude Code sessions in parallel, it's easy to lose track of
what each agent is doing. Agents go off and work; the user becomes idle and gets
distracted; when they come back they've lost the thread of which sessions are
working, which are waiting on them, and what still needs to happen. Separately,
some work needs to be **handed off to another engineer** (e.g. a brainstorm produced
a spec on a branch that someone else will implement) and that intent is easily
forgotten.

## Goals

1. **At-a-glance awareness** of every running Claude Code session: which project,
   what it's working on, and whether it's **working / waiting on you / idle**.
2. **Live** — the view reflects real agent state automatically, with no manual logging.
3. **Persistent hand-off todos**, authored by the agent that has the context, that
   survive across sessions and stand as reminders until dealt with.
4. A single home-base **web dashboard** the user keeps pinned in a browser tab.

## Non-goals (v1)

- No messaging/issue-creation integrations (Slack, GitHub). Hand-offs are personal
  reminders the user acts on; the tool does not contact anyone.
- No multi-user / shared backend. Single user, fully local.
- No tracking of subagents as separate entities (too noisy) — top-level sessions only.
- No auth (server is loopback-only in v1).

Cloud/multi-user/phone access is an explicit **v2** direction the architecture must
not preclude (see "v2 cloud path").

## Users & context

Single developer running several parallel Claude Code sessions across projects under
`~/projects`. Comfortable in the terminal (Arch, bspwm), JS/TS-centric toolchain.

## Architecture overview

One long-running local server is the hub; thin clients feed it and read from it.

```
  Claude Code sessions                          ┌─────────────────────┐
  ┌──────────────┐  hook events (POST /events)  │     wm-server       │
  │ session A ──────────────────────────────────▶│  (long-running,    │
  │ session B ──────────────────────────────────▶│   systemd --user)  │
  └──────────────┘                              │                     │
                                                │  • REST API         │
  Agent inside a session (MCP, HTTP transport)  │  • MCP endpoint     │
  ┌──────────────┐  record_handoff(...)         │  • SQLite (WAL)     │
  │ "set a hand-off todo" ─────(/mcp)──────────▶│  • SSE live stream  │
  └──────────────┘                              └─────────┬───────────┘
                                                          │ serves dashboard
                                                          │ + live updates (SSE)
                                                          ▼
                                                ┌─────────────────────┐
                                                │  Web dashboard       │
                                                │  (pinned browser tab)│
                                                │  two-lane kanban     │
                                                └─────────────────────┘
```

### Components

**1. `wm-server` — the hub.** Long-running local process (Bun + TypeScript). Holds a
SQLite database (WAL mode) and exposes, on `127.0.0.1`:
- a **REST API** (hook ingestion, dashboard state, todo CRUD),
- an **MCP endpoint** over Streamable HTTP transport (agent-authored todos),
- an **SSE stream** for live dashboard updates,
- the built **dashboard** static assets.

Installed as a `systemd --user` service so it starts on login and restarts on crash.

**2. Hook scripts — automatic session reporting.** Tiny scripts wired into global
Claude Code hooks (`~/.claude/settings.json`). Each maps a Claude Code lifecycle
event to a `POST /events`. **Fire-and-forget, `curl --max-time 1`, errors swallowed**
— they must never block or slow an agent. If the server is down the event is dropped
and the next event re-syncs.

**3. MCP tools — agent-authored hand-offs.** The agent calls structured tools (no
shell, no flag-building) to record/update hand-off todos. HTTP transport so the same
server works locally now and remotely in v2.

**4. Web dashboard — the frontend.** React + Vite + Tailwind. Subscribes to SSE,
renders the two-lane kanban live, and supports drag in the hand-off lane (persists
via `PATCH`). Responsive (columns stack on narrow screens) for v2 phone use.

**5. `wm setup` — onboarding.** One idempotent command that installs the service,
merges the hooks into `~/.claude/settings.json`, and registers the MCP server at user
scope.

## Data model (SQLite)

**`sessions`** — current state of each Claude Code session
| column | type | notes |
|---|---|---|
| `id` | TEXT PK | Claude Code `session_id` |
| `project` | TEXT | derived from cwd basename |
| `cwd` | TEXT | working directory |
| `transcript_path` | TEXT | optional |
| `status` | TEXT | `working` \| `needs_you` \| `idle` \| `ended` |
| `current_task` | TEXT | derived (see below) |
| `current_intent` | TEXT | latest user prompt, truncated |
| `attention_reason` | TEXT | e.g. the Notification text |
| `started_at` | INTEGER | epoch ms |
| `last_activity_at` | INTEGER | epoch ms |
| `ended_at` | INTEGER | nullable |

**`events`** — append-only log (drives status, gives history/debug)
| column | type | notes |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `session_id` | TEXT | |
| `type` | TEXT | `session_start` \| `prompt` \| `todo_update` \| `notification` \| `stop` \| `session_end` |
| `payload` | TEXT (JSON) | |
| `at` | INTEGER | epoch ms |

**`todos`** — hand-off / persistent cards
| column | type | notes |
|---|---|---|
| `id` | TEXT PK | uuid |
| `title` | TEXT | |
| `note` | TEXT | rich context the agent fills in |
| `for_who` | TEXT | nullable — who to hand off to |
| `status` | TEXT | `to_hand_off` \| `handed_off` \| `done` |
| `origin_session_id` | TEXT | nullable |
| `origin_project` | TEXT | nullable |
| `branch` | TEXT | nullable |
| `links` | TEXT (JSON) | nullable — spec path, PR, etc. |
| `position` | INTEGER | manual order within a column (drag reorder) |
| `created_at` | INTEGER | epoch ms |
| `updated_at` | INTEGER | epoch ms |

## Session status state machine

```
SessionStart ─────────────▶ working
UserPromptSubmit ─────────▶ working   (refresh last_activity_at, set current_intent)
PostToolUse (TodoWrite) ──▶ working   (refresh last_activity_at, set current_task)
Notification ─────────────▶ needs_you (set attention_reason)
Stop ─────────────────────▶ idle
SessionEnd ───────────────▶ ended     (card fades off the board)
```

**Staleness sweep:** a periodic check moves any `working` session with no activity for
~10 minutes to `idle` (subtly flagged), covering crashed sessions that never emit
`Stop`/`SessionEnd`.

## "Current task" derivation (best signal wins)

1. The session's **TodoWrite list** captured from `PostToolUse` — show the
   `in_progress` item plus a "N/M done" count. The real, specific task.
2. Else the **latest user prompt** (`current_intent`), truncated.
3. Always paired with the status badge.

## REST API

| Endpoint | Method | Used by | Purpose |
|---|---|---|---|
| `/events` | POST | hook scripts | ingest a session event |
| `/api/state` | GET | dashboard | full snapshot `{sessions, todos}` |
| `/api/stream` | GET | dashboard | SSE live updates |
| `/api/todos` | POST | (also MCP) | create a hand-off todo |
| `/api/todos/:id` | PATCH | dashboard | drag (status/position), edits |
| `/api/todos/:id` | DELETE | dashboard | remove a todo |
| `/` + assets | GET | browser | serve the dashboard |

**Live updates:** server keeps in-memory SSE subscribers; any state change broadcasts
the changed entity, and the client updates that one card. On connect/reconnect the
client pulls `/api/state` for a full resync, so refreshes and dropped connections
self-heal. Multiple pinned tabs stay in sync.

## MCP endpoint

Streamable HTTP transport at `/mcp`. Tools (kept intentionally small):

- `record_handoff(title, note, for_who?, project?, branch?, links?)` → creates a card
  in *To hand off*.
- `list_todos(status?)` → lets an agent check what's already pending / avoid dupes.
- `update_handoff(id, status?, note?)` → e.g. mark *handed off* from within a session.

If the server is unreachable, tools return a clear error so the agent surfaces it to
the user rather than silently losing the hand-off.

## Hook mapping

| Claude Code hook | `/events` type | Board effect |
|---|---|---|
| `SessionStart` | `session_start` | session registered → *Working* |
| `UserPromptSubmit` | `prompt` | stays *Working*, captures intent |
| `PostToolUse` (matcher: `TodoWrite`) | `todo_update` | updates current task |
| `Notification` | `notification` | → *Needs you* (+ reason) |
| `Stop` | `stop` | → *Idle / done* |
| `SessionEnd` | `session_end` | → *Ended* (fades off board) |

## Dashboard UX (locked layout)

Two-lane kanban, **hand-offs lane on top** for priority visibility:

- **Hand-offs & todos (top, manual):** columns *To hand off → Handed off → Done*.
  Cards are dragged by the user through stages. Agent-created cards land in *To hand
  off* with auto-filled context (note, for_who, branch, links).
- **Sessions (bottom, automatic):** columns *Working / Needs you / Idle*. Cards move
  themselves based on live hook events; not draggable. Each card shows project,
  current task, status badge, and "active/idle Xs ago".

Responsive: columns stack vertically on narrow screens (v2 phone readiness).

## Resilience & edge cases

- Hooks fire-and-forget with a 1s timeout; never block agents; dropped events
  self-heal on the next event.
- MCP errors are returned loudly to the agent.
- Staleness sweep rescues stuck `working` sessions.
- SQLite WAL mode for concurrent writers (many sessions) + readers (dashboard).
- SSE auto-reconnect + full `/api/state` resync.
- Subagents are not separate cards in v1.
- Project-name collisions (same basename): show parent path on hover (minor).
- Ended sessions retained in DB for history, hidden from the board after a short fade.

## Security (v1)

Server binds to `127.0.0.1` only; no auth required because all access is loopback.

## Tech stack

- **Backend:** Bun + TypeScript. `bun:sqlite` for storage, Bun's HTTP server, an MCP
  HTTP-transport handler, SSE.
- **Frontend:** React + Vite + Tailwind, drag-and-drop in the hand-off lane.
- **Service:** `systemd --user`.

## Testing strategy (TDD)

- Pure unit tests for the **status state machine** (event → status) and **current-task
  derivation** — core logic, no I/O.
- API integration tests: `POST /events` mutates state; `POST /api/todos` creates;
  `PATCH` moves a card; SSE emits on change.
- MCP tool tests: `record_handoff` writes the expected row.
- An events **replay/fixture** helper to simulate sessions without real Claude Code
  instances.
- Minimal frontend tests: lanes render; a drag triggers the correct `PATCH`.

## v2 cloud path (designed-for, not built)

- Everything is already HTTP (REST + HTTP-transport MCP) → host the server, add a
  bearer token. Hooks gain an auth header + remote URL via env in `settings.json`;
  the dashboard gains login.
- Dashboard is responsive from day one → phone viewing needs no rework.
- Tables stay single-user in v1 but can gain an `owner`/`workspace` scope via a clean
  migration (not a rewrite).

## Setup script (`wm setup`)

Idempotent; safe to re-run:
1. Build the server; install + enable the `systemd --user` service.
2. Merge hook entries into `~/.claude/settings.json`, preserving existing hooks.
3. Register the MCP server at user scope:
   `claude mcp add --transport http --scope user work-monitor http://localhost:PORT/mcp`.
4. Detect and update existing entries instead of duplicating.
