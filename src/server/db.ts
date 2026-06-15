import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL DEFAULT 'unknown',
      cwd TEXT NOT NULL DEFAULT '',
      transcript_path TEXT,
      status TEXT NOT NULL DEFAULT 'working',
      current_task TEXT,
      current_intent TEXT,
      attention_reason TEXT,
      active_tool TEXT,
      branch TEXT,
      started_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_type_at ON events(type, at);
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      for_who TEXT,
      status TEXT NOT NULL DEFAULT 'todo',
      origin_session_id TEXT,
      origin_project TEXT,
      branch TEXT,
      links TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage (
      message_uuid TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_create_5m_tokens INTEGER NOT NULL DEFAULT 0,
      cache_create_1h_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL,
      project TEXT,
      branch TEXT,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_id);
    CREATE INDEX IF NOT EXISTS idx_usage_at ON usage(at);
  `);
  // Idempotent: add columns added after the initial schema to pre-existing DBs.
  const sessionCols = db.query("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!sessionCols.some((c) => c.name === "branch")) {
    db.exec("ALTER TABLE sessions ADD COLUMN branch TEXT;");
  }
  if (!sessionCols.some((c) => c.name === "active_tool")) {
    db.exec("ALTER TABLE sessions ADD COLUMN active_tool TEXT;");
  }
  if (!sessionCols.some((c) => c.name === "usage_offset")) {
    db.exec("ALTER TABLE sessions ADD COLUMN usage_offset INTEGER NOT NULL DEFAULT 0;");
  }
  // Idempotent: stamp project/branch onto usage rows for historical attribution.
  const usageCols = db.query("PRAGMA table_info(usage)").all() as { name: string }[];
  if (!usageCols.some((c) => c.name === "project")) {
    db.exec("ALTER TABLE usage ADD COLUMN project TEXT;");
  }
  if (!usageCols.some((c) => c.name === "branch")) {
    db.exec("ALTER TABLE usage ADD COLUMN branch TEXT;");
  }
  // Idempotent: remap legacy hand-off statuses to the generic todo lifecycle.
  db.exec(`UPDATE todos SET status = 'todo' WHERE status IN ('to_hand_off', 'handed_off');`);
}
