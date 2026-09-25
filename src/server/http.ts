import type { IncomingMessage, ServerResponse } from "node:http";
import { Store } from "./store.ts";
import { SseHub } from "./sse.ts";
import { reduceEvent } from "./events.ts";
import { resolveRepoInfo } from "./resolve-project.ts";
import type { EventType, HookEvent, SessionPatch, TodoStatus } from "./types.ts";
import { handleMcpRequest, type McpDeps } from "./mcp.ts";
import { tailUsage } from "./usage.ts";
import { costOf } from "./pricing.ts";
import { sweepSubagents } from "./subagents.ts";
import { workflowsDegraded, logOnce, bumpDegraded, sessionDirFor } from "./workflows.ts";
import type { Store as StoreType } from "./store.ts";
import { createThrottle, type Throttled } from "./throttle.ts";
import { STATE_THROTTLE_MS } from "./config.ts";
import { compactPayload, extractEventColumns } from "./payload.ts";
import {
  normalizeIncomingEvent,
  resolveParentSessionId,
  cursorIntentFromTranscript,
  findCursorTranscript,
  keepSpecificModel,
} from "./harness/index.ts";

export interface AppDeps {
  store: Store;
  sse: SseHub;
  now?: () => number;
  mcp?: McpDeps;
  /** Shared trailing-edge broadcaster (§1.1). When omitted, createApp builds
   *  its own - fine standalone, but a real deployment must build ONE with
   *  `createStateScheduler` and pass the SAME instance here and to the MCP
   *  `onChange`/the 60s sweep, so every source of a state change coalesces
   *  into a single broadcast instead of each mutator throttling on its own. */
  scheduleState?: () => void;
}

/** Build the shared "state changed" broadcaster: a trailing-edge throttle
 *  (§1.1) around `sse.broadcast("state", buildState(store))`. One instance
 *  should be shared by every mutation path (POST /events, todo CRUD, MCP
 *  onChange, the 60s sweep) so a burst across all of them still collapses to
 *  one broadcast per window. */
export function createStateScheduler(store: StoreType, sse: SseHub, ms: number = STATE_THROTTLE_MS): Throttled {
  return createThrottle(() => {
    try {
      sse.broadcast("state", buildState(store));
    } catch (err) {
      // This runs inside a bare setTimeout callback (createThrottle's), with
      // no try/catch upstream: an uncaught throw here is an uncaught
      // exception for the whole process, and Bun/Node exits on one -- every
      // POST /events, todo edit, or sweep that lands while buildState() is
      // broken would then crash and restart the server instead of just
      // failing to refresh the board once. Degrade instead (matches
      // workflowTick's own logOnce/bumpDegraded pattern in workflows.ts).
      if (logOnce("state-broadcast", err)) bumpDegraded();
    }
  }, ms);
}

/** §1.5's no-downgrade rule, as a pure decision: does a fresh git resolution
 *  get applied to the session's project/branch, or does the session keep what
 *  it already has? A resolution that came from git (this call, or a cached
 *  earlier success) always applies. A basename fallback only applies when the
 *  session has no project resolved from git YET - an already-resolved session
 *  never regresses to a basename on a transient git failure/timeout. Exported
 *  so this decision is unit-testable without staging a real git failure
 *  mid-session.
 *
 *  `sessionResolved` is deliberately not just "the session row exists": a
 *  session whose only events so far were subagents' (project stamped
 *  "unknown" by applyEvent's own insert fallback, since a subagent patch
 *  carries no project field at all) has never had a chance at git resolution.
 *  Callers pass false for that case too, so the FIRST main-agent event with a
 *  usable cwd still gets the ordinary new-session basename fallback instead
 *  of being stuck on "unknown" forever. */
export function shouldApplyGitInfo(fromGit: boolean, sessionResolved: boolean): boolean {
  return fromGit || !sessionResolved;
}

const EVENT_TYPES = new Set<EventType>([
  "session_start",
  "prompt",
  "tool_start",
  "todo_update",
  "activity",
  "notification",
  "stop",
  "session_end",
]);

const TODO_STATUSES = new Set(["todo", "done"]);

function tryParse(raw: string): { ok: true; value: any } | { ok: false } {
  try {
    return { ok: true, value: raw ? JSON.parse(raw) : {} };
  } catch {
    return { ok: false };
  }
}

interface CursorUsagePost {
  session_id: string;
  request_id: string | null;
  model: string | null;
  at: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}

