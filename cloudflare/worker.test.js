import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker, {signature, parsePost, consume as consumePost, card, feishuContent} from './worker.js';

// 这些固定返回值只隔离投递测试；真实模型分类另由历史原帖验收。
const decision = (phase='announced', context_id=null) => ({relevant:phase!=='none',phase,reset_type:phase==='none'?'none':'quota',needs_context:false,context_id,evidence:[],reason:'Unit fixture',version:'reset-semantic-v1'});
const classifier = async (post, parents, _ai, options={}) => {
  const text=post.note_tweet?.text??post.text;
  if (['New product launch','Hello world','Hello\n\nworld','Hello','https://t.co/photo'].includes(text)) return decision('none');
  if (text==='Done!') return parents.length ? decision('completed',parents[0].id) : {...decision('none'),needs_context:!options.complete};
  return decision(text.startsWith('Confirmed landed')?'completed':'announced',parents[0]?.id??null);
};
const consume=(item,env,options={})=>consumePost(item,env,{classify:classifier,...options});
const now = Date.parse('2026-10-16T12:00:00Z');
const post = (text = 'Codex limits reset', extra = {}) => ({id: '123', author_id: '456', created_at: new Date(now).toISOString(), text, ...extra});
const envelope = p => ({data: {event_type: 'post.create', filter: {user_id: '456'}, payload: p}});
const item = p => ({kind: 'x', id: 'x-' + p.id, created: Date.parse(p.created_at), post: p});
function environment() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('./0001_receipts.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('./0003_reset_context.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('./0004_reset_cards.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('./0006_reset_analysis.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('./0007_post_cache.sql', import.meta.url), 'utf8'));
  const env = {FEISHU_APP_ID: 'cli_unit_test', RESET_CHAT_ID: 'oc_' + '1'.repeat(32), X_ENABLED: 'true', X_OAUTH2_CLIENT_SECRET: 'unit-test-only', X_TIBO_USER_ID: '456', X_SUBSCRIPTION_START_AT: new Date(now - 1000).toISOString(), SMOKE_TEST_ID: 'test', SMOKE_TEST_TOKEN: 'unit-smoke', NOTIFICATIONS: {send: async () => {}}, DB: {prepare(sql) { return {bind(...args) {return {
    async first() {return db.prepare(sql).get(...args) ?? null;},
    async run() {return {meta: {changes: db.prepare(sql).run(...args).changes}};},
    async all() {return {results: db.prepare(sql).all(...args)};},
  };}};}}};
  return {env, db};
}
async function signedRequest(env, p = post()) {
  const body = JSON.stringify(envelope(p));
  return new Request('https://test/webhooks/x', {method: 'POST', body, headers: {'X-Twitter-Webhooks-Signature-OAuth2': await signature(env.X_OAUTH2_CLIENT_SECRET, new TextEncoder().encode(body))}});
}
test('X disabled by default; health does not expose settings', async () => {
  assert.equal((await worker.fetch(new Request('https://test/webhooks/x'), {})).status, 503);
  const response = await worker.fetch(new Request('https://test/health'), {});
  assert.deepEqual(await response.json(), {service: 'codex-reset-notify', x_enabled: false});
});
test('CRC matches known HMAC and requires bounded token', async () => {
  const {env} = environment();
  const response = await worker.fetch(new Request('https://test/webhooks/x?crc_token=hello'), env);
  const {createHmac} = await import('node:crypto');
  assert.equal((await response.json()).response_token, 'sha256=' + createHmac('sha256', env.X_OAUTH2_CLIENT_SECRET).update('hello').digest('base64'));
  assert.equal((await worker.fetch(new Request('https://test/webhooks/x'), env)).status, 400);
});
test('unsigned and tampered bodies never enqueue', async () => {
  const {env} = environment(); let count = 0; env.NOTIFICATIONS.send = async () => count++;
  assert.equal((await worker.fetch(new Request('https://test/webhooks/x', {method: 'POST', body: '{}'}), env)).status, 401);
  const valid = await signedRequest(env);
  assert.equal((await worker.fetch(new Request(valid.url, {method: 'POST', headers: valid.headers, body: '{}'}), env)).status, 401);
  assert.equal(count, 0);
});
test('CRC registration works before subscription while event delivery remains disabled', async () => {
  const env = {X_ENABLED: 'false', X_OAUTH2_CLIENT_SECRET: 'unit-test-only'};
  const crc = await worker.fetch(new Request('https://test/webhooks/x?crc_token=register'), env);
  assert.equal(crc.status, 200);
  assert.equal((await worker.fetch(await signedRequest(env), env)).status, 503);
});
test('queue acceptance is awaited and failure returns 503', async () => {
  const {env} = environment(); let received;
  env.NOTIFICATIONS.send = async value => { received = value; };
  assert.equal((await worker.fetch(await signedRequest(env), env)).status, 200);
  assert.equal(received.post.id, '123');
  env.NOTIFICATIONS.send = async () => {throw new Error('secret must not escape');};
  const response = await worker.fetch(await signedRequest(env), env);
  assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('secret'));
});
test('body limit applies even without Content-Length', async () => {
  const {env} = environment();
  assert.equal((await worker.fetch(new Request('https://test/webhooks/x', {method: 'POST', body: 'x'.repeat(96001)}), env)).status, 413);
});
test('wrong authors and history are discarded; retweets are available only for all-post delivery', () => {
  assert.equal(parsePost(envelope(post('', {author_id: '789'})), '456', now), null);
  const retweet = post('Codex reset', {referenced_tweets: [{id: '9', type: 'retweeted'}]});
  assert.equal(parsePost(envelope(retweet), '456', now), retweet);
  assert.equal(parsePost(envelope(post()), '456', now + 1), null);
  assert.throws(() => parsePost(envelope(post('Codex reset', {id: '../9'})), '456', now));
});
test('emoji-only replies are displayed literally rather than reported as a translation failure', () => {
  const c = card({kind: 'x-all', post: post('@ajambrosino @petergyang @amorriscode 🍺👌')});
  assert.match(JSON.stringify(c), /🍺👌/);
  assert.ok(!JSON.stringify(c).includes('翻译暂不可用'));
});
test('smoke requires secret and uses fixed content/id', async () => {
  const {env} = environment(); let received;
  env.NOTIFICATIONS.send = async value => received = value;
  const request = auth => new Request('https://test/admin/smoke', {method: 'POST', headers: {Authorization: auth}, body: 'untrusted text'});
  assert.equal((await worker.fetch(request('Bearer wrong'), env)).status, 401);
  assert.equal((await worker.fetch(request('Bearer unit-smoke'), env)).status, 202);
  assert.equal(received.id, 'smoke-test'); assert.equal(received.post, undefined);
  assert.ok(JSON.stringify(card(received)).includes('不是真实 X 帖子'));
  assert.ok(!JSON.stringify(card(received)).includes('已核验'));
});
test('duplicate delivery produces one receipt and one send', async () => {
  const {env, db} = environment(); let sends = 0;
  const options = {now, send: async () => {sends++; return 'om_test';}};
  assert.equal(await consume(item(post()), env, options), 'sent');
  assert.equal(await consume(item(post()), env, options), 'sent');
  assert.equal(sends, 1); assert.equal(db.prepare('SELECT message_id FROM receipts').get().message_id, 'om_test');
});
test('failed delivery releases lease and retries successfully', async () => {
  const {env, db} = environment();
  await assert.rejects(consume(item(post()), env, {now, send: async () => {throw new Error('offline');}}));
  assert.equal(db.prepare('SELECT status, lease_until FROM receipts').get().status, 'pending');
  assert.equal(db.prepare('SELECT lease_until FROM receipts').get().lease_until, 0);
  assert.equal(await consume(item(post()), env, {now, send: async () => 'om_retry'}), 'sent');
});
test('concurrent duplicate cannot acquire active delivery lease', async () => {
  const {env} = environment(); let release, entered;
  const ready = new Promise(resolve => entered = resolve);
  const pending = new Promise(resolve => release = resolve);
  const first = consume(item(post()), env, {now, send: async () => {entered(); await pending; return 'om_one';}});
  await ready;
  await assert.rejects(consume(item(post()), env, {now}), /leased/);
  release(); await first;
});
test('expired messages never send; renewed smoke calls cannot extend retry window', async () => {
  const {env, db} = environment(); let sends = 0;
  assert.equal(await consume(item(post()), env, {now: now + 21600000, send: async () => sends++}), 'expired');
  db.prepare("INSERT INTO receipts VALUES('smoke-test','pending',0,?,NULL)").run(now - 21600000);
  assert.equal(await consume({kind: 'smoke', id: 'smoke-test', created: now}, env, {now, send: async () => sends++}), 'expired');
  assert.equal(sends, 0);
});
test('ordinary queued posts are acknowledged without sending', async () => {
  const {env} = environment(); let sends = 0;
  assert.equal(await consume(item(post('New product launch')), env, {now, send: async () => sends++}), 'filtered');
  assert.equal(sends, 0);
});
test('consumer failures retry, successes ack', async () => {
  const {env} = environment(); let ack = 0, retry = 0;
  await worker.queue({messages: [{body: {kind: 'invalid'}, attempts: 1, ack: () => ack++, retry: () => retry++}]}, env);
  assert.equal(ack, 0); assert.equal(retry, 1);
});

