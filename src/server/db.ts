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
    CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);
    CREATE TABLE IF NOT EXISTS tool_stats (
      harness TEXT NOT NULL,
      tool TEXT NOT NULL,
      calls INTEGER NOT NULL,
      timed INTEGER NOT NULL,
      total_ms REAL NOT NULL,
      PRIMARY KEY (harness, tool)
    );
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
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT
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
      cost_usd REAL,
      project TEXT,
      branch TEXT,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_id);
    CREATE INDEX IF NOT EXISTS idx_usage_at ON usage(at);
    CREATE TABLE IF NOT EXISTS workflow_runs (
      run_id                TEXT PRIMARY KEY,
      session_id            TEXT NOT NULL,
      project               TEXT,
      branch                TEXT,
      name                  TEXT,
      summary               TEXT,
      status                TEXT,
      error                 TEXT,
      started_at            INTEGER,
      ended_at              INTEGER,
      duration_ms           INTEGER,
      agent_count           INTEGER,
      phases                TEXT,
      cc_version            TEXT,
      manifest_seen         INTEGER NOT NULL DEFAULT 0,
      manifest_mtime        INTEGER,
      last_seen_at          INTEGER,
      dir                   TEXT NOT NULL,
      schema_ok             INTEGER NOT NULL DEFAULT 1,
      total_tokens_reported INTEGER,
      default_model         TEXT,
      total_tool_calls      INTEGER,
      degraded              TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_started ON workflow_runs(started_at);
    CREATE TABLE IF NOT EXISTS subagents (
      agent_id       TEXT PRIMARY KEY,
      session_id     TEXT NOT NULL,
      agent_type     TEXT,
      description    TEXT,
      model          TEXT,
      model_resolved INTEGER NOT NULL DEFAULT 0,
      parent_agent_id TEXT,
      path           TEXT NOT NULL,
      offset         INTEGER NOT NULL DEFAULT 0,
      started_at     INTEGER,
      last_seen_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_subagents_session ON subagents(session_id);
    CREATE TABLE IF NOT EXISTS workflow_agents (
      run_id            TEXT NOT NULL,
      agent_id          TEXT NOT NULL,
      label             TEXT,
      phase_index       INTEGER,
      phase_title       TEXT,
      idx               INTEGER,
      model             TEXT,
      state             TEXT,
      attempt           INTEGER,
      journal_key       TEXT,
      last_tool         TEXT,
      last_tool_summary TEXT,
      prompt_preview    TEXT,
      started_at        INTEGER,
      ended_at          INTEGER,
      duration_ms       INTEGER,
      tool_calls        INTEGER,
      offset            INTEGER NOT NULL DEFAULT 0,
      error             TEXT,
      fallback_model    TEXT,
      PRIMARY KEY (run_id, agent_id)
    );
  `);
  // §3: workflow fidelity columns added after the initial schema.
  const workflowRunCols = db.query("PRAGMA table_info(workflow_runs)").all() as { name: string }[];
  if (!workflowRunCols.some((c) => c.name === "default_model")) {
    db.exec("ALTER TABLE workflow_runs ADD COLUMN default_model TEXT;");
  }
  if (!workflowRunCols.some((c) => c.name === "total_tool_calls")) {
    db.exec("ALTER TABLE workflow_runs ADD COLUMN total_tool_calls INTEGER;");
  }
  if (!workflowRunCols.some((c) => c.name === "degraded")) {
    // JSON object {cause: firstSeenAtMs}, persisted so a restart's forced
    // cross-check pass never re-bumps a cause already recorded for this run.
    db.exec("ALTER TABLE workflow_runs ADD COLUMN degraded TEXT;");
  }
  const workflowAgentCols = db.query("PRAGMA table_info(workflow_agents)").all() as { name: string }[];
  if (!workflowAgentCols.some((c) => c.name === "error")) {
    db.exec("ALTER TABLE workflow_agents ADD COLUMN error TEXT;");
  }
  if (!workflowAgentCols.some((c) => c.name === "fallback_model")) {
    db.exec("ALTER TABLE workflow_agents ADD COLUMN fallback_model TEXT;");
  }
  // §3: recordEvent's live-activity UPDATE (every hook event carrying an
  // agent_id, i.e. every Task/workflow-subagent tool call) and
  // recentActivity's LEFT JOIN both look up workflow_agents by agent_id alone
  // -- without this index that is a full table scan on the hot path, growing
  // with history (the table has no retention).
  db.exec("CREATE INDEX IF NOT EXISTS idx_workflow_agents_agent ON workflow_agents(agent_id);");

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
  if (!sessionCols.some((c) => c.name === "idle_reason")) {
    db.exec("ALTER TABLE sessions ADD COLUMN idle_reason TEXT;");
  }
  // Idempotent: stamp project/branch onto usage rows for historical attribution.
  const usageCols = db.query("PRAGMA table_info(usage)").all() as { name: string }[];
  if (!usageCols.some((c) => c.name === "project")) {
    db.exec("ALTER TABLE usage ADD COLUMN project TEXT;");
  }
  if (!usageCols.some((c) => c.name === "branch")) {
    db.exec("ALTER TABLE usage ADD COLUMN branch TEXT;");
  }
  if (!usageCols.some((c) => c.name === "run_id")) {
    db.exec("ALTER TABLE usage ADD COLUMN run_id TEXT;");
  }
  if (!usageCols.some((c) => c.name === "agent_id")) {
    db.exec("ALTER TABLE usage ADD COLUMN agent_id TEXT;");
  }
  // §2.2: ties every content-block line of one API message together so
  // recordUsage can upsert instead of inserting one priced row per line.
  if (!usageCols.some((c) => c.name === "message_key")) {
    db.exec("ALTER TABLE usage ADD COLUMN message_key TEXT;");
  }
  // §4.1: nullable now (NULL means claude for pre-existing rows); populated by
  // later ingestion work. Added now so that work never needs its own migration.
  if (!usageCols.some((c) => c.name === "harness")) {
    db.exec("ALTER TABLE usage ADD COLUMN harness TEXT;");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_usage_run ON usage(run_id);");
  // Partial: only Claude lines with a `message.id` populate this, and two
  // NULLs never conflict, so pre-message_key historic rows (and any future
  // source that never gets one) are simply never indexed here.
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_message_key ON usage(message_key) WHERE message_key IS NOT NULL;");

  // §2.3: cost_usd becomes nullable (NULL = unpriced, never a silent $0.00).
  // The base CREATE TABLE above already declares it nullable, so a brand-new
  // database never hits this. SQLite has no ALTER COLUMN DROP NOT NULL, so a
  // pre-existing DB (`cost_usd REAL NOT NULL` from before this change) needs a
  // table rebuild instead -- gated on the column's OWN nullability (via
  // PRAGMA), not an app_meta flag, so it runs exactly once per database
  // regardless of when it upgrades and needs no separate one-shot marker.
  // Runs AFTER the ADD COLUMN steps above so every current column can be
  // carried over by name.
  const costCol = (db.query("PRAGMA table_info(usage)").all() as { name: string; notnull: number }[]).find(
    (c) => c.name === "cost_usd"
  );
  if (costCol && costCol.notnull === 1) {
    db.transaction(() => {
      db.exec("ALTER TABLE usage RENAME TO usage_pre_nullable_cost;");
      db.exec(`
        CREATE TABLE usage (
          message_uuid TEXT PRIMARY KEY,
          message_key TEXT,
          session_id TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_create_5m_tokens INTEGER NOT NULL DEFAULT 0,
          cache_create_1h_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL,
          project TEXT,
          branch TEXT,
          at INTEGER NOT NULL,
          run_id TEXT,
          agent_id TEXT,
          harness TEXT
        );
      `);
      db.exec(`
        INSERT INTO usage (message_uuid, message_key, session_id, model, input_tokens, output_tokens,
          cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens, cost_usd, project, branch, at,
          run_id, agent_id, harness)
        SELECT message_uuid, message_key, session_id, model, input_tokens, output_tokens,
          cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens, cost_usd, project, branch, at,
          run_id, agent_id, harness
        FROM usage_pre_nullable_cost;
      `);
      db.exec("DROP TABLE usage_pre_nullable_cost;");
    })();
  }
  // Recreated unconditionally (IF NOT EXISTS): the rebuild above drops every
  // index along with the renamed table, and this must not depend on the
  // top-of-function CREATE INDEX statements having run again in THIS call.
  db.exec("CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_id);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_usage_at ON usage(at);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_usage_run ON usage(run_id);");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_message_key ON usage(message_key) WHERE message_key IS NOT NULL;");
  // Idempotent: real columns for the fields every activity row already carries
  // in its JSON payload, so hot-path reads (recentActivity, toolStats) never
  // need to parse it. A one-time backfill (events-migrate.ts, guarded by
  // app_meta `events_columns_v1`) populates these for pre-existing rows.
  const eventCols = db.query("PRAGMA table_info(events)").all() as { name: string }[];
  if (!eventCols.some((c) => c.name === "tool_name")) {
    db.exec("ALTER TABLE events ADD COLUMN tool_name TEXT;");
  }
  if (!eventCols.some((c) => c.name === "duration_ms")) {
    db.exec("ALTER TABLE events ADD COLUMN duration_ms REAL;");
  }
  if (!eventCols.some((c) => c.name === "agent_id")) {
    db.exec("ALTER TABLE events ADD COLUMN agent_id TEXT;");
  }
  if (!eventCols.some((c) => c.name === "harness")) {
    db.exec("ALTER TABLE events ADD COLUMN harness TEXT;");
  }
  // Matches recentActivity's `WHERE type = 'activity' ORDER BY id DESC LIMIT n`:
  // id is monotonic (AUTOINCREMENT) and cheaper to sort on than `at`.
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_type_id ON events(type, id);");
  // Idempotent: remap legacy hand-off statuses to the generic todo lifecycle.
  db.exec(`UPDATE todos SET status = 'todo' WHERE status IN ('to_hand_off', 'handed_off');`);
}
