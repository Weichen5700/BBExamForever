-- localStorage 同步用的 key/value 表
CREATE TABLE IF NOT EXISTS sync_entries (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