/** Validate an am-cursor usage post; null for anything malformed. */
export function parseCursorUsage(raw: string): CursorUsagePost | null {
  let o: any;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  const u = o?.usage;
  const n = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (typeof o?.session_id !== "string" || !o.session_id) return null;
  if (!u || !["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].every((k) => n(u[k]))) return null;
  return {
    session_id: o.session_id,
    request_id: typeof o.request_id === "string" && o.request_id ? o.request_id : null,
    model: typeof o.model === "string" && o.model ? o.model : null,
    at: n(o.at) ? o.at : Date.now(),
    usage: u,
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(s);
}

const ACTIVITY_LIMIT = 50;

function startOfLocalDay(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function buildState(store: StoreType) {
  // §5.1: live subagents active in the last 2 minutes, attached per session so
  // the UI stage can render them without a second round trip. Store-level
  // Session rows stay a pure DB projection (getSession's shape); this is
  // buildState's own wire-payload concern, matching how `cost` is assembled
  // below rather than stored on the row.
  const now = Date.now();
  const subagentsBySession = store.liveSubagents(now);
  return {
    sessions: store.listSessions().map((s) => ({ ...s, subagents: subagentsBySession.get(s.id) ?? [] })),
    todos: store.listTodos(),
    activity: store.recentActivity(ACTIVITY_LIMIT),
    stats: store.toolStats(),
    // A scalar sibling of sessions/todos/activity/stats/cost - NOT nested in cost,
    // and never an array. buildState() must stay under 50ms warm (§1.3;
    // scripts/profile-state.ts measures it) - it must not get slower.
    // §3: the process-lifetime counter (non-run causes: a broadcast that threw,
    // a background sweep that failed) plus the persisted, 24h-windowed count of
    // RUNS with a degraded parsing cause -- the latter survives a restart, the
    // former resets on one (see workflows.ts's `bumpRunDegraded` doc).
    workflows_degraded: workflowsDegraded() + store.degradedRunCount(now),
    // §5.2: the banner's "names the most recent run" -- null on a server with
    // no degraded runs in the last 24h, same window as degradedRunCount above.
    workflows_degraded_run: store.mostRecentDegradedRun(now),
    cost: {
      ...store.costSummary(startOfLocalDay(Date.now())),
      // All-time attribution for the historical breakdown panel.
      byProject: store.costByProject(),
      byBranch: store.costByBranch(),
    },
  };
}

export function createApp(deps: AppDeps) {
  const now = deps.now ?? (() => Date.now());
  const { store, sse } = deps;
  const scheduleState = deps.scheduleState ?? createStateScheduler(store, sse);

  return async function app(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    try {
      // --- ingestion ---
      if (method === "POST" && path === "/events") {
        const type = url.searchParams.get("type") as EventType | null;
        const raw = await readBody(req);
        if (!type || !EVENT_TYPES.has(type)) {
          res.writeHead(204).end();
          return;
        }
        let rawPayload: Record<string, unknown> = {};
        try {
          rawPayload = raw ? JSON.parse(raw) : {};
        } catch {
          res.writeHead(204).end();
          return;
        }
        // §4.2/§4.3: detect the harness and fold its own field names (Cursor's
        // conversation_id/workspace_roots/duration, ...) onto the generic ones
        // the rest of the pipeline already reads, BEFORE anything below reads
        // session_id/cwd/duration_ms - reduceEvent and extractEventColumns must
        // never know a single harness-specific field name.
        const queryHarness = url.searchParams.get("harness");
        const normalized = normalizeIncomingEvent(type, rawPayload, queryHarness);
        const payload = normalized.payload;
        const event: HookEvent = { ...(payload as object), wm_event_type: type } as HookEvent;
        if (!event.session_id) {
          res.writeHead(204).end();
          return;
        }
        const t = now();
        const { sessionId, patch: fullPatch } = reduceEvent(event, t);
        const cols = extractEventColumns(payload, normalized.harness);

        // §1.5: only main-agent events (no `agent_id` in the payload) may steer
        // a session's identity/status. A Task/workflow subagent's own tool
        // calls still prove the session as a whole is alive (last_activity_at)
        // and are stored as activity either way, but must not overwrite the
        // main agent's displayed project/branch/cwd/status/attention_reason/
        // active_tool/current_task/current_intent/transcript_path - a fresh
        // object (not `fullPatch`) so none of reduceEvent's other fields leak.
        // The same rule extends to harness/model/title/parent_session_id/
        // harness_version (§4.1/§4.2): a subagent's own payload describes the
        // SAME session, so it must never steer this session's identity either.
        const isSubagentEvent = cols.agentId != null;
        const patch: SessionPatch = isSubagentEvent ? { last_activity_at: fullPatch.last_activity_at } : fullPatch;

        const existing = store.getSession(sessionId);

        if (!isSubagentEvent) {
          patch.harness = normalized.harness;
          if (normalized.model) {
            patch.model =
              normalized.harness === "cursor" ? keepSpecificModel(existing?.model, normalized.model) : normalized.model;
          }
          if (normalized.title) patch.title = normalized.title;
          if (normalized.harnessVersion) patch.harness_version = normalized.harnessVersion;

          // §4.2: parent resolution - pcc/pcx (am-hook.sh's own query params)
          // first, then the scratchpad-cwd fallback. The store applies this
          // only while the session has no parent recorded yet (set once).
          const parent = resolveParentSessionId({
            pcc: url.searchParams.get("pcc"),
            pcx: url.searchParams.get("pcx"),
            cwd: event.cwd,
            sessionId,
          });
          if (parent) patch.parent_session_id = parent;

          // §4.3: Cursor's headless mode fires no prompt event, so its
          // current_intent can only come from its own transcript - try once
          // a transcript is known (early events carry transcript_path: null, so
          // look the file up by session id), and only while the session genuinely
          // has no intent yet (never overwrite a real one, and this stops
          // re-reading the transcript on every later event once it succeeds).
          if (normalized.harness === "cursor" && !patch.current_intent && !existing?.current_intent) {
            const transcriptPath =
              event.transcript_path ?? existing?.transcript_path ?? findCursorTranscript(sessionId);
            if (transcriptPath) {
              const intent = cursorIntentFromTranscript(transcriptPath);
              if (intent) patch.current_intent = intent;
            }
          }

          if (event.cwd) {
            // Refine project + branch from git so a worktree reports its repo, not
            // the branch directory the cwd basename gives (reduceEvent stays pure).
            const info = await resolveRepoInfo(event.cwd);
            // A session created by a subagent-first event (or a main event with
            // no cwd) is stamped project "unknown" and has never actually been
            // resolved from git -- treat it like a brand-new session for the
            // no-downgrade rule so it isn't stuck on "unknown" forever.
            const sessionResolved = existing != null && existing.project !== "unknown";
            if (shouldApplyGitInfo(info.fromGit, sessionResolved)) {
              patch.project = info.project;
              patch.branch = info.branch;
            } else {
              // git failed/timed out on an EXISTING session: never downgrade it
              // to the cwd basename reduceEvent set by default -- keep what it
              // already has (§1.5).
              delete patch.project;
            }
          }
        }
        store.applyEvent(sessionId, patch, t);
        store.recordEvent({
          sessionId,
          type,
          payload: compactPayload(payload),
          at: t,
          toolName: cols.toolName,
          durationMs: cols.durationMs,
          agentId: cols.agentId,
          harness: cols.harness,
          toolSummary: cols.toolSummary,
        });
        if (type === "stop" || type === "session_end") {
          const info = store.getTailInfo(sessionId);
          if (info) {
            tailUsage(store, {
              id: sessionId,
              transcript_path: info.transcript_path,
              usage_offset: info.usage_offset,
              harness: info.harness,
              model: info.model,
            });
            // §2.4, finding: `sessionsToTail()` (the 60s sweep) excludes ended
            // sessions, so a Task subagent's usage written since the last sweep
            // would otherwise sit unrecorded until the next server restart's
            // backfill. Give it the same final tail as the parent transcript.
            if (info.transcript_path) sweepSubagents(store, sessionId, sessionDirFor(info.transcript_path), t);
          }
        }
        scheduleState();
        res.writeHead(204).end();
        return;
      }

      // --- full state snapshot ---
      if (method === "GET" && path === "/api/state") {
        json(res, 200, buildState(store));
        return;
      }

      // --- daily cost breakdown (project/branch/day); pull, not streamed ---
      if (method === "GET" && path === "/api/cost/daily") {
        const num = (v: string | null): number | undefined => {
          const n = v == null ? NaN : Number(v);
          return Number.isFinite(n) ? n : undefined;
        };
        const harness = url.searchParams.get("harness");
        const rows = store.costDaily({
          since: num(url.searchParams.get("since")),
          until: num(url.searchParams.get("until")),
          harness: harness && harness.trim() ? harness.trim() : undefined,
        });
        json(res, 200, { rows });
        return;
      }

      // --- workflow run LIST; pull, not streamed (live runs use the SSE
      // `workflows` event instead - buildState() must stay under 50ms warm
      // (§1.3) and must not grow). §3: runs WITHOUT their per-agent array (see
      // `store.workflowList`'s doc for why), plus `q`/`limit`/`offset`/`total`. ---
      if (method === "GET" && path === "/api/workflows") {
        const num = (v: string | null): number | undefined => {
          const n = v == null ? NaN : Number(v);
          return Number.isFinite(n) ? n : undefined;
        };
        const q = url.searchParams.get("q");
        const project = url.searchParams.get("project");
        const { runs, total } = store.workflowList({
          q: q && q.trim() ? q.trim() : undefined,
          project: project && project.trim() ? project.trim() : undefined,
          since: num(url.searchParams.get("since")),
          until: num(url.searchParams.get("until")),
          limit: num(url.searchParams.get("limit")),
          offset: num(url.searchParams.get("offset")),
        });
        json(res, 200, { runs, total });
        return;
      }

      // --- one workflow run, WITH its agents (§3) ---
      const workflowRunMatch = path.match(/^\/api\/workflows\/([^/]+)$/);
      if (method === "GET" && workflowRunMatch) {
        const run = store.workflowRunDetail(decodeURIComponent(workflowRunMatch[1]));
        if (!run) {
          json(res, 404, { error: "not found" });
          return;
        }
        json(res, 200, run);
        return;
      }

      // --- SSE ---
      if (method === "GET" && path === "/api/stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`event: state\ndata: ${JSON.stringify(buildState(store))}\n\n`);
        // §3: the wire shape is {runs, last_run} -- see workflowTick's own doc
        // comment in workflows.ts for why that assembly isn't inside
        // `Store.liveWorkflows` itself.
        res.write(
          `event: workflows\ndata: ${JSON.stringify({ runs: store.liveWorkflows(), last_run: store.lastSettledRun() })}\n\n`
        );
        sse.add(res);
        return;
      }

      // --- Cursor usage from the am-cursor wrapper ---
      // Cursor never writes usage to disk; am-cursor reads it from
      // cursor-agent's own stream-json output and posts it here once per
      // invocation. Always 204: the wrapper is fire-and-forget.
      if (method === "POST" && path === "/api/usage/cursor") {
        const u = parseCursorUsage(await readBody(req));
        if (u) {
          const model = store.getTailInfo(u.session_id)?.model ?? u.model ?? "unknown";
          const tokens = {
            input: u.usage.inputTokens,
            output: u.usage.outputTokens,
            cache_read: u.usage.cacheReadTokens,
            cache_create_5m: u.usage.cacheWriteTokens,
            cache_create_1h: 0,
          };
          const recorded = store.recordUsage({
            uuid: `cursor:${u.request_id ?? `${u.session_id}:${u.at}`}`,
            messageKey: `cursor:${u.request_id ?? `${u.session_id}:${u.at}`}`,
            sessionId: u.session_id,
            model,
            tokens,
            at: u.at,
            cost: costOf(model, tokens),
            harness: "cursor",
          });
          if (recorded) scheduleState();
        }
        res.writeHead(204).end();
        return;
      }

      // --- todos CRUD ---
      if (method === "POST" && path === "/api/todos") {
        const parsed = tryParse(await readBody(req));
        if (!parsed.ok) {
          json(res, 400, { error: "invalid JSON" });
          return;
        }
        const body = parsed.value;
        if (!body.title || typeof body.title !== "string") {
          json(res, 400, { error: "title is required" });
          return;
        }
        const todo = store.createTodo(body, now());
        scheduleState();
        json(res, 201, todo);
        return;
      }

      const todoMatch = path.match(/^\/api\/todos\/([^/]+)$/);
      if (todoMatch) {
        const id = decodeURIComponent(todoMatch[1]);
        if (method === "PATCH") {
          const parsed = tryParse(await readBody(req));
          if (!parsed.ok) {
            json(res, 400, { error: "invalid JSON" });
            return;
          }
          const body = parsed.value;
          if (body.status !== undefined && !TODO_STATUSES.has(body.status)) {
            json(res, 400, { error: "invalid status" });
            return;
          }
          if (body.position !== undefined && typeof body.position !== "number") {
            json(res, 400, { error: "invalid position" });
            return;
          }
          const updated = store.updateTodo(id, body, now());
          if (!updated) {
            json(res, 404, { error: "not found" });
            return;
          }
          scheduleState();
          json(res, 200, updated);
          return;
        }
        if (method === "DELETE") {
          const ok = store.deleteTodo(id);
          if (ok) scheduleState();
          res.writeHead(ok ? 204 : 404).end();
          return;
        }
      }

      // --- list todos (optional filter) ---
      if (method === "GET" && path === "/api/todos") {
        const status = url.searchParams.get("status");
        if (status !== null && !TODO_STATUSES.has(status)) {
          json(res, 400, { error: "invalid status" });
          return;
        }
        json(res, 200, store.listTodos((status as TodoStatus) ?? undefined));
        return;
      }

      if (path === "/mcp") {
        if (!deps.mcp) {
          res.writeHead(503).end();
          return;
        }
        let body: unknown = undefined;
        if (method === "POST") {
          const raw = await readBody(req);
          body = raw ? JSON.parse(raw) : undefined;
        }
        await handleMcpRequest(deps.mcp, req, res, body);
        return;
      }

      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  };
}
