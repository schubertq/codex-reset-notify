CREATE TABLE reset_cards (
  post_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  state TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_by TEXT
);
CREATE INDEX reset_cards_event ON reset_cards(event_id, state, created_at);