function enableAll(env) {
  env.ALL_POSTS_CHAT_ID = 'oc_' + '2'.repeat(32);
  env.ALL_POSTS_START_AT = new Date(now).toISOString();
}
const allItem = p => ({...item(p), kind: 'x-all', id: 'x-all-' + p.id});
test('one authenticated event fans out to two independently deduplicated deliveries', async () => {
  const {env} = environment(); enableAll(env);
  const queued = []; env.NOTIFICATIONS.send = async value => queued.push(value);
  for (let i = 0; i < 2; i++) assert.equal((await worker.fetch(await signedRequest(env), env)).status, 200);
  const sent = [];
  for (const value of queued) await consume(value, env, {now, send: async v => {sent.push(v.kind); return 'om_' + v.kind;}});
  assert.deepEqual(sent, ['x-all', 'x']);
});
test('ordinary posts reach all-post group without context calls or reset-group delivery', async () => {
  const {env} = environment(); enableAll(env); let calls = 0;
  const p = post('Hello\n\nworld');
  const options = {now, send: async () => {calls++; return 'om_all';}, context: async () => {throw new Error('must not query X');}};
  assert.equal(await consume(allItem(p), env, options), 'sent');
  assert.equal(await consume(item(p), env, {...options, context: async () => []}), 'filtered');
  assert.equal(calls, 1);
});
test('one destination failure cannot resend the successful destination', async () => {
  const {env} = environment(); enableAll(env); const sent = [];
  const send = async v => {sent.push(v.kind); return 'om_' + v.kind;};
  await consume(allItem(post()), env, {now, send});
  await assert.rejects(consume(item(post()), env, {now, send: async () => {throw new Error('offline');}}));
  await consume(allItem(post()), env, {now, send});
  await consume(item(post()), env, {now, send});
  assert.deepEqual(sent, ['x-all', 'x']);
});
test('all-post activation never backfills history and rejects forged queue identities', async () => {
  const {env} = environment(); enableAll(env); let sent = 0;
  const p = post('Hello', {created_at: new Date(now - 500).toISOString()});
  assert.equal(await consume(allItem(p), env, {now, send: async () => sent++}), 'filtered');
  await assert.rejects(consume({...allItem(post()), id: 'x-123'}, env, {now}), /identity/);
  assert.equal(sent, 0);
});
test('all-post cards share reset-card typography and actions without publishing time', () => {
  const original = 'Hello\n\nworld';
  const p = post('truncated', {note_tweet: {text: original}});
  const translation = '**你好**\n\n世界';
  const content = feishuContent({...allItem(p), translation});
  assert.equal(content.msg_type, 'interactive');
  const result = JSON.parse(content.content);
  assert.equal(result.header.title.content, 'Tibo 全部动态｜新帖');
  assert.ok(!content.content.includes('发布时间：'));
  assert.deepEqual(result.elements[0].text, {tag:'lark_md',content:'\\*\\*你好\\*\\*\n\n世界'});
  assert.deepEqual(result.elements.at(-1).actions.map(action=>action.type),['default','primary']);
  assert.equal(result.elements.at(-1).actions[1].url,'https://aihot.news/codex-reset');
  assert.equal(result.elements.at(-1).actions[0].url,'https://x.com/thsottiaux/status/123');
  assert.ok(!content.content.includes(original));
  assert.ok(feishuContent({kind: 'smoke-all'}).content.includes('不是真实 X 帖子'));
});

