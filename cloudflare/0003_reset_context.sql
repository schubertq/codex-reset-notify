CREATE TABLE reset_context (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('announced', 'completed', 'inferred')),
  anchor_id TEXT
);
CREATE INDEX reset_context_author_time ON reset_context(author_id, created_at DESC);
