const RETENTION_MS = 7 * 24 * 3600000;

export async function pruneCardSnapshots(env, now = Date.now()) {
  await env.DB.prepare('DELETE FROM post_cache WHERE cached_at<?').bind(now - RETENTION_MS).run();
  await env.DB.prepare('DELETE FROM reset_analysis WHERE created_at<?').bind(now - RETENTION_MS).run();
  // 仅按原保留期限清理旧版本留下的快照，不修改已经发送的群消息。
  await env.DB.prepare('DELETE FROM reset_cards WHERE created_at<?').bind(now - RETENTION_MS).run();
}