test('ordinary all-post cards cannot imply reset completion or estimate unrelated schedules', () => {
  const p = post('The product launch failed. Landing in 2 hours', {referenced_tweets:[{type:'replied_to',id:'99'}]});
  const result = card({...allItem(p),translation:'产品发布失败。两小时后上线。'});
  assert.equal(result.header.template,'blue');
  assert.equal(result.header.title.content,'Tibo 全部动态｜回复');
  assert.ok(!JSON.stringify(result).includes('预计生效时间'));
  assert.equal(card({...allItem(post('RT: Great!',{referenced_tweets:[{type:'retweeted',id:'99'}]})),translation:'转帖：很棒！'}).header.title.content,'Tibo 全部动态｜转帖');
  assert.ok(JSON.stringify(card(allItem(p))).includes(p.text));
  assert.ok(!JSON.stringify(card(allItem(p))).includes('翻译暂不可用'));
});

test('all-post long translations are bounded and explicitly marked as excerpts', () => {
  const result = card({...allItem(post('Long post')),translation:'长帖'.repeat(2000)});
  assert.ok(result.elements[0].text.content.endsWith('（长帖摘译，完整内容请查看原帖）'));
  assert.ok(result.elements[0].text.content.length<3100);
});

test('production sender translates both card destinations and keeps dedup intact', async t => {
  const {env} = environment(); enableAll(env); env.FEISHU_APP_SECRET = 'unit-test-only';
  let translations = 0; const messages = [];
  env.AI = {run: async () => {translations++; return {choices:[{finish_reason:'stop',message:{content:'Codex 将在两小时内重置。'}}]};}};
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).includes('tenant_access_token')) {
      assert.equal(JSON.parse(init.body).app_id,env.FEISHU_APP_ID);
      return Response.json({code:0,tenant_access_token:'unit-test-only'});
    }
    messages.push(JSON.parse(init.body)); return Response.json({code:0,data:{message_id:'om_test'}});
  });
  const p = post('Codex reset within the next 2 hours');
  await consume(item(p),env,{now});
  await consume(item(p),env,{now});
  await consume(allItem(p),env,{now});
  assert.equal(translations,2);
  assert.equal(messages.length,2);
  assert.match(messages[0].content,/将在两小时内重置/);
  assert.ok(!messages[0].content.includes(p.text));
  assert.ok(!messages[1].content.includes(p.text));
  assert.match(messages[1].content,/将在两小时内重置/);
  assert.equal(messages[1].msg_type,'interactive');
  assert.equal(messages[0].receive_id,env.RESET_CHAT_ID);
  assert.equal(messages[1].receive_id,env.ALL_POSTS_CHAT_ID);
});

