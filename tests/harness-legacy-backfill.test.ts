import { describe, it, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import { backfillLegacyHarness, HARNESS_BACKFILL_MARKER } from "../src/server/harness/legacy-backfill.ts";

function cursorPayload(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "c1",
    hook_event_name: "sessionStart",
    cursor_version: "2026.09.23-86fc751",
    model: "grok-4.7",
    workspace_roots: ["/x/legacy-cursor-project"],
    ...extra,
  });
}

describe("backfillLegacyHarness (§4.5)", () => {
  it("marks a session with a cursor-shaped event as harness=cursor and stamps its model", async () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("c1", { status: "ended", project: "legacy-cursor-project", last_activity_at: 1 }, 1);
    store.recordEvent({
      sessionId: "c1",
      type: "session_start",
      payload: cursorPayload(),
      at: 1,
      toolName: null,
      durationMs: null,
      agentId: null,
      harness: "claude", // as it would have been misclassified before §4.2 existed
    });

    const r = await backfillLegacyHarness(store, 1000);
    expect(r.cursorSessions).toBe(1);
    const s = store.getSession("c1")!;
    expect(s.harness).toBe("cursor");
    expect(s.model).toBe("grok-4.7");
  });

  it("stamps harness_version from the event's own cursor_version", async () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("c1", { status: "ended", project: "legacy-cursor-project", last_activity_at: 1 }, 1);
    store.recordEvent({
      sessionId: "c1",
      type: "session_start",
      payload: cursorPayload(),
      at: 1,
      toolName: null,
      durationMs: null,
      agentId: null,
      harness: "claude",
    });

    await backfillLegacyHarness(store, 1000);
    expect(store.getSession("c1")!.harness_version).toBe("2026.09.23-86fc751");
  });

  it("recomputes cwd/project from workspace_roots[0] only when the stored project is still 'unknown'", async () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("c1", { status: "ended", project: "unknown", last_activity_at: 1 }, 1);
    store.recordEvent({
      sessionId: "c1",
      type: "session_start",
      payload: cursorPayload(),
      at: 1,
      toolName: null,
      durationMs: null,
      agentId: null,
      harness: "claude",
    });

    await backfillLegacyHarness(store, 1000);
    const s = store.getSession("c1")!;
    expect(s.cwd).toBe("/x/legacy-cursor-project");
    expect(s.project).toBe("legacy-cursor-project"); // not a real git repo -- basename fallback, same as live ingestion
  });

  it("recomputes project/branch via REAL git resolution, not the branch-directory basename (the worktree bug)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "am-legacy-backfill-wt-"));
    const G = (...args: string[]) =>
      execFileSync("git", args, {
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      });
    const repo = join(dir, "myproj");
    // Initial branch named "trunk" (not "main") so a separate "main" branch
    // can be checked out into its OWN worktree directory below without
    // colliding with the one already checked out in the repo's own workdir.
    G("init", "-q", "-b", "trunk", repo);
    G("-C", repo, "commit", "-q", "--allow-empty", "-m", "init");
    G("-C", repo, "branch", "main");
    // A worktree checked out to a directory literally named "main" -- the
    // bug this guards against used the cwd BASENAME ("main") as the project.
    const worktree = join(repo, "main");
    G("-C", repo, "worktree", "add", "-q", worktree, "main");
    try {
      const store = new Store(openDb(":memory:"));
      store.applyEvent("c1", { status: "ended", project: "unknown", last_activity_at: 1 }, 1);
      store.recordEvent({
        sessionId: "c1",
        type: "session_start",
        payload: cursorPayload({ workspace_roots: [worktree] }),
        at: 1,
        toolName: null,
        durationMs: null,
        agentId: null,
        harness: "claude",
      });

      await backfillLegacyHarness(store, 1000);
      const s = store.getSession("c1")!;
      expect(s.project).toBe("myproj"); // the repo name, not "main" (the worktree dir's basename)
      expect(s.branch).toBe("main");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never overwrites an already-resolved project", async () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("c1", { status: "ended", project: "already-good", cwd: "/x/already-good", last_activity_at: 1 }, 1);
    store.recordEvent({
      sessionId: "c1",
      type: "session_start",
      payload: cursorPayload(),
      at: 1,
      toolName: null,
      durationMs: null,
      agentId: null,
      harness: "claude",
    });

    await backfillLegacyHarness(store, 1000);
    const s = store.getSession("c1")!;
    expect(s.project).toBe("already-good");
    expect(s.cwd).toBe("/x/already-good");
  });

  it("derives parent_session_id from the scratchpad cwd pattern of the (possibly recomputed) cwd", async () => {
    const store = new Store(openDb(":memory:"));
    const scratchpadCwd = "/tmp/claude-1000/-slug/fe6382e2-c797-47f4-badb-da617338ebdf/scratchpad";
    store.applyEvent("c1", { status: "ended", project: "unknown", last_activity_at: 1 }, 1);
    store.recordEvent({
      sessionId: "c1",
      type: "session_start",
      payload: cursorPayload({ workspace_roots: [scratchpadCwd] }),
      at: 1,
      toolName: null,
      durationMs: null,
      agentId: null,
      harness: "claude",
    });

    await backfillLegacyHarness(store, 1000);
    expect(store.getSession("c1")!.parent_session_id).toBe("fe6382e2-c797-47f4-badb-da617338ebdf");
  });

  it("only touches a session once ANY of its events carries cursor_version, even if an earlier one was truncated before it", async () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("c1", { status: "ended", project: "p", last_activity_at: 2 }, 1);
    store.recordEvent({
      sessionId: "c1",
      type: "tool_start",
      payload: JSON.stringify({ session_id: "c1", tool_name: "Shell" }), // truncated tail, no cursor_version visible
      at: 1,
      toolName: "Shell",
      durationMs: null,
      agentId: null,
      harness: "claude",
    });
    store.recordEvent({
      sessionId: "c1",
      type: "activity",
      payload: cursorPayload(),
      at: 2,
      toolName: null,
      durationMs: null,
      agentId: null,
      harness: "claude",
    });

    const r = await backfillLegacyHarness(store, 1000);
    expect(r.cursorSessions).toBe(1);
    expect(store.getSession("c1")!.harness).toBe("cursor");
  });

  it("re-resolves a usage row's project from 'main' via a REAL git resolution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "am-legacy-backfill-git-"));
    const G = (...args: string[]) =>
      execFileSync("git", args, {
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      });
    G("init", "-q", dir);
    G("-C", dir, "commit", "-q", "--allow-empty", "-m", "init");
    try {
      const store = new Store(openDb(":memory:"));
      store.applyEvent("m1", { status: "ended", project: "main", cwd: dir, last_activity_at: 1 }, 1);
      store.recordUsage({
        uuid: "u1",
        sessionId: "m1",
        model: "claude-sonnet-5",
        tokens: { input: 10, output: 5, cache_read: 0, cache_create_5m: 0, cache_create_1h: 0 },
        at: 1,
        cost: 1,
      });
      store.db.run(`UPDATE usage SET project = 'main' WHERE message_uuid = 'u1'`);

      const r = await backfillLegacyHarness(store, 1000);
      expect(r.usageReattributed).toBe(1);
      const row = store.db.query("SELECT project FROM usage WHERE message_uuid = 'u1'").get() as { project: string };
      expect(row.project).toBe(basename(dir)); // the repo's own name, git-resolved
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a usage row on 'main' when git resolution fails (spec: only reattribute a REAL git resolution, never a basename guess)", async () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("m1", { status: "ended", project: "main", cwd: "/x/not-a-real-git-repo", last_activity_at: 1 }, 1);
    store.recordUsage({
      uuid: "u1",
      sessionId: "m1",
      model: "claude-sonnet-5",
      tokens: { input: 10, output: 5, cache_read: 0, cache_create_5m: 0, cache_create_1h: 0 },
      at: 1,
      cost: 1,
    });
    store.db.run(`UPDATE usage SET project = 'main' WHERE message_uuid = 'u1'`);

    const r = await backfillLegacyHarness(store, 1000);
    expect(r.usageReattributed).toBe(0);
    const row = store.db.query("SELECT project FROM usage WHERE message_uuid = 'u1'").get() as { project: string };
    expect(row.project).toBe("main");
  });

  it("leaves a usage row alone when the session has no cwd to resolve from", async () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("m2", { status: "ended", project: "main", last_activity_at: 1 }, 1);
    store.recordUsage({
      uuid: "u2",
      sessionId: "m2",
      model: "claude-sonnet-5",
      tokens: { input: 10, output: 5, cache_read: 0, cache_create_5m: 0, cache_create_1h: 0 },
      at: 1,
      cost: 1,
    });
    store.db.run(`UPDATE usage SET project = 'main' WHERE message_uuid = 'u2'`);

    const r = await backfillLegacyHarness(store, 1000);
    expect(r.usageReattributed).toBe(0);
    const row = store.db.query("SELECT project FROM usage WHERE message_uuid = 'u2'").get() as { project: string };
    expect(row.project).toBe("main");
  });

  it("is idempotent - a second run is a no-op guarded by app_meta", async () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("c1", { status: "ended", project: "unknown", last_activity_at: 1 }, 1);
    store.recordEvent({
      sessionId: "c1",
      type: "session_start",
      payload: cursorPayload(),
      at: 1,
      toolName: null,
      durationMs: null,
      agentId: null,
      harness: "claude",
    });

    await backfillLegacyHarness(store, 1000);
    const again = await backfillLegacyHarness(store, 2000);
    expect(again).toEqual({ cursorSessions: 0, usageReattributed: 0 });
    expect(store.getMeta(HARNESS_BACKFILL_MARKER)).toBe("1000");
  });

  it("does nothing on a database with no legacy cursor events or 'main' usage", async () => {
    const store = new Store(openDb(":memory:"));
    const r = await backfillLegacyHarness(store, 1000);
    expect(r).toEqual({ cursorSessions: 0, usageReattributed: 0 });
  });
});
