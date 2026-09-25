import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const HOOK_PATH = join(import.meta.dir, "..", "src", "hooks", "am-hook.sh");

/** am-hook.sh backgrounds its POST and exits immediately (fire-and-forget by
 *  design), so the request can arrive slightly after the script itself has
 *  already returned - this captures the first request the server sees within
 *  a short timeout instead of assuming it has already landed. */
function captureOneRequest(port: number): { server: Server; received: Promise<{ url: string; method: string; contentType: string | undefined; body: string }> } {
  let resolve!: (v: { url: string; method: string; contentType: string | undefined; body: string }) => void;
  const received = new Promise<{ url: string; method: string; contentType: string | undefined; body: string }>((r) => (resolve = r));
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      resolve({ url: req.url ?? "", method: req.method ?? "", contentType: req.headers["content-type"], body });
      res.writeHead(200).end("ok");
    });
  });
  server.listen(port, "127.0.0.1");
  return { server, received };
}

/** Base env for every hook invocation in this file: this test itself runs
 *  inside a real Claude Code (or Codex) session, so `process.env` already
 *  carries a real `CLAUDE_CODE_SESSION_ID`/`CODEX_THREAD_ID` - strip both so
 *  a test only sees the ones it explicitly sets. */
function baseEnv(): Record<string, string | undefined> {
  const { CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID, ...rest } = process.env;
  return rest;
}

function runHook(args: string[], stdin: string, env: Record<string, string>): void {
  execFileSync("sh", [HOOK_PATH, ...args], {
    input: stdin,
    env: { ...baseEnv(), ...env },
    timeout: 2000,
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms)),
  ]);
}

describe("am-hook.sh (§4.2)", () => {
  let port: number;
  let server: Server;

  beforeEach(() => {
    port = 20000 + Math.floor(Math.random() * 10000);
  });

  afterEach(() => {
    server?.close();
  });

  it("prints nothing on stdout and exits 0 (Cursor treats non-empty stdout as a hook decision)", () => {
    const cap = captureOneRequest(port);
    server = cap.server;
    const out = execFileSync("sh", [HOOK_PATH, "session_start"], {
      input: "{}",
      env: { ...baseEnv(), AM_PORT: String(port) },
    });
    expect(out.toString()).toBe("");
    return withTimeout(cap.received, 2000, "the POST");
  });

  it("POSTs the raw stdin payload as the JSON body with the type in the query string", async () => {
    const cap = captureOneRequest(port);
    server = cap.server;
    runHook(["tool_start"], '{"tool_name":"Bash"}', { AM_PORT: String(port) });
    const req = await withTimeout(cap.received, 2000, "the POST");
    expect(req.method).toBe("POST");
    expect(req.contentType).toBe("application/json");
    expect(req.body).toBe('{"tool_name":"Bash"}');
    expect(req.url).toContain("type=tool_start");
  });

  it("appends &harness=<arg> only when a harness arg is given", async () => {
    const cap = captureOneRequest(port);
    server = cap.server;
    runHook(["notification", "codex"], "{}", { AM_PORT: String(port) });
    const req = await withTimeout(cap.received, 2000, "the POST");
    expect(req.url).toBe("/events?type=notification&harness=codex");
  });

  it("omits harness entirely (no stray '&harness=') when no harness arg is given", async () => {
    const cap = captureOneRequest(port);
    server = cap.server;
    runHook(["stop"], "{}", { AM_PORT: String(port) });
    const req = await withTimeout(cap.received, 2000, "the POST");
    expect(req.url).toBe("/events?type=stop");
  });

  it("stamps pcc from CLAUDE_CODE_SESSION_ID and pcx from CODEX_THREAD_ID when set", async () => {
    const cap = captureOneRequest(port);
    server = cap.server;
    runHook(["activity"], "{}", {
      AM_PORT: String(port),
      CLAUDE_CODE_SESSION_ID: "11111111-1111-1111-1111-111111111111",
      CODEX_THREAD_ID: "22222222-2222-2222-2222-222222222222",
    });
    const req = await withTimeout(cap.received, 2000, "the POST");
    expect(req.url).toBe(
      "/events?type=activity&pcc=11111111-1111-1111-1111-111111111111&pcx=22222222-2222-2222-2222-222222222222"
    );
  });

  it("URL-encodes pcc/pcx (spec §4.2) instead of splicing them raw into the query string", async () => {
    const cap = captureOneRequest(port);
    server = cap.server;
    // A value chosen to prove real percent-encoding, not merely "happens to
    // work for UUIDs": '&'/'=' would otherwise inject bogus extra params.
    runHook(["activity"], "{}", { AM_PORT: String(port), CLAUDE_CODE_SESSION_ID: "abc def&x=1" });
    const req = await withTimeout(cap.received, 2000, "the POST");
    const url = new URL(req.url, "http://127.0.0.1");
    expect(url.searchParams.get("pcc")).toBe("abc def&x=1"); // decodes back to the exact original value
    expect(url.searchParams.get("x")).toBeNull(); // never became its own top-level param
  });

  it("is silent and exits 0 even with no server listening on AM_PORT (fire-and-forget)", () => {
    const out = execFileSync("sh", [HOOK_PATH, "session_start"], {
      input: "{}",
      env: { ...baseEnv(), AM_PORT: "1" }, // nothing listening
      timeout: 2000,
    });
    expect(out.toString()).toBe("");
  });
});