test('translated linked context and original fallback survive model failure without changing completion evidence', async t => {
  const {env}=environment();env.FEISHU_APP_SECRET='unit-test-only';
  const parent=post('Day 3/ Loading a banked reset in all paid accounts.',{id:'99',created_at:new Date(now-3600000).toISOString()});
  const p=post('Confirmed landed across all accounts.',{referenced_tweets:[{type:'quoted',id:'99'}]});
  let calls=0,sent;
  env.AI={run:async(_model,input)=>{calls++;if(input.messages[1].content===p.text)throw new Error('Unavailable');return{choices:[{finish_reason:'stop',message:{content:'第3天，为所有付费账户加载一张重置卡。'}}]};}};
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    if(String(url).includes('tenant_access_token'))return Response.json({code:0,tenant_access_token:'unit-token'});
    sent=JSON.parse(JSON.parse(init.body).content);return Response.json({code:0,data:{message_id:'om_linked'}});
  });
  assert.equal(await consume(item(p),env,{now,context:async()=>[parent]}),'sent');
  assert.equal(calls,2);assert.equal(sent.header.template,'green');
  assert.match(JSON.stringify(sent),/第3天，为所有付费账户/);
  assert.ok(JSON.stringify(sent).includes(p.text));
  assert.ok(!JSON.stringify(sent).includes('翻译暂不可用'));
});

