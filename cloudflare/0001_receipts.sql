CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('pending', 'sent', 'filtered', 'expired')),
  lease_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  message_id TEXT
);
