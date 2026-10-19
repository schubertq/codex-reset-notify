import {eventPhotos} from './media.js';

const RETENTION_MS = 7 * 24 * 3600000;
export const linkedPostID = post => post.referenced_tweets?.find(ref => ref.type === 'replied_to')?.id ??
  post.in_reply_to_tweet_id ?? post.referenced_tweets?.find(ref => ref.type === 'quoted')?.id;

export async function cachePost(post, env, now = Date.now()) {
  await env.DB.prepare('INSERT INTO post_cache(post_id,cached_at,payload) VALUES(?,?,?) ON CONFLICT(post_id) DO UPDATE SET cached_at=excluded.cached_at,payload=excluded.payload')
    .bind(post.id, now, JSON.stringify(post)).run();
}

export async function readPost(id, env, validate, now = Date.now()) {
  const cached = await env.DB.prepare('SELECT payload FROM post_cache WHERE post_id=? AND cached_at>=?').bind(id, now - RETENTION_MS).first();
  if (cached) return validate(JSON.parse(cached.payload));
  if (!env.X_BEARER_TOKEN) throw new Error('Missing context token');
  const response = await fetch(`https://api.x.com/2/tweets/${id}?tweet.fields=author_id,created_at,referenced_tweets,note_tweet,attachments,entities&expansions=attachments.media_keys&media.fields=media_key,type,url`, {
    headers: {Authorization: `Bearer ${env.X_BEARER_TOKEN}`}, signal: AbortSignal.timeout(8000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Context lookup failed');
  const data = await response.json();
  const post = validate(data.data);
  if (post.id !== id) throw new Error('Context identity mismatch');
  const username = data.includes?.users?.find(user => user.id === post.author_id)?.username;
  const result = {...post, photos:eventPhotos(post, data.includes),
    ...(typeof username === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(username) ? {username} : {})};
  await cachePost(result, env, now);
  return result;
}

export async function allPostContext(item, env, validate, now = Date.now()) {
  await cachePost({...item.post, photos:item.photos ?? []}, env, now);
  const id = linkedPostID(item.post);
  if (!id || id === item.post.id) return item;
  if (item.contextPost?.id === id) {
    const contextPost = validate(item.contextPost);
    await cachePost(contextPost, env, now);
    return {...item, contextPost};
  }
  const contextPost = await readPost(id, env, validate, now);
  return contextPost ? {...item, contextPost} : {...item, contextUnavailable:true};
}