test('optional context failure preserves direct notifications but dependent short replies must retry', async () => {
  const {env}=environment();let delivered;
  const context=async()=>{throw new Error('Lookup unavailable');};
  assert.equal(await consume(item(post('Codex reset tomorrow')),env,{now,context,send:async value=>{delivered=value;return 'om_direct';}}),'sent');
  assert.equal(delivered.contextUnavailable,undefined);
  await assert.rejects(consume(item(post('Done!',{id:'124',in_reply_to_tweet_id:'99'})),env,{now,context,send:async()=>assert.fail('missing classification context')}),/Lookup unavailable/);
});

test('signed callback preserves matched photo URLs for both destinations without hydrating X', async () => {
  const {env} = environment(); enableAll(env);
  const p = post('https://t.co/photo', {attachments: {media_keys: ['3_1']}});
  const data = envelope(p);
  data.data.includes = {media: [{media_key:'3_1',type:'photo',url:'https://pbs.twimg.com/media/test.png'}, {media_key:'3_2',type:'photo',url:'https://pbs.twimg.com/media/parent.png'}]};
  const body = JSON.stringify(data); const queued = []; env.NOTIFICATIONS.send = async value => queued.push(value);
  const request = new Request('https://test/webhooks/x', {method:'POST',body,headers:{'X-Twitter-Webhooks-Signature-OAuth2':await signature(env.X_OAUTH2_CLIENT_SECRET,new TextEncoder().encode(body))}});
  assert.equal((await worker.fetch(request,env)).status,200);
  assert.equal(queued.length,2);
  for (const value of queued) assert.deepEqual(value.photos,[{url:'https://pbs.twimg.com/media/test.png'}]);
  let sent = 0;
  assert.equal(await consume(queued[1],env,{now,send:async()=>sent++,context:async()=>[]}), 'filtered');
  assert.equal(sent,0);
});

test('media-only callback can have empty text, but an empty ordinary post remains invalid', () => {
  assert.equal(parsePost(envelope(post('',{attachments:{media_keys:['3_1']}})), '456',now).text,'');
  assert.throws(()=>parsePost(envelope(post('')), '456',now),/Invalid text/);
});

test('pure photo cards have preview and no translation error; missing media has an accurate fallback', () => {
  const p = post('https://t.co/photo',{attachments:{media_keys:['3_1']}});
  const result = card({...allItem(p),imageKeys:['img_v3_preview'],photos:[{url:'https://pbs.twimg.com/media/test.png'}]});
  assert.equal(result.elements.find(element=>element.tag==='img').img_key,'img_v3_preview');
  assert.ok(!JSON.stringify(result).includes('翻译暂不可用'));
  assert.match(JSON.stringify(card(allItem(p))),/回调未提供可预览图片/);
  assert.match(JSON.stringify(card({...allItem(p),photos:[{url:'https://pbs.twimg.com/media/test.png'}]})),/图片暂无法预览/);
  assert.match(JSON.stringify(card(allItem(post('https://t.co/photo')))),/没有文字正文/);
});

test('photo delivery skips AI for media-only posts, degrades on image failure and remains deduplicated', async t => {
  const {env} = environment(); enableAll(env); env.FEISHU_APP_SECRET = 'unit-test-only';
  const urls=[]; let translations=0; let sentCard;
  env.AI={run:async()=>{translations++;throw new Error('must not translate a photo');}};
  t.mock.method(globalThis,'fetch',async(target,init)=>{
    urls.push(String(target));
    if(String(target).includes('tenant_access_token')) return Response.json({code:0,tenant_access_token:'unit-token'});
    if(String(target).startsWith('https://pbs.twimg.com/')) throw new Error('Image unavailable');
    sentCard=JSON.parse(JSON.parse(init.body).content);return Response.json({code:0,data:{message_id:'om_media'}});
  });
  const value={...allItem(post('https://t.co/photo',{attachments:{media_keys:['3_1']}})),photos:[{url:'https://pbs.twimg.com/media/test.png'}]};
  assert.equal(await consume(value,env,{now}),'sent');
  assert.equal(await consume(value,env,{now}),'sent');
  assert.equal(translations,0);assert.equal(urls.length,3);
  assert.match(JSON.stringify(sentCard),/图片暂无法预览/);
  assert.ok(!urls.some(url=>url.includes('api.x.com')));
});

