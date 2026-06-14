import type { IncomingMessage, ServerResponse } from "node:http";
import { Store } from "./store.ts";
import { SseHub } from "./sse.ts";
import { reduceEvent } from "./events.ts";
import type { EventType, HookEvent, TodoStatus } from "./types.ts";
import { handleMcpRequest, type McpDeps } from "./mcp.ts";

export interface AppDeps {
  store: Store;
  sse: SseHub;
  now?: () => number;
  mcp?: McpDeps;
}

const EVENT_TYPES = new Set<EventType>([
  "session_start",
  "prompt",
  "todo_update",
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

export function createApp(deps: AppDeps) {
  const now = deps.now ?? (() => Date.now());
  const { store, sse } = deps;

  function pushState(): void {
    sse.broadcast("state", { sessions: store.listSessions(), todos: store.listTodos() });
  }

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
        let payload: Record<string, unknown> = {};
        try {
          payload = raw ? JSON.parse(raw) : {};
        } catch {
          res.writeHead(204).end();
          return;
        }
        const event: HookEvent = { ...(payload as object), wm_event_type: type } as HookEvent;
        if (!event.session_id) {
          res.writeHead(204).end();
          return;
        }
        const t = now();
        const { sessionId, patch } = reduceEvent(event, t);
        store.applyEvent(sessionId, patch, t);
        store.db
          .query(`INSERT INTO events (session_id, type, payload, at) VALUES ($s, $t, $p, $a)`)
          .run({ $s: sessionId, $t: type, $p: raw.slice(0, 8000), $a: t });
        pushState();
        res.writeHead(204).end();
        return;
      }

      // --- full state snapshot ---
      if (method === "GET" && path === "/api/state") {
        json(res, 200, { sessions: store.listSessions(), todos: store.listTodos() });
        return;
      }

      // --- SSE ---
      if (method === "GET" && path === "/api/stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`event: state\ndata: ${JSON.stringify({ sessions: store.listSessions(), todos: store.listTodos() })}\n\n`);
        sse.add(res);
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
        pushState();
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
          pushState();
          json(res, 200, updated);
          return;
        }
        if (method === "DELETE") {
          const ok = store.deleteTodo(id);
          if (ok) pushState();
          res.writeHead(ok ? 204 : 404).end();
          return;
        }
      }

      // --- list todos (optional filter) ---
      if (method === "GET" && path === "/api/todos") {
        const status = url.searchParams.get("status") as TodoStatus | null;
        json(res, 200, store.listTodos(status ?? undefined));
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
