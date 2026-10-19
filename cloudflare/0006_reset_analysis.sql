CREATE TABLE reset_analysis (
  post_id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  phase TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX reset_analysis_author_time ON reset_analysis(author_id, created_at DESC);