test('captioned photo delivery uploads to Feishu and shows translation above the image', async t => {
  const {env}=environment(); enableAll(env); env.FEISHU_APP_SECRET='unit-test-only';
  let translatedText; let sentCard; let uploads=0;
  env.AI={run:async(_model,input)=>{translatedText=input.messages[1].content;return {choices:[{finish_reason:'stop',message:{content:'看看这张图'}}]};}};
  t.mock.method(globalThis,'fetch',async(target,init)=>{
    if(String(target).includes('tenant_access_token')) return Response.json({code:0,tenant_access_token:'unit-token'});
    if(String(target).startsWith('https://pbs.twimg.com/')) return new Response('image',{headers:{'Content-Type':'image/png'}});
    if(String(target).endsWith('/im/v1/images')) {uploads++;return Response.json({code:0,data:{image_key:'img_v3_photo'}});}
    assert.ok(!String(target).includes('api.x.com'));
    sentCard=JSON.parse(JSON.parse(init.body).content);return Response.json({code:0,data:{message_id:'om_caption'}});
  });
  const p=post('Look at this https://t.co/photo',{attachments:{media_keys:['3_1']},entities:{urls:[{url:'https://t.co/photo',media_key:'3_1'}]}});
  assert.equal(await consume({...allItem(p),photos:[{url:'https://pbs.twimg.com/media/test.png'}]},env,{now}),'sent');
  assert.equal(translatedText,'Look at this');assert.equal(uploads,1);
  assert.equal(sentCard.elements[0].text.content,'看看这张图');assert.equal(sentCard.elements[1].img_key,'img_v3_photo');
});

test('quoted parent lookup expands only its own photos and embeds them below the completion text', async t => {
  const {env}=environment();env.FEISHU_APP_SECRET='unit-test-only';env.X_BEARER_TOKEN='unit-context';
  const parent=post('Codex reset tomorrow https://t.co/photo',{id:'99',attachments:{media_keys:['3_quoted']},entities:{urls:[{url:'https://t.co/photo',media_key:'3_quoted'}]}});
  let lookups=0,uploads=0,sentCard;
  t.mock.method(globalThis,'fetch',async(target,init)=>{
    const url=String(target);
    if(url.startsWith('https://api.x.com/')) {
      lookups++;
      assert.equal(new URL(url).searchParams.get('expansions'),'attachments.media_keys');
      return Response.json({data:parent,includes:{media:[{media_key:'3_quoted',type:'photo',url:'https://pbs.twimg.com/media/quoted.png'},{media_key:'3_other',type:'photo',url:'https://pbs.twimg.com/media/unrelated.png'}]}});
    }
    if(url.includes('tenant_access_token'))return Response.json({code:0,tenant_access_token:'unit-token'});
    if(url.startsWith('https://pbs.twimg.com/')) {
      assert.equal(url,'https://pbs.twimg.com/media/quoted.png');
      assert.equal(init.headers,undefined);
      return new Response('image',{headers:{'Content-Type':'image/png'}});
    }
    if(url.endsWith('/im/v1/images')) {uploads++;return Response.json({code:0,data:{image_key:'img_quote'}});}
    sentCard=JSON.parse(JSON.parse(init.body).content);return Response.json({code:0,data:{message_id:'om_quoted'}});
  });
  assert.equal(await consume(item(post('Done!',{referenced_tweets:[{type:'quoted',id:'99'}]})),env,{now}),'sent');
  assert.equal(lookups,1);assert.equal(uploads,1);
  assert.equal(sentCard.elements[0].text.content,'Done!');
  const quote=sentCard.elements.find(e=>e.tag==='interactive_container');
  assert.equal(quote.elements[1].content,'Codex reset tomorrow');
  assert.equal(quote.elements[2].img_key,'img_quote');
  assert.ok(!sentCard.elements.some(e=>e.tag==='img'));
  assert.ok(!/北京时间|适用范围/.test(JSON.stringify(sentCard)));
});

