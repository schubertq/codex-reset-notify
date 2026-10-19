import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {watchDelivery, deliveryFailed, setIncident, monitor, subscriptionHealthy, sendAlert} from './monitor.js';
import worker, {signature} from './worker.js';

const now = Date.parse('2026-10-16T15:00:00Z');
function setup() {
  const db = new DatabaseSync(':memory:');
  for (const file of ['0001_receipts.sql','0002_monitor.sql','0003_reset_context.sql']) db.exec(readFileSync(new URL(file, import.meta.url),'utf8'));
  const env = {FEISHU_APP_ID:'cli_unit_test',X_WEBHOOK_URL:'https://notify.example.com/webhooks/x',MONITOR_ENABLED:'true',X_ENABLED:'true',X_TIBO_USER_ID:'456',X_OAUTH2_CLIENT_SECRET:'unit-only',
    X_SUBSCRIPTION_START_AT:new Date(now-1000).toISOString(),X_SUBSCRIPTION_ID:'7',X_WEBHOOK_ID:'8',X_BEARER_TOKEN:'unit-only',
    ADMIN_UNION_ID:'on_'+'a'.repeat(32),FEISHU_APP_SECRET:'unit-only',
    NOTIFICATIONS:{send:async()=>{}},DB:{prepare(sql){return {bind(...args){return {
      async first(){return db.prepare(sql).get(...args)??null;},
      async all(){return {results:db.prepare(sql).all(...args)};},
      async run(){return {meta:{changes:db.prepare(sql).run(...args).changes}};},
    };}};}}};
  const sent = [];
  const options = {now,check:async()=>true,send:async(_,incident)=>{sent.push(incident);return 'om_test';}};
  return {db,env,sent,options};
}
const p = (text, extra={}) => ({id:'123',author_id:'456',created_at:new Date(now).toISOString(),text,...extra});
test('quiet source is not a fault; subscription checks run hourly rather than each tick',async()=>{
  const {env,options,sent}=setup();let checks=0;
  options.check=async()=>{checks++;return true;};
  await monitor(env,options);await monitor(env,{...options,now:now+300000});
  assert.equal(checks,1);assert.equal(sent.length,0);
  await monitor(env,{...options,now:now+3600000});assert.equal(checks,2);
});
test('backlog alerts once at 15 minutes and recovers once after delivery',async()=>{
  const {env,db,options,sent}=setup();await watchDelivery(env,'x-123',now-900000);
  await monitor(env,options);await monitor(env,{...options,now:now+300000});
  assert.equal(sent.length,1);assert.equal(sent[0].key,'delivery');
  db.exec("INSERT INTO receipts VALUES('x-123','sent',0,0,'om_sent')");
  await monitor(env,{...options,now:now+600000});await monitor(env,{...options,now:now+900000});
  assert.equal(sent.length,2);assert.equal(sent[1].active,0);
});
test('three failed attempts alert before backlog threshold',async()=>{
  const {env,options,sent}=setup();await watchDelivery(env,'x-123',now);
  await deliveryFailed(env,'x-123',3);await monitor(env,options);
  assert.equal(sent[0].key,'delivery');
});
test('expired messages produce one persistent notice and never resend posts',async()=>{
  const {env,db,options,sent}=setup();await watchDelivery(env,'x-123',now-900000);
  db.exec("INSERT INTO receipts VALUES('x-123','expired',0,0,NULL)");
  await monitor(env,options);await monitor(env,{...options,now:now+300000});
  assert.equal(sent.length,1);assert.equal(sent[0].key,'expired:x-123');
});
test('failed alert is retried with the same revision, recovery without delivered alert stays quiet',async()=>{
  const {env,options,sent}=setup();await setIncident(env,'receiver',true,now);
  let first;
  await assert.rejects(monitor(env,{...options,send:async(_,i)=>{first=i;throw new Error('offline');}}));
  await monitor(env,{...options,now:now+300000});assert.equal(sent[0].revision,first.revision);
  const other=setup();await setIncident(other.env,'receiver',true,now);await setIncident(other.env,'receiver',false,now+1);
  await monitor(other.env,other.options);assert.equal(other.sent.length,0);
});
test('subscription failures and recovery are deduplicated',async()=>{
  const {env,options,sent}=setup();
  await monitor(env,{...options,check:async()=>false});
  await monitor(env,{...options,now:now+300000,check:async()=>false});
  assert.equal(sent.length,1);
  await monitor(env,{...options,now:now+3600000});assert.equal(sent.length,2);assert.equal(sent[1].active,0);
});
test('monitor lease prevents concurrent duplicate alerts',async()=>{
  const {env,options,sent}=setup();await setIncident(env,'receiver',true,now);
  let release,entered;const ready=new Promise(r=>entered=r),wait=new Promise(r=>release=r);
  const run=monitor(env,{...options,check:async()=>{entered();await wait;return true;}});
  await ready;await monitor(env,options);release();await run;assert.equal(sent.length,1);
});
test('subscription validator checks exact string IDs, expiry, callback URL and validity',async t=>{
  const {env}=setup();let valid=true,expires;let callback=env.X_WEBHOOK_URL;
  const paths=[];
  t.mock.method(globalThis,'fetch',async url=>{paths.push(String(url));return Response.json({data:String(url).includes('/activity/')?
    [{subscription_id:'7',filter:{user_id:'456'},event_type:'post.create',webhook_id:'8',expires_at:expires}]:
    [{id:'8',valid,url:callback}]});});
  assert.equal(await subscriptionHealthy(env,now),true);
  callback='https://other.example.com/webhooks/x';assert.equal(await subscriptionHealthy(env,now),false);
  callback=env.X_WEBHOOK_URL;valid=false;assert.equal(await subscriptionHealthy(env,now),false);
  valid=true;expires=new Date(now-1).toISOString();assert.equal(await subscriptionHealthy(env,now),false);
  assert.ok(paths.every(path=>!path.includes('/tweets')));
});
test('admin alert sends only a private message with stable ID and no post text or secrets',async t=>{
  const {env}=setup();const requests=[];
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    if(String(url).includes('tenant_access_token'))return Response.json({code:0,tenant_access_token:'unit-token'});
    requests.push({url,body:JSON.parse(init.body)});return Response.json({code:0,data:{message_id:'om_alert'}});
  });
  const incident={key:'delivery',active:1,revision:1,changed_at:now};
  await sendAlert(env,incident);await sendAlert(env,incident);
  assert.match(requests[0].url,/receive_id_type=union_id/);
  assert.equal(requests[0].body.receive_id,env.ADMIN_UNION_ID);
  assert.equal(requests[0].body.uuid,requests[1].body.uuid);
  assert.ok(!requests[0].body.content.includes('unit-only'));
});
test('valid X enqueue failure is durable and visible; invalid signatures never trigger incidents',async()=>{
  const {env,db}=setup();env.NOTIFICATIONS.send=async()=>{throw new Error('offline');};
  const body=JSON.stringify({data:{event_type:'post.create',filter:{user_id:'456'},payload:p('Codex reset')}});
  const headers={'X-Twitter-Webhooks-Signature-OAuth2':await signature(env.X_OAUTH2_CLIENT_SECRET,new TextEncoder().encode(body))};
  assert.equal((await worker.fetch(new Request('https://test/webhooks/x',{method:'POST',body,headers}),env)).status,503);
  assert.equal(db.prepare("SELECT active FROM monitor_incidents WHERE key='receiver'").get().active,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM delivery_watch').get().n,1);
  const before=db.prepare('SELECT SUM(revision) AS n FROM monitor_incidents').get().n;
  await worker.fetch(new Request('https://test/webhooks/x',{method:'POST',body:'bad'}),env);
  assert.equal(db.prepare('SELECT SUM(revision) AS n FROM monitor_incidents').get().n,before);
});

test('subscription monitor requires the deployment callback URL before making a request', async t => {
  const {env} = setup(); delete env.X_WEBHOOK_URL;
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {requests++; throw new Error('must not fetch');});
  await assert.rejects(subscriptionHealthy(env, now), /Missing webhook URL/);
  assert.equal(requests, 0);
});
