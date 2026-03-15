-- X-note Cloud Sync D1 Schema

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  picture TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_sync_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS user_data (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  data BLOB NOT NULL,
  version INTEGER DEFAULT 1,
  data_hash TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