// 公开版本必须使用部署者自己的应用配置，缺失时不能回退到生产身份。
test('missing Feishu application ID rejects delivery before making an API request', async t => {
  const {env} = environment(); env.FEISHU_APP_SECRET = 'unit-test-only'; delete env.FEISHU_APP_ID;
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {requests++; throw new Error('must not fetch');});
  await assert.rejects(consume(item(post()), env, {now}), /Missing Feishu config/);
  assert.equal(requests, 0);
});

test('related progress creates a new immutable card and duplicate callbacks do not resend', async t => {
  const {env}=environment();env.FEISHU_APP_SECRET='unit-test-only';
  const messages=[],patches=[];
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    if(String(url).includes('tenant_access_token')) return Response.json({code:0,tenant_access_token:'unit-token'});
    if(init.method==='PATCH') patches.push(String(url));
    messages.push(JSON.parse(init.body));
    return Response.json({code:0,data:{message_id:'om_'+messages.length}});
  });
  const announced=post('Codex reset tomorrow');
  const completed=post('Done!',{id:'124',created_at:new Date(now+1000).toISOString(),referenced_tweets:[{type:'replied_to',id:'123'}]});
  for(const p of [announced,completed]) await consume(item(p),env,{now:now+1000,context:async()=>p.id==='124'?[announced]:[]});
  for(const p of [announced,completed]) await consume(item(p),env,{now:now+1000,context:async()=>assert.fail('already delivered')});
  assert.equal(messages.length,2);assert.deepEqual(patches,[]);
  assert.equal(JSON.parse(messages[0].content).header.template,'blue');
  assert.equal(JSON.parse(messages[1].content).header.template,'green');
  assert.notEqual(messages[0].uuid,messages[1].uuid);
  assert.match(messages[0].content,/Codex reset tomorrow/);
  assert.match(messages[1].content,/Done!/);
});

test('scheduled work never patches a legacy announcement after completion', async t => {
  const {env,db}=environment();
  for(const [id,state] of [['100','announced'],['101','completed']]) db.prepare('INSERT INTO reset_cards(post_id,event_id,created_at,message_id,state,content) VALUES(?,?,?,?,?,?)')
    .run(id,'100',Date.now(),'om_'+id,state,JSON.stringify({header:{template:state==='announced'?'blue':'green'}}));
  const requests=[];t.mock.method(globalThis,'fetch',async(url)=>{requests.push(String(url));throw new Error('Unexpected request');});
  let pending;await worker.scheduled({},env,{waitUntil:value=>pending=value});await pending;
  assert.deepEqual(requests,[]);
  assert.equal(JSON.parse(db.prepare("SELECT content FROM reset_cards WHERE post_id='100'").get().content).header.template,'blue');
});

test('a novel follow-up without reset keywords requests its actual parent before delivery',async()=>{
  const {env}=environment();let calls=0,reads=0,sent;
  const parent=post('Codex reset tomorrow',{id:'99'});
  const p=post('The first accounts are receiving the fresh allowance.',{in_reply_to_tweet_id:'99'});
  await consumePost(item(p),env,{now,classify:async(_,parents,__,options)=>{
    calls++;
    if(!options?.complete)return{...decision('none'),needs_context:true};
    assert.equal(parents[0].id,'99');return decision('in_progress','99');
  },context:async()=>{reads++;return[parent];},send:async value=>{sent=value;return'om_new';}});
  assert.equal(calls,1);assert.equal(reads,1);assert.equal(sent.contextPost.id,'99');
  assert.equal(card(sent).header.title.content,'Codex 额度重置｜进行中');
});

test('temporal proximity uses only a recent pending same-author snapshot and cannot mark it completed',async()=>{
  const {env,db}=environment();
  const parent=post('Codex reset tomorrow',{id:'99',created_at:new Date(now-1000).toISOString()});
  db.prepare('INSERT INTO reset_analysis VALUES(?,?,?,?,?)').run('99','456',now-1000,'announced',JSON.stringify({post:parent,semantic:decision()}));
  let delivered;
  await consumePost(item(post('That is taken care of.')),env,{now,classify:async(_,parents,__,options)=>{
    if(!options?.complete)return{...decision('none'),needs_context:true};
    assert.equal(parents.length,0);assert.equal(options.recent.id,'99');return decision('uncertain','99');
  },send:async value=>{delivered=value;return'om_recent';}});
  assert.equal(delivered.inferredFrom.id,'99');assert.equal(delivered.semantic.phase,'uncertain');
  assert.equal(db.prepare("SELECT phase FROM reset_analysis WHERE post_id='99'").get().phase,'announced');
});

