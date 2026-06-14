import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createServer, type Server } from "node:http";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import { SseHub } from "../src/server/sse.ts";
import { createApp } from "../src/server/http.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

let server: Server;
let base: string;
let store: Store;

beforeEach(async () => {
  store = new Store(openDb(":memory:"));
  const app = createApp({ store, sse: new SseHub(), mcp: { store, onChange: () => {} } });
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function connect() {
  const client = new Client({ name: "test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  await client.connect(transport);
  return { client, transport };
}

describe("MCP over HTTP (real SDK client)", () => {
  it("lists the three tools", async () => {
    const { client, transport } = await connect();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(["list_todos", "record_handoff", "update_handoff"]);
    await transport.close();
  });

  it("record_handoff creates a todo via a real tool call", async () => {
    const { client, transport } = await connect();
    await client.callTool({
      name: "record_handoff",
      arguments: { title: "Hand off", note: "ctx", for_who: "Maria" },
    });
    expect(store.listTodos().length).toBe(1);
    expect(store.listTodos()[0].for_who).toBe("Maria");
    await transport.close();
  });
});
