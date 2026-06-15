import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Store } from "./store.ts";
import type { TodoStatus } from "./types.ts";

export interface McpDeps {
  store: Store;
  onChange: () => void;
  now?: () => number;
}

/** Plain tool implementations — unit-testable without the transport. */
export function makeTools(deps: McpDeps) {
  const now = deps.now ?? (() => Date.now());
  const { store, onChange } = deps;
  return {
    add_todo(input: {
      title: string;
      note?: string;
      for_who?: string;
      project?: string;
      branch?: string;
      links?: string[];
    }) {
      const todo = store.createTodo(
        {
          title: input.title,
          note: input.note ?? "",
          for_who: input.for_who ?? null,
          origin_project: input.project ?? null,
          branch: input.branch ?? null,
          links: input.links ?? null,
        },
        now()
      );
      onChange();
      return { id: todo.id, status: todo.status };
    },
    list_todos(input: { status?: TodoStatus }) {
      return { todos: store.listTodos(input.status) };
    },
    update_todo(input: { id: string; status?: TodoStatus; note?: string }) {
      const patch: { status?: TodoStatus; note?: string } = {};
      if (input.status !== undefined) patch.status = input.status;
      if (input.note !== undefined) patch.note = input.note;
      const updated = store.updateTodo(input.id, patch, now());
      if (updated) onChange();
      return { ok: !!updated };
    },
  };
}

function buildServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "agent-monitor", version: "0.1.0" });
  const tools = makeTools(deps);

  server.registerTool(
    "add_todo",
    {
      description:
        "Record a todo on the agent-monitor dashboard — any task, reminder, or hand-off worth not forgetting, for yourself or someone else (not limited to engineer hand-offs). Use whenever you or the user want something tracked on the board. Put any useful context in note.",
      inputSchema: {
        title: z.string().describe("Short title, e.g. 'Run bun run setup' or 'Hand off payments spec'"),
        note: z.string().optional().describe("Optional context — what's done, what's left, paths"),
        for_who: z.string().optional().describe("Optional — who it's for, if you're handing off to someone"),
        project: z.string().optional().describe("Optional project name"),
        branch: z.string().optional().describe("Optional git branch the work is on"),
        links: z.array(z.string()).optional().describe("Optional — spec paths, PR URLs, etc."),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: JSON.stringify(tools.add_todo(args as any)) }],
    })
  );

  server.registerTool(
    "list_todos",
    {
      description:
        "List todos on the agent-monitor dashboard (optionally filtered by status) — e.g. to avoid creating duplicates or to check what's still open.",
      inputSchema: { status: z.enum(["todo", "done"]).optional() },
    },
    async (args) => ({
      content: [{ type: "text", text: JSON.stringify(tools.list_todos(args as any)) }],
    })
  );

  server.registerTool(
    "update_todo",
    {
      description:
        "Update a todo on the agent-monitor dashboard — mark it done (or back to todo), or amend its note.",
      inputSchema: {
        id: z.string(),
        status: z.enum(["todo", "done"]).optional(),
        note: z.string().optional(),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: JSON.stringify(tools.update_todo(args as any)) }],
    })
  );

  return server;
}

const transports: Record<string, StreamableHTTPServerTransport> = {};

/** Stateful Streamable HTTP handler with per-session transports. */
export async function handleMcpRequest(
  deps: McpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (req.method === "POST") {
    let transport: StreamableHTTPServerTransport | undefined = sessionId
      ? transports[sessionId]
      : undefined;

    if (!transport) {
      if (sessionId || !isInitializeRequest(body)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: no valid session ID" },
            id: null,
          })
        );
        return;
      }
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          transports[sid] = created;
        },
      });
      created.onclose = () => {
        if (created.sessionId) delete transports[created.sessionId];
      };
      const server = buildServer(deps);
      await server.connect(created);
      transport = created;
    }

    await transport.handleRequest(req, res, body);
    return;
  }

  if ((req.method === "GET" || req.method === "DELETE") && sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res);
    return;
  }

  res.writeHead(400, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request" },
      id: null,
    })
  );
}