test('all-post reply embeds its immediate parent and reuses the lookup for the reset destination', async t => {
  const {env}=environment(); enableAll(env); env.X_BEARER_TOKEN='unit-context';
  const parent=post('Codex reset tomorrow',{id:'99'});
  let reads=0,delivered;
  t.mock.method(globalThis,'fetch',async target=>{
    assert.match(String(target),/api\.x\.com\/2\/tweets\/99\?/); reads++;
    return Response.json({data:parent});
  });
  const p=post('Done!',{referenced_tweets:[{type:'replied_to',id:'99'}]});
  await consume(allItem(p),env,{now,send:async value=>{delivered=value;return 'om_all_reply';}});
  const embedded=card(delivered).elements.find(e=>e.tag==='interactive_container');
  assert.equal(embedded.elements[1].content,parent.text);
  assert.equal(embedded.behaviors[0].default_url,'https://x.com/i/status/99');
  await consume(item(p),env,{now,send:async()=> 'om_reset_reply'});
  assert.equal(reads,1);
});
test('all-post quote translates the full parent and puts its images inside the grey container', async t => {
  const {env}=environment(); enableAll(env); env.FEISHU_APP_SECRET='unit-only'; env.X_BEARER_TOKEN='unit-context';
  const parent=post('An unrelated product update',{id:'99',author_id:'789',attachments:{media_keys:['3_parent']}});
  let delivered;
  env.AI={run:async(_model,input)=>({choices:[{finish_reason:'stop',message:{content:input.messages[1].content===parent.text?'完整产品更新':'当前回复'}}]})};
  t.mock.method(globalThis,'fetch',async(target,init)=>{
    const url=String(target);
    if(url.startsWith('https://api.x.com/'))return Response.json({data:parent,includes:{users:[{id:'789',username:'source_author'}],media:[{media_key:'3_parent',type:'photo',url:'https://pbs.twimg.com/media/parent.png'}]}});
    if(url.includes('tenant_access_token'))return Response.json({code:0,tenant_access_token:'unit-token'});
    if(url.startsWith('https://pbs.twimg.com/'))return new Response('image',{headers:{'Content-Type':'image/png'}});
    if(url.endsWith('/im/v1/images'))return Response.json({code:0,data:{image_key:'img_parent'}});
    delivered=JSON.parse(JSON.parse(init.body).content); return Response.json({code:0,data:{message_id:'om_quote_all'}});
  });
  await consume(allItem(post('Hello',{referenced_tweets:[{type:'quoted',id:'99'}]})),env,{now});
  const embedded=delivered.elements.find(e=>e.tag==='interactive_container');
  assert.equal(embedded.elements[0].content,'**@source\\_author**');
  assert.equal(embedded.elements[1].content,'完整产品更新');
  assert.equal(embedded.elements[2].img_key,'img_parent');
  assert.equal(embedded.background_style,'grey-50');
  assert.ok(!delivered.elements.some(e=>e.tag==='img'));
});
test('unavailable parent cannot suppress an all-post reply or invent quoted content', async t => {
  const {env}=environment(); enableAll(env); env.X_BEARER_TOKEN='unit-context'; let delivered;
  t.mock.method(globalThis,'fetch',async()=>new Response('',{status:404}));
  await consume(allItem(post('Hello',{referenced_tweets:[{type:'replied_to',id:'99'}]})),env,{now,send:async value=>{delivered=value;return 'om_unavailable';}});
  const embedded=card(delivered).elements.find(e=>e.tag==='interactive_container');
  assert.equal(embedded.behaviors[0].default_url,'https://x.com/i/status/99');
  assert.equal(embedded.elements[1].content,'原帖暂无法预览，请点击查看。');
});
