PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO meta(key, value) VALUES('schema_version', '1');

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  title TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  parent_id TEXT,

  runner TEXT,
  inputs_json TEXT NOT NULL DEFAULT '[]',
  ownership_json TEXT NOT NULL DEFAULT '[]',
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  verify_json TEXT NOT NULL DEFAULT '[]',
  retry_policy_json TEXT NOT NULL DEFAULT '{"maxAttempts":3}',
  attempts INTEGER NOT NULL DEFAULT 0,

  blocked_until TEXT,

  lock_run_id TEXT,
  lock_started_at TEXT,
  lock_pid INTEGER,
  lock_host TEXT,

  checkpoint_json TEXT,

  auto_reset_count INTEGER NOT NULL DEFAULT 0,
  last_auto_reset_at TEXT,
  manual_reset_count INTEGER NOT NULL DEFAULT 0,
  last_manual_reset_at TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);

CREATE TABLE IF NOT EXISTS deps (
  node_id TEXT NOT NULL,
  depends_on_id TEXT NOT NULL,
  required_status TEXT NOT NULL DEFAULT 'done',
  PRIMARY KEY(node_id, depends_on_id),
  FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE,
  FOREIGN KEY(depends_on_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_deps_depends_on ON deps(depends_on_id);

CREATE TABLE IF NOT EXISTS kv_latest (
  node_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_text TEXT,
  artifact_path TEXT,
  artifact_sha256 TEXT,
  fingerprint_json TEXT,
  run_id TEXT,
  attempt INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(node_id, key)
);

CREATE TABLE IF NOT EXISTS kv_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_text TEXT,
  artifact_path TEXT,
  artifact_sha256 TEXT,
  fingerprint_json TEXT,
  run_id TEXT,
  attempt INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kv_history_node_key ON kv_history(node_id, key, id);
