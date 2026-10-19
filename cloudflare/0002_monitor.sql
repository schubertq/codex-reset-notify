CREATE TABLE delivery_watch (
  id TEXT PRIMARY KEY,
  queued_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX delivery_watch_time ON delivery_watch(queued_at);
CREATE TABLE monitor_incidents (
  key TEXT PRIMARY KEY,
  active INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  notified_active INTEGER NOT NULL DEFAULT 0,
  notified_revision INTEGER NOT NULL DEFAULT 0,
  changed_at INTEGER NOT NULL,
  message_id TEXT
);
CREATE TABLE monitor_clock (key TEXT PRIMARY KEY, next_at INTEGER NOT NULL);
