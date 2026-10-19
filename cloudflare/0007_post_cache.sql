CREATE TABLE post_cache (
  post_id TEXT PRIMARY KEY,
  cached_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX post_cache_time ON post_cache(cached_at);
