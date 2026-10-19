import {effectiveSchedule} from './schedule.js';
import {cardText, quoteCard, resetMetadata, originalExcerpt, translatedBody, scheduleBasis} from './presentation.js';
import {translateChinese} from './translation.js';
import {classifyReset, linkedContext, semanticStyle, SEMANTIC_VERSION} from './semantic.js';
import {pruneCardSnapshots} from './lifecycle.js';
import {watchDelivery, deliveryFailed, setIncident, monitor} from './monitor.js';
import {hasMedia, eventPhotos, hasText, uploadPhotos} from './media.js';
import {allPostContext, readPost, linkedPostID} from './post-context.js';

const WINDOW_MS = 6 * 3600 * 1000;
const MAX_BYTES = 96000;
const encoder = new TextEncoder();
const json = (body, status = 200) => Response.json(body, {status, headers: {'Cache-Control': 'no-store'}});
const log = (event, fields = {}) => console.log(JSON.stringify({log_key: 'TiboResetRadar', event, ...fields}));
const validID = value => typeof value === 'string' && /^[0-9]{1,30}$/.test(value);
export function timestamp(value) {
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Invalid timestamp');
  return Date.parse(value);
}
export function postText(post) {
  const text = post.note_tweet?.text ?? post.text;
  if (typeof text !== 'string' || (!text.trim() && !hasMedia(post)) || text.length > 32000) throw new Error('Invalid text');
  return text;
}
export function validatePost(post) {
  if (!post || !validID(post.id) || !validID(post.author_id)) throw new Error('Invalid post');
  timestamp(post.created_at);
  postText(post);
  if (post.referenced_tweets !== undefined && (!Array.isArray(post.referenced_tweets) ||
      post.referenced_tweets.some(ref => !ref || !validID(ref.id) || !['replied_to', 'quoted', 'retweeted'].includes(ref.type)))) throw new Error('Invalid references');
  if (post.in_reply_to_tweet_id !== undefined && !validID(post.in_reply_to_tweet_id)) throw new Error('Invalid reply');
  return post;
}
export function parsePost(envelope, userID, start) {
  const event = envelope?.data;
  if (!event || typeof event.event_type !== 'string') throw new Error('Invalid event');
  if (event.event_type !== 'post.create') return null;
  if (event.filter?.user_id !== userID || event.payload?.author_id !== userID) return null;
  const post = validatePost(event.payload);
  if (timestamp(post.created_at) < start) return null;
  return post;
}
const parentID = post => post.referenced_tweets?.find(ref => ref.type === 'replied_to')?.id ?? post.in_reply_to_tweet_id;
const contextID = post => parentID(post) ?? post.referenced_tweets?.find(ref => ref.type === 'quoted')?.id;
async function analyzeReset(item, env, context, classify) {
  const cached = await env.DB.prepare('SELECT payload FROM reset_analysis WHERE post_id=?').bind(item.post.id).first();
  if (cached) return {...item, ...JSON.parse(cached.payload)};
  if (item.post.referenced_tweets?.some(ref => ref.type === 'retweeted')) return null;
  let parents = [], recent, contextUnavailable = false, contextError;
  if (contextID(item.post)) {
    try { parents = linkedContext(item.post, await context(item.post, env)); }
    catch (error) { contextError = error; contextUnavailable = true; }
  }
  let semantic = await classify(item.post, parents, env.AI, {complete: Boolean(contextID(item.post)) && !contextError});
  if (contextError && semantic.needs_context) throw contextError;
  if (!contextID(item.post) && semantic.needs_context) {
    const prior = await env.DB.prepare("SELECT phase,payload FROM reset_analysis WHERE author_id=? AND created_at>=? AND created_at<=? AND phase<>'none' ORDER BY created_at DESC,post_id DESC LIMIT 1")
      .bind(item.post.author_id, item.created - WINDOW_MS, item.created).first();
    if (prior && ['announced', 'in_progress'].includes(prior.phase)) recent = JSON.parse(prior.payload).post;
    semantic = await classify(item.post, [], env.AI, {recent, complete: true});
  }
  if (contextUnavailable) log('context_unavailable', {id: item.id});
  const contextPost = parents.find(parent => parent.id === semantic.context_id);
  const result = {post: {...item.post, ...(item.photos?.length ? {photos:item.photos} : {})}, semantic, ...(contextPost ? {contextPost} : {}),
    ...(recent && semantic.context_id === recent.id ? {inferredFrom: {id: recent.id}} : {}),
    ...(contextUnavailable ? {contextUnavailable: true} : {})};
  await env.DB.prepare('INSERT INTO reset_analysis(post_id,author_id,created_at,phase,payload) VALUES(?,?,?,?,?) ON CONFLICT(post_id) DO NOTHING')
    .bind(item.post.id, item.post.author_id, item.created, semantic.phase, JSON.stringify(result)).run();
  log('semantic_classified', {id: item.id, phase: semantic.phase, version: SEMANTIC_VERSION});
  return {...item, ...result};
}
async function key(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign', 'verify']);
}
export async function signature(secret, bytes) {
  return 'sha256=' + btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), bytes))));
}
async function verify(secret, bytes, supplied) {
  if (!/^sha256=[A-Za-z0-9+/]{43}=$/.test(supplied ?? '')) return false;
  const digest = Uint8Array.from(atob(supplied.slice(7)), char => char.charCodeAt(0));
  return crypto.subtle.verify('HMAC', await key(secret), digest, bytes);
}
async function secretEqual(expected, actual) {
  // 用 HMAC 校验避免直接字符串比较泄露匹配前缀。
  return verify(expected, encoder.encode(actual), await signature(expected, encoder.encode(expected)));
}
async function readBody(request) {
  if (Number(request.headers.get('Content-Length')) > MAX_BYTES) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
function xConfig(env) {
  if (!env.X_OAUTH2_CLIENT_SECRET || !validID(env.X_TIBO_USER_ID)) throw new Error('Missing X config');
  return timestamp(env.X_SUBSCRIPTION_START_AT);
}
export async function receive(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET') return json({service: 'codex-reset-notify', x_enabled: env.X_ENABLED === 'true'});
  if (url.pathname === '/admin/smoke' && request.method === 'POST') {
    if (!env.SMOKE_TEST_TOKEN || !env.SMOKE_TEST_ID) return json({error: 'Disabled'}, 404);
    const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
    if (!await secretEqual(env.SMOKE_TEST_TOKEN, token)) return json({error: 'Unauthorized'}, 401);
    // 固定内容和固定测试 ID；重复调用只会重试同一条测试消息。
    await env.NOTIFICATIONS.send({kind: 'smoke', id: 'smoke-' + env.SMOKE_TEST_ID, created: Date.now()});
    return json({accepted: true}, 202);
  }
  if (url.pathname !== '/webhooks/x') return json({error: 'Not found'}, 404);
  if (request.method === 'GET') {
    // 注册回调先验证地址；事件消费仍独立受 X_ENABLED 和完整配置保护。
    if (!env.X_OAUTH2_CLIENT_SECRET) return json({error: 'X integration disabled'}, 503);
    const token = url.searchParams.get('crc_token');
    if (!token || token.length > 4096) return json({error: 'Invalid CRC'}, 400);
    return json({response_token: await signature(env.X_OAUTH2_CLIENT_SECRET, encoder.encode(token))});
  }
  if (env.X_ENABLED !== 'true') return json({error: 'X integration disabled'}, 503);
  const start = xConfig(env);
  if (request.method !== 'POST') return json({error: 'Method not allowed'}, 405);
  const bytes = await readBody(request);
  if (bytes === null) return json({error: 'Body too large'}, 413);
  if (!await verify(env.X_OAUTH2_CLIENT_SECRET, bytes, request.headers.get('X-Twitter-Webhooks-Signature-OAuth2'))) return json({error: 'Invalid signature'}, 401);
  let post, photos, contextPost;
  try {
    const envelope = JSON.parse(new TextDecoder().decode(bytes));
    post = parsePost(envelope, env.X_TIBO_USER_ID, start);
    photos = post ? eventPhotos(post, envelope.data.includes) : [];
    const included = envelope.data.includes?.tweets?.find(value => value.id === linkedPostID(post ?? {}));
    if (included) contextPost = {...validatePost(included), photos:eventPhotos(included, envelope.data.includes)};
  }
  catch { return json({error: 'Invalid event'}, 400); }
  // 必须等待持久队列确认，失败时返回 503 供上游重试。
  if (post) {
    const created = timestamp(post.created_at);
    const enqueue = async value => {
      await watchDelivery(env, value.id);
      await env.NOTIFICATIONS.send(value);
    };
    try {
      if (env.ALL_POSTS_CHAT_ID && created >= timestamp(env.ALL_POSTS_START_AT)) {
        await enqueue({kind: 'x-all', id: 'x-all-' + post.id, created, post, photos, ...(contextPost ? {contextPost} : {})});
      }
      await enqueue({kind: 'x', id: 'x-' + post.id, created, post, photos});
      await setIncident(env, 'receiver', false);
    } catch (error) {
      await setIncident(env, 'receiver', true).catch(() => {});
      throw error;
    }
  }
  return json({accepted: true});
}
async function requestJSON(url, init = {}) {
  const response = await fetch(url, {...init, signal: AbortSignal.timeout(12000)});
  if (!response.ok) throw new Error('Upstream HTTP failure');
  return response.json();
}
async function ancestors(post, env) {
  const parents = [];
  const seen = new Set([post.id]);
  let current = post;
  for (let i = 0; i < 3; i++) {
    const id = contextID(current);
    if (!id || seen.has(id)) break;
    seen.add(id);
    const cached = await env.DB.prepare('SELECT payload FROM reset_analysis WHERE post_id=?').bind(id).first();
    let parent;
    if (cached) parent = validatePost(JSON.parse(cached.payload).post);
    else {
      parent = await readPost(id, env, validatePost);
      if (!parent) break;
    }
    if (parent.id !== id) break;
    parents.push(parent);
    current = parent;
  }
  return parents;
}
export function card(item) {
  const all = item.kind.endsWith('-all');
  const test = item.kind === 'smoke' || item.kind === 'smoke-all';
  const text = test ? all ? '这是一条卡片样式测试，不是真实 X 帖子。\n后续 Tibo 的全部新动态会以中文卡片展示，并附北京时间和查看原帖按钮。' : '这是一条云端链路测试消息，不代表发生重置，也不是真实 X 帖子。\n本次仅验证 Cloudflare 接收 → 持久队列 → 去重 → 飞书群。\nX 订阅和官方回调需通过真实新帖另行验证。' : postText(item.post);
  // 全部动态的时间标签只解析明确写出 reset 的正文，不参与重置群筛选或状态判断。
  const schedule = test || (all && !/\breset(?:s|ting)?\b|重置/i.test(text)) ? null : effectiveSchedule(text, item.post.created_at);
  const style = test ? {color: 'blue', title: all ? 'Tibo 全部动态｜卡片样式测试' : 'Codex 重置通知｜云端链路测试'} : all ? {color: 'blue', title: 'Tibo 全部动态｜' + (item.post.referenced_tweets?.some(ref => ref.type === 'retweeted') ? '转帖' : parentID(item.post) ? '回复' : '新帖')} : semanticStyle(item.semantic);
  const elements = [];
  const metadata = !test && !all && resetMetadata(item);
  if (metadata) elements.push({tag: 'div', text: {tag: 'lark_md', content: metadata}});
  if (item.inferredFrom) elements.push({tag: 'div', text: {tag: 'lark_md', content: `关联推断：此独立短帖未说明完成对象，不是明确的重置完成确认。[查看关联预告](https://x.com/thsottiaux/status/${item.inferredFrom.id})`}});
  if (schedule && all) {
    // 时间标签由程序生成；原帖与译文先转义，再按统一正文样式展示。
    elements.push({tag: 'div', text: {tag: 'lark_md', content: `**${schedule.label.replace('：', '：\n')}**`}});
    elements.push({tag: 'note', elements: [{tag: 'plain_text', content: scheduleBasis(schedule)}]});
  }
  if (item.contextUnavailable && !all) elements.push({tag: 'note', elements: [{tag: 'plain_text', content: '关联原帖暂无法读取，适用范围仅依据本帖；完整上下文请查看原帖。'}]});
  const imageKeys = item.imageKeys ?? [];
  const body = test ? text : translatedBody(item.post, item.translation, 3000, !all);
  if (body) elements.push({tag: 'div', text: {tag: test ? 'plain_text' : 'lark_md', content: test ? body : cardText(body)}});
  for (const key of imageKeys) elements.push({tag: 'img', img_key: key, alt: {tag: 'plain_text', content: '原帖图片'}, mode: 'fit_horizontal', preview: true});
  if (item.contextPost) {
    const sameAuthor = item.contextPost.author_id === item.post.author_id;
    const username = item.contextPost.username ?? item.post.entities?.mentions?.find(mention => mention.id === item.contextPost.author_id)?.username;
    elements.push(quoteCard(cardText(translatedBody(item.contextPost, item.contextTranslation, 1200, !all)),
      `https://x.com/i/status/${item.contextPost.id}`, sameAuthor ? 'Tibo · @thsottiaux' : username ? '@' + username : all ? '引用原帖' : '引用原帖（用户提问）', item.contextImageKeys ?? []));
  }
  if (all && !item.contextPost && item.contextUnavailable && linkedPostID(item.post)) {
    elements.push(quoteCard('原帖暂无法预览，请点击查看。', `https://x.com/i/status/${linkedPostID(item.post)}`, '引用原帖'));
  }
  const missingImages = (item.photos?.length ?? 0) > imageKeys.length;
  if (!test && (missingImages || (!body && !imageKeys.length))) {
    elements.push({tag: 'note', elements: [{tag: 'plain_text', content: missingImages ? '图片暂无法预览，请查看原帖。' : hasMedia(item.post) ? '这条动态包含媒体，回调未提供可预览图片，请查看原帖。' : '这条动态没有文字正文，请查看原帖。'}]});
  }
  if (!test) elements.push({tag: 'action', actions: [{tag: 'button', text: {tag: 'plain_text', content: '查看原帖'}, url: `https://x.com/thsottiaux/status/${item.post.id}`, type: 'default'}, {tag: 'button', text: {tag: 'plain_text', content: '打开重置监控'}, url: 'https://aihot.news/codex-reset', type: 'primary'}]});
  return {config: {wide_screen_mode: true}, header: {template: style.color, title: {tag: 'plain_text', content: style.title}}, elements};
}
export function feishuContent(item) {
  return {msg_type: 'interactive', content: JSON.stringify(card(item))};
}
async function sendFeishu(item, env) {
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Missing Feishu config');
  if (item.kind === 'x' || item.kind === 'x-all') {
    const sources = [originalExcerpt(item.post, 3000, item.kind === 'x'), item.contextPost ? originalExcerpt(item.contextPost, 1200, item.kind === 'x') : ''];
    const [translation, contextTranslation] = await Promise.all(sources.map(text => hasText(text) ? translateChinese(text, env.AI) : null));
    if (sources.some((text, i) => hasText(text) && ![translation, contextTranslation][i])) log('translation_unavailable', {id: item.id});
    item = {...item, translation, contextTranslation};
  }
  const post = async (path, payload, token) => {
    const data = await requestJSON('https://open.feishu.cn/open-apis/' + path, {method: 'POST', headers: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {})}, body: JSON.stringify(payload)});
    if (data.code !== 0) throw new Error('Feishu rejected');
    return data;
  };
  const auth = await post('auth/v3/tenant_access_token/internal', {app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET});
  if (typeof auth.tenant_access_token !== 'string' || !auth.tenant_access_token) throw new Error('Invalid token response');
  const contextPhotos = item.contextPost ? item.contextPost.photos ?? [] : [];
  if (item.photos?.length || contextPhotos.length) {
    const [imageKeys, contextImageKeys] = await Promise.all([item.photos ?? [], contextPhotos].map(photos => uploadPhotos(photos, auth.tenant_access_token)));
    if (imageKeys.length < (item.photos?.length ?? 0) || contextImageKeys.length < contextPhotos.length) log('image_unavailable', {id: item.id});
    item = {...item, imageKeys, contextImageKeys};
  }
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(item.id)))].map(n => n.toString(16).padStart(2, '0')).join('');
  const target = item.kind.endsWith('-all') ? env.ALL_POSTS_CHAT_ID : env.RESET_CHAT_ID;
  if (!/^oc_[a-f0-9]{32}$/.test(target ?? '')) throw new Error('Missing destination');
  const rendered = card(item);
  const result = await post('im/v1/messages?receive_id_type=chat_id', {receive_id: target, msg_type: 'interactive', content: JSON.stringify(rendered), uuid: 'xreset-' + hash.slice(0, 40)}, auth.tenant_access_token);
  const id = result.data?.message_id;
  if (typeof id !== 'string' || !id.startsWith('om_')) throw new Error('Missing message receipt');
  return id;
}
export async function consume(item, env, {now = Date.now(), send = sendFeishu, context = ancestors, classify = classifyReset} = {}) {
  if (!item || !Number.isFinite(item.created) || !['x', 'x-all', 'smoke', 'smoke-all'].includes(item.kind)) throw new Error('Invalid queue item');
  const isX = item.kind === 'x' || item.kind === 'x-all';
  const all = item.kind.endsWith('-all');
  if (all && !/^oc_[a-f0-9]{32}$/.test(env.ALL_POSTS_CHAT_ID ?? '')) throw new Error('Missing destination');
  if (isX) {
    if (env.X_ENABLED !== 'true') throw new Error('X disabled');
    validatePost(item.post);
    if (item.id !== item.kind + '-' + item.post.id || item.post.author_id !== env.X_TIBO_USER_ID || item.created !== timestamp(item.post.created_at)) throw new Error('Invalid queue identity');
  } else if (!env.SMOKE_TEST_ID || item.id !== item.kind + '-' + env.SMOKE_TEST_ID) throw new Error('Invalid smoke identity');
  if (item.created > now + 300000) throw new Error('Future event');
  const prior = await env.DB.prepare('SELECT status, created_at FROM receipts WHERE id = ?').bind(item.id).first();
  if (prior && prior.status !== 'pending') return prior.status;
  // 单条消费并发限制之外，数据库租约防止同一条消息被并发投递。
  const claim = await env.DB.prepare(`INSERT INTO receipts(id,status,lease_until,created_at) VALUES(?,'pending',?,?)
    ON CONFLICT(id) DO UPDATE SET lease_until=excluded.lease_until
    WHERE receipts.status='pending' AND receipts.lease_until <= ?`).bind(item.id, now + 300000, item.created, now).run();
  if (claim.meta.changes !== 1) throw new Error('Delivery leased');
  let status = 'sent', messageID = null;
  try {
    if (now - Math.min(item.created, prior?.created_at ?? item.created) >= WINDOW_MS) status = 'expired';
    else if (isX && item.created < xConfig(env)) status = 'filtered';
    else if (item.kind === 'x-all' && item.created < timestamp(env.ALL_POSTS_START_AT)) status = 'filtered';
    else {
      if (item.kind === 'x-all') {
        try { item = await allPostContext(item, env, validatePost, now); }
        catch { item = {...item, contextUnavailable:true}; log('all_context_unavailable', {id:item.id}); }
      }
      if (item.kind === 'x') {
        const analyzed = await analyzeReset(item, env, context, classify);
        if (!analyzed?.semantic.relevant) status = 'filtered';
        else item = analyzed;
      }
      if (status === 'sent') {
        messageID = await send(item, env);
      }
    }
    await env.DB.prepare('UPDATE receipts SET status=?, message_id=?, lease_until=0 WHERE id=?').bind(status, messageID, item.id).run();
    log(status, {id: item.id, ...(messageID ? {message_id: messageID} : {})});
    return status;
  } catch (error) {
    // 不落回执就保留重试；飞书固定 UUID 覆盖发送成功但回执写入失败的短期窗口。
    await env.DB.prepare("UPDATE receipts SET lease_until=0 WHERE id=? AND status='pending'").bind(item.id).run();
    throw error;
  }
}
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.allSettled([monitor(env), pruneCardSnapshots(env)]));
  },
  async fetch(request, env) {
    try { return await receive(request, env); }
    catch { log('receiver_failed'); return json({error: 'Temporarily unavailable'}, 503); }
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      try { await consume(message.body, env); message.ack(); }
      catch {
        await deliveryFailed(env, message.body?.id, message.attempts).catch(() => log('monitor_write_failed'));
        log('delivery_retry', {attempt: message.attempts}); message.retry({delaySeconds: 300});
      }
    }
  },
};
