#!/usr/bin/env bun
/** am-cursor: a drop-in wrapper for `cursor-agent` that captures token usage.
 *
 *  Cursor CLI never writes usage to disk and its hooks never carry it; the only
 *  source is cursor-agent's own `--output-format json|stream-json` output. For
 *  headless runs (`-p`/`--print`) this runs cursor-agent with stream-json,
 *  re-renders stdout in the format the caller asked for (byte-identical to what
 *  cursor-agent would have printed), and posts the final `usage` to am-server.
 *  Interactive runs are a plain passthrough.
 *
 *  It must never break the caller's command: parsing is best-effort, the POST
 *  is fire-and-forget with a short timeout, and the exit code is cursor-agent's. */
import { constants } from "node:os";

export type OutputFormat = "text" | "json" | "stream-json";

export function isHeadless(args: string[]): boolean {
  for (const a of args) {
    if (a === "--") return false;
    if (a === "-p" || a === "--print") return true;
  }
  return false;
}

/** Force `--output-format stream-json`, returning the caller's own choice so
 *  stdout can be re-rendered in it. Handles `--output-format X` and
 *  `--output-format=X`; anything after `--` is left alone. */
export function rewriteArgs(args: string[]): { args: string[]; requested: OutputFormat } {
  let requested: OutputFormat = "text";
  const out: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") break;
    if (a === "--output-format") {
      requested = asFormat(args[i + 1]);
      i++;
      continue;
    }
    if (a.startsWith("--output-format=")) {
      requested = asFormat(a.slice("--output-format=".length));
      continue;
    }
    out.push(a);
  }
  return { args: ["--output-format", "stream-json", ...out, ...args.slice(i)], requested };
}

function asFormat(v: string | undefined): OutputFormat {
  return v === "json" || v === "stream-json" ? v : "text";
}

export interface CursorUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Accumulates what a stream-json run reports. `finalText` mirrors text mode,
 *  which prints only the assistant text after the last tool call (verified:
 *  "Checking now." / tool / "All done." prints just "All done."). */
export class StreamState {
  sessionId: string | null = null;
  requestId: string | null = null;
  model: string | null = null;
  usage: CursorUsage | null = null;
  result: Record<string, unknown> | null = null;
  /** Lines that were not JSON, kept so nothing the caller should see is lost. */
  raw: string[] = [];
  private segment = "";

  push(line: string): void {
    if (!line.trim()) return;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      this.raw.push(line);
      return;
    }
    if (typeof o?.session_id === "string") this.sessionId = o.session_id;
    switch (o?.type) {
      case "system":
        if (typeof o.model === "string") this.model = o.model;
        break;
      case "tool_call":
        this.segment = "";
        break;
      case "assistant": {
        const content = Array.isArray(o.message?.content) ? o.message.content : [];
        for (const c of content) if (c?.type === "text" && typeof c.text === "string") this.segment += c.text;
        break;
      }
      case "result":
        this.result = o;
        if (typeof o.request_id === "string") this.requestId = o.request_id;
        if (isUsage(o.usage)) this.usage = o.usage;
        break;
    }
  }

  get finalText(): string {
    if (this.segment) return this.segment;
    return typeof this.result?.result === "string" ? this.result.result : "";
  }
}

function isUsage(u: any): u is CursorUsage {
  return (
    u != null &&
    ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].every((k) => typeof u[k] === "number")
  );
}

/** The key order `--output-format json` prints (the stream's result line
 *  orders `duration_ms` before `is_error`). */
const JSON_KEY_ORDER = ["type", "subtype", "is_error", "duration_ms", "duration_api_ms", "result", "session_id", "request_id", "usage"];

/** What cursor-agent itself would have printed for a buffered format, or null
 *  when there is nothing to print (it printed nothing, e.g. on a model error). */
export function renderBuffered(format: "text" | "json", s: StreamState): string | null {
  const prefix = s.raw.length ? s.raw.join("\n") + "\n" : "";
  if (!s.result) return prefix || null;
  if (format === "text") return prefix + s.finalText + "\n";
  const ordered: Record<string, unknown> = {};
  for (const k of JSON_KEY_ORDER) if (k in s.result) ordered[k] = s.result[k];
  for (const [k, v] of Object.entries(s.result)) if (!(k in ordered)) ordered[k] = v;
  return prefix + JSON.stringify(ordered) + "\n";
}

async function postUsage(s: StreamState): Promise<void> {
  if (!s.sessionId || !s.usage) return;
  const port = process.env.AM_PORT ?? "4317";
  try {
    await fetch(`http://127.0.0.1:${port}/api/usage/cursor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: s.sessionId,
        request_id: s.requestId,
        model: s.model,
        usage: s.usage,
        at: Date.now(),
      }),
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    // Monitoring is best-effort; the caller's command already succeeded or failed on its own.
  }
}

function exitCodeOf(child: { exitCode: number | null; signalCode: string | null }): number {
  if (child.exitCode != null) return child.exitCode;
  const n = child.signalCode ? (constants.signals as Record<string, number>)[child.signalCode] : undefined;
  return n ? 128 + n : 1;
}

async function main(argv: string[]): Promise<number> {
  const bin = process.env.AM_CURSOR_AGENT ?? "cursor-agent";

  if (!isHeadless(argv)) {
    const child = Bun.spawn([bin, ...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    // The terminal delivers Ctrl-C to the whole process group; stay alive so
    // the child's own exit code comes back through us.
    process.on("SIGINT", () => {});
    process.on("SIGTERM", () => child.kill("SIGTERM"));
    await child.exited;
    return exitCodeOf(child);
  }

  const { args, requested } = rewriteArgs(argv);
  const child = Bun.spawn([bin, ...args], { stdin: "inherit", stdout: "pipe", stderr: "inherit" });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));

  const state = new StreamState();
  const decoder = new TextDecoder();
  let buf = "";
  const onLine = (line: string) => {
    state.push(line);
    if (requested === "stream-json") process.stdout.write(line + "\n");
  };
  for await (const chunk of child.stdout) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  buf += decoder.decode();
  if (buf) {
    state.push(buf);
    if (requested === "stream-json") process.stdout.write(buf);
  }
  await child.exited;

  if (requested !== "stream-json") {
    const out = renderBuffered(requested, state);
    if (out) process.stdout.write(out);
  }
  await postUsage(state);
  return exitCodeOf(child);
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
