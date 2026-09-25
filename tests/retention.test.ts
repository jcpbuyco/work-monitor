import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import {
  ensureMultiharnessBackup,
  retentionSweep,
  runPendingVacuum,
  BACKUP_MARKER,
  EVENTS_PRUNED_ONCE_MARKER,
  EVENTS_VACUUM_MARKER,
} from "../src/server/retention.ts";

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function freshFileStore(): { store: Store; dbPath: string } {
  dir = mkdtempSync(join(tmpdir(), "am-retention-"));
  const dbPath = join(dir, "am.sqlite");
  return { store: new Store(openDb(dbPath)), dbPath };
}

describe("ensureMultiharnessBackup", () => {
  it("is a no-op for an in-memory DB", () => {
    const store = new Store(openDb(":memory:"));
    const result = ensureMultiharnessBackup(store, ":memory:", 1_700_000_000_000);
    expect(result).toBeNull();
    expect(store.getMeta(BACKUP_MARKER)).toBeNull();
  });

  it("snapshots the DB via VACUUM INTO next to the configured db path, and logs/marks it once", () => {
    const { store, dbPath } = freshFileStore();
    const now = new Date("2026-09-25T00:00:00Z").getTime();
    const path = ensureMultiharnessBackup(store, dbPath, now);
    expect(path).toBe(join(dir!, "am-pre-multiharness-20260925.sqlite"));
    expect(existsSync(path!)).toBe(true);
    expect(store.getMeta(BACKUP_MARKER)).toBe(String(now));
  });

  it("only backs up once, even if called again later", () => {
    const { store, dbPath } = freshFileStore();
    const first = ensureMultiharnessBackup(store, dbPath, 1000);
    expect(first).not.toBeNull();
    const second = ensureMultiharnessBackup(store, dbPath, 2000);
    expect(second).toBeNull();
    expect(store.getMeta(BACKUP_MARKER)).toBe("1000"); // unchanged
  });

  it("marks done instead of throwing when a file already sits at today's backup path (no marker set yet)", () => {
    const { store, dbPath } = freshFileStore();
    const now = new Date("2026-09-25T00:00:00Z").getTime();
    const backupPath = join(dir!, "am-pre-multiharness-20260925.sqlite");
    writeFileSync(backupPath, "not a real sqlite file, just needs to exist");
    expect(() => ensureMultiharnessBackup(store, dbPath, now)).not.toThrow();
    expect(store.getMeta(BACKUP_MARKER)).toBe(String(now));
    // The pre-existing file is left alone, not clobbered by a retried VACUUM INTO.
    expect(readFileSync(backupPath, "utf8")).toBe("not a real sqlite file, just needs to exist");
  });
});

describe("retentionSweep", () => {
  it("deletes events older than retentionMs and keeps newer ones", () => {
    const { store, dbPath } = freshFileStore();
    const now = 1_700_000_000_000;
    const DAY = 24 * 60 * 60 * 1000;
    store.db.query(`INSERT INTO events (session_id, type, payload, at) VALUES ('s', 'activity', '{}', $at)`).run({ $at: now - 40 * DAY });
    store.db.query(`INSERT INTO events (session_id, type, payload, at) VALUES ('s', 'activity', '{}', $at)`).run({ $at: now - 1 * DAY });
    const deleted = retentionSweep(store, dbPath, now, 30 * DAY);
    expect(deleted).toBe(1);
    expect((store.db.query("SELECT COUNT(*) AS n FROM events").get() as any).n).toBe(1);
  });

  it("does NOT mark the first-prune marker when nothing was old enough to delete -- nothing to reclaim yet", () => {
    const { store, dbPath } = freshFileStore();
    const now = 1_700_000_000_000;
    expect(store.getMeta(EVENTS_PRUNED_ONCE_MARKER)).toBeNull();
    const deleted = retentionSweep(store, dbPath, now, 30 * 24 * 60 * 60 * 1000);
    expect(deleted).toBe(0);
    // Marking it here would make runPendingVacuum rewrite the whole file for
    // nothing on the next startup -- leave it unset until a sweep actually
    // deletes something.
    expect(store.getMeta(EVENTS_PRUNED_ONCE_MARKER)).toBeNull();
  });

  it("marks the first-prune marker once a sweep actually deletes rows", () => {
    const { store, dbPath } = freshFileStore();
    const now = 1_700_000_000_000;
    const DAY = 24 * 60 * 60 * 1000;
    store.db.query(`INSERT INTO events (session_id, type, payload, at) VALUES ('s', 'activity', '{}', $at)`).run({ $at: now - 40 * DAY });
    const deleted = retentionSweep(store, dbPath, now, 30 * DAY);
    expect(deleted).toBe(1);
    expect(store.getMeta(EVENTS_PRUNED_ONCE_MARKER)).toBe(String(now));
  });

  it("triggers the one-time backup on its first run", () => {
    const { store, dbPath } = freshFileStore();
    retentionSweep(store, dbPath, 1000, 30 * 24 * 60 * 60 * 1000);
    expect(store.getMeta(BACKUP_MARKER)).toBe("1000");
  });
});

describe("runPendingVacuum", () => {
  it("does nothing before any prune has happened", () => {
    const { store } = freshFileStore();
    expect(runPendingVacuum(store)).toBe(false);
    expect(store.getMeta(EVENTS_VACUUM_MARKER)).toBeNull();
  });

  it("vacuums exactly once after a prune has happened, and never again", () => {
    const { store } = freshFileStore();
    store.setMeta(EVENTS_PRUNED_ONCE_MARKER, "1000");
    expect(runPendingVacuum(store)).toBe(true);
    expect(store.getMeta(EVENTS_VACUUM_MARKER)).not.toBeNull();
    expect(runPendingVacuum(store)).toBe(false);
  });
});
