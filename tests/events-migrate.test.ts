import { describe, it, expect } from "bun:test";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import { backfillEventsColumns, EVENTS_COLUMNS_MARKER } from "../src/server/events-migrate.ts";

function insertRaw(store: Store, row: { type: string; payload: string; at?: number; session_id?: string }): number {
  const res = store.db
    .query(`INSERT INTO events (session_id, type, payload, at) VALUES ($s, $t, $p, $a)`)
    .run({ $s: row.session_id ?? "s1", $t: row.type, $p: row.payload, $a: row.at ?? 1000 });
  return Number(res.lastInsertRowid);
}

describe("backfillEventsColumns", () => {
  it("populates columns from valid JSON payloads", () => {
    const store = new Store(openDb(":memory:"));
    const id = insertRaw(store, {
      type: "activity",
      payload: JSON.stringify({ tool_name: "Bash", duration_ms: 250, agent_id: "a1" }),
    });
    backfillEventsColumns(store, 5000);
    const row = store.db.query("SELECT tool_name, duration_ms, agent_id, harness FROM events WHERE id = $id").get({ $id: id }) as any;
    expect(row).toEqual({ tool_name: "Bash", duration_ms: 250, agent_id: "a1", harness: "claude" });
  });

  it("recovers tool_name/agent_id from truncated (invalid) JSON via regex, leaves duration_ms null", () => {
    const store = new Store(openDb(":memory:"));
    // Simulate the historic 8000-char truncation: valid start, cut off mid-object.
    const truncated = `{"session_id":"s1","tool_name":"Read","agent_id":"agent-42","tool_input":{"file_path":"/x/very/long/path/that/got/cu`;
    expect(() => JSON.parse(truncated)).toThrow();
    const id = insertRaw(store, { type: "activity", payload: truncated });
    backfillEventsColumns(store, 5000);
    const row = store.db.query("SELECT tool_name, duration_ms, agent_id FROM events WHERE id = $id").get({ $id: id }) as any;
    expect(row).toEqual({ tool_name: "Read", duration_ms: null, agent_id: "agent-42" });
  });

  it("classifies harness from cursor_version even on invalid JSON, when the field survives truncation", () => {
    const store = new Store(openDb(":memory:"));
    const truncated = `{"cursor_version":"1.2.3","tool_name":"beforeReadFile","tool_input":{"junk`;
    const id = insertRaw(store, { type: "activity", payload: truncated });
    backfillEventsColumns(store, 5000);
    const row = store.db.query("SELECT harness FROM events WHERE id = $id").get({ $id: id }) as any;
    expect(row.harness).toBe("cursor");
  });

  it("propagates harness=cursor across a whole session, since real Cursor payloads put cursor_version AFTER tool_input/tool_output and truncation can cut it off", () => {
    const store = new Store(openDb(":memory:"));
    // Real Cursor payloads are shaped tool_input/tool_output first, then
    // cursor_version near the end -- the old 8000-char truncation cut this
    // one off before it ever got there, so the per-row pass alone (and even
    // the regex fallback) would tag it "claude".
    const truncated = `{"session_id":"s-cur","tool_name":"Shell","tool_input":{"command":"${"x".repeat(200)}`;
    expect(() => JSON.parse(truncated)).toThrow();
    expect(truncated).not.toContain("cursor_version");
    const truncatedId = insertRaw(store, { session_id: "s-cur", type: "activity", payload: truncated });
    // A short, un-truncated row in the SAME session still carries the signal
    // (e.g. a small hook payload that never approached the truncation cap).
    insertRaw(store, {
      session_id: "s-cur",
      type: "session_start",
      payload: JSON.stringify({ cursor_version: "1.2.3" }),
    });
    backfillEventsColumns(store, 5000);
    const row = store.db.query("SELECT harness FROM events WHERE id = $id").get({ $id: truncatedId }) as any;
    expect(row.harness).toBe("cursor");
  });

  it("rebuilds tool_stats using the session-corrected harness, not the raw per-row guess", () => {
    const store = new Store(openDb(":memory:"));
    const truncated = `{"session_id":"s-cur","tool_name":"Shell","tool_input":{"command":"${"x".repeat(200)}`;
    insertRaw(store, { session_id: "s-cur", type: "activity", payload: truncated });
    insertRaw(store, {
      session_id: "s-cur",
      type: "session_start",
      payload: JSON.stringify({ cursor_version: "1.2.3" }),
    });
    backfillEventsColumns(store, 5000);
    const claudeShell = store.db
      .query("SELECT calls FROM tool_stats WHERE harness = 'claude' AND tool = 'Shell'")
      .get();
    expect(claudeShell).toBeNull(); // no leftover mis-tagged row
    const cursorShell = store.db
      .query("SELECT calls FROM tool_stats WHERE harness = 'cursor' AND tool = 'Shell'")
      .get() as any;
    expect(cursorShell).toEqual({ calls: 1 });
  });

  it("handles a null payload without throwing", () => {
    const store = new Store(openDb(":memory:"));
    const id = insertRaw(store, { type: "session_start", payload: null as unknown as string });
    expect(() => backfillEventsColumns(store, 5000)).not.toThrow();
    const row = store.db.query("SELECT tool_name, harness FROM events WHERE id = $id").get({ $id: id }) as any;
    expect(row).toEqual({ tool_name: null, harness: "claude" });
  });

  it("rebuilds tool_stats from the now-populated columns, grouped by (harness, tool)", () => {
    const store = new Store(openDb(":memory:"));
    insertRaw(store, { type: "activity", payload: JSON.stringify({ tool_name: "Bash", duration_ms: 100 }) });
    insertRaw(store, { type: "activity", payload: JSON.stringify({ tool_name: "Bash", duration_ms: 300 }) });
    insertRaw(store, { type: "activity", payload: JSON.stringify({ tool_name: "Bash" }) }); // untimed
    insertRaw(store, { type: "tool_start", payload: JSON.stringify({ tool_name: "Bash" }) }); // not an activity row
    backfillEventsColumns(store, 5000);
    const row = store.db.query("SELECT calls, timed, total_ms FROM tool_stats WHERE harness='claude' AND tool='Bash'").get() as any;
    expect(row).toEqual({ calls: 3, timed: 2, total_ms: 400 });
  });

  it("is guarded by the marker: a second call is a no-op", () => {
    const store = new Store(openDb(":memory:"));
    insertRaw(store, { type: "activity", payload: JSON.stringify({ tool_name: "Bash", duration_ms: 100 }) });
    const first = backfillEventsColumns(store, 5000);
    expect(first.updated).toBe(1);
    expect(store.getMeta(EVENTS_COLUMNS_MARKER)).toBe("5000");
    // A fresh un-migrated row inserted after the marker is set must NOT be
    // touched by a second call -- it's a one-time historic backfill only.
    const id2 = insertRaw(store, { type: "activity", payload: JSON.stringify({ tool_name: "Read", duration_ms: 5 }) });
    const second = backfillEventsColumns(store, 9000);
    expect(second.updated).toBe(0);
    expect(store.getMeta(EVENTS_COLUMNS_MARKER)).toBe("5000"); // unchanged
    const row = store.db.query("SELECT tool_name FROM events WHERE id = $id").get({ $id: id2 }) as any;
    expect(row.tool_name).toBeNull();
  });
});
