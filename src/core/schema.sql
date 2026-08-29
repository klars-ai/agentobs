-- AgentObs local schema. Applied idempotently on every open() via
-- migrations in db.ts, so a fresh install and an upgrade take the same
-- path. Timestamps are ISO-8601 UTC strings throughout - SQLite has no
-- native date type, and storing text keeps rows readable in a plain
-- `sqlite3` shell during support/debugging.

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  agent_name        TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  ended_at          TEXT,
  cwd               TEXT,
  git_branch        TEXT,
  total_tokens_in   INTEGER NOT NULL DEFAULT 0,
  total_tokens_out  INTEGER NOT NULL DEFAULT 0,
  total_cost_usd    REAL,
  tool_call_count   INTEGER NOT NULL DEFAULT 0,
  error_count       INTEGER NOT NULL DEFAULT 0,
  blocked_count     INTEGER NOT NULL DEFAULT 0,
  -- Fidelity of this session's data, so the dashboard can be honest about
  -- what it does and doesn't know rather than implying detail it lacks:
  --   "rich"   - per-tool-call detail (hook-based adapters)
  --   "coarse" - session duration/exit code only (process-wrap)
  fidelity          TEXT NOT NULL DEFAULT 'rich',
  exit_code         INTEGER,
  -- Cloud-sync columns. Present from the start so the local schema never
  -- needs a breaking migration when sync ships; null until logged in.
  device_id         TEXT,
  account_id        TEXT,
  updated_at        TEXT NOT NULL,
  synced_at         TEXT
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  tool_name       TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  duration_ms     INTEGER,
  status          TEXT NOT NULL,          -- success | error | pending | blocked
  input_summary   TEXT,                   -- truncated + secret-redacted
  output_summary  TEXT,                   -- truncated + secret-redacted
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  cost_usd        REAL,
  model           TEXT,
  error_message   TEXT,
  updated_at      TEXT NOT NULL,
  synced_at       TEXT
);

CREATE TABLE IF NOT EXISTS policy_decisions (
  id             TEXT PRIMARY KEY,
  tool_call_id   TEXT REFERENCES tool_calls(id),
  session_id     TEXT,
  tool_name      TEXT,
  rule_matched   TEXT,                    -- null when default_decision applied
  decision       TEXT NOT NULL,           -- allow | block | needs_approval
  reason         TEXT,
  decided_at     TEXT NOT NULL,
  synced_at      TEXT
);

-- Single-row table holding this install's identity and local settings.
CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_session   ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_started   ON tool_calls(started_at);
CREATE INDEX IF NOT EXISTS idx_tool_calls_status    ON tool_calls(status);
CREATE INDEX IF NOT EXISTS idx_tool_calls_unsynced  ON tool_calls(synced_at) WHERE synced_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_started     ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_unsynced    ON sessions(synced_at) WHERE synced_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_policy_tool_call     ON policy_decisions(tool_call_id);
CREATE INDEX IF NOT EXISTS idx_policy_decided       ON policy_decisions(decided_at);
