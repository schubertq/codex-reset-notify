const HOUR = 3600000;
const log = (event, fields = {}) => console.log(JSON.stringify({log_key: 'TiboResetRadar', event, ...fields}));
const enabled = env => env.MONITOR_ENABLED === 'true';
const labels = {
  receiver: '已验签的 X 事件未能完成持久入队',
  delivery: '通知连续失败至少 3 次，或等待超过 15 分钟',
  subscription: 'X 订阅或回调状态异常，或状态查询失败',
  storage: '通知服务状态数据库检查失败',
  test: '告警私信链路测试（模拟故障，不影响通知）',
};

export async function watchDelivery(env, id, now = Date.now()) {
  if (!enabled(env)) return;
  await env.DB.prepare('INSERT OR IGNORE INTO delivery_watch(id,queued_at) VALUES(?,?)').bind(id, now).run();
}
export async function deliveryFailed(env, id, attempts) {
  if (!enabled(env) || typeof id !== 'string') return;
  await env.DB.prepare('UPDATE delivery_watch SET attempts=MAX(attempts,?) WHERE id=?').bind(attempts, id).run();
}
export async function setIncident(env, key, active, now = Date.now()) {
  if (!enabled(env)) return;
  // 正常初始状态不通知；只在故障状态变化时递增通知版本。
  await env.DB.prepare(`INSERT INTO monitor_incidents(key,active,revision,changed_at) VALUES(?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET active=excluded.active,revision=monitor_incidents.revision+1,changed_at=excluded.changed_at
    WHERE monitor_incidents.active<>excluded.active`).bind(key, active ? 1 : 0, active ? 1 : 0, now).run();
}
async function claim(env, key, now, duration) {
  const result = await env.DB.prepare(`INSERT INTO monitor_clock(key,next_at) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET next_at=excluded.next_at WHERE monitor_clock.next_at<=?`).bind(key, now + duration, now).run();
  return result.meta.changes === 1;
}
async function readX(env, path) {
  if (!env.X_BEARER_TOKEN) throw new Error('Missing monitor token');
  const response = await fetch('https://api.x.com/2/' + path, {
    headers: {Authorization: 'Bearer ' + env.X_BEARER_TOKEN}, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Subscription check failed');
  const result = await response.json();
  if (result.errors?.length || !Array.isArray(result.data)) throw new Error('Invalid subscription response');
  return result.data;
}
export async function subscriptionHealthy(env, now) {
  if (!env.X_WEBHOOK_URL) throw new Error('Missing webhook URL');
  const subscriptions = await readX(env, 'activity/subscriptions?user_id=' + encodeURIComponent(env.X_TIBO_USER_ID));
  const subscription = subscriptions.find(s => s.subscription_id === env.X_SUBSCRIPTION_ID);
  if (!subscription || subscription.event_type !== 'post.create' || subscription.filter?.user_id !== env.X_TIBO_USER_ID ||
      subscription.webhook_id !== env.X_WEBHOOK_ID || (subscription.expires_at && !(Date.parse(subscription.expires_at) > now))) return false;
  const hooks = await readX(env, 'webhooks?webhook_config.fields=id,url,valid');
  return hooks.some(h => h.id === env.X_WEBHOOK_ID && h.valid === true && h.url === env.X_WEBHOOK_URL);
}
export async function sendAlert(env, incident) {
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Missing Feishu config');
  // 告警固定私发给管理员，不能从外部请求指定接收者或正文。
  if (!/^on_[a-f0-9]{32}$/.test(env.ADMIN_UNION_ID ?? '')) throw new Error('Missing alert recipient');
  const expired = incident.key.startsWith('expired:');
  const label = expired ? '消息超过 6 小时未完成处理，已停止自动发送。请人工核查；系统没有补发历史。' : labels[incident.key];
  if (!label) throw new Error('Unknown incident');
  const text = `Codex 重置通知｜${expired ? '消息过期' : incident.active ? '故障告警' : '故障恢复'}\n${label}\n` +
    (incident.active ? '仅通知管理员。' : '该项检查已恢复正常；不代表过期消息已补发。') +
    '\n检查时间：' + new Date(incident.changed_at).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false}) + '（北京时间）';
  const post = async (path, body, token) => {
    const response = await fetch('https://open.feishu.cn/open-apis/' + path, {method: 'POST',
      headers: {'Content-Type': 'application/json', ...(token ? {Authorization: 'Bearer ' + token} : {})},
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000)});
    if (!response.ok) throw new Error('Alert HTTP failure');
    const data = await response.json();
    if (data.code !== 0) throw new Error('Alert rejected');
    return data;
  };
  const auth = await post('auth/v3/tenant_access_token/internal', {app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET});
  if (!auth.tenant_access_token) throw new Error('Missing alert token');
  const bytes = new TextEncoder().encode(incident.key + ':' + incident.revision);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2,'0')).join('');
  const result = await post('im/v1/messages?receive_id_type=union_id', {receive_id: env.ADMIN_UNION_ID, msg_type: 'text',
    content: JSON.stringify({text}), uuid: 'monitor-' + digest.slice(0,40)}, auth.tenant_access_token);
  if (!result.data?.message_id) throw new Error('Missing alert receipt');
  return result.data.message_id;
}
export async function flushAlerts(env, send = sendAlert) {
  const pending = await env.DB.prepare('SELECT * FROM monitor_incidents WHERE revision<>notified_revision ORDER BY changed_at LIMIT 5').bind().all();
  for (const incident of pending.results) {
    // 故障在首次成功通知前已经恢复时，不发送没有前因的恢复消息。
    let messageID = null;
    if (incident.active || incident.notified_active) messageID = await send(env, incident);
    await env.DB.prepare('UPDATE monitor_incidents SET notified_active=?,notified_revision=?,message_id=? WHERE key=? AND revision=?')
      .bind(incident.active, incident.revision, messageID, incident.key, incident.revision).run();
    log('monitor_alert_recorded', {key: incident.key, active: incident.active, message_id: messageID});
  }
}
export async function monitor(env, {now = Date.now(), check = subscriptionHealthy, send = sendAlert} = {}) {
  if (!enabled(env)) return;
  let locked = false;
  let phase = 'storage';
  try {
    locked = await claim(env, 'monitor', now, 240000);
    if (!locked) return;
    const backlog = await env.DB.prepare(`SELECT COUNT(*) AS count FROM delivery_watch w LEFT JOIN receipts r ON r.id=w.id
      WHERE (r.id IS NULL OR r.status='pending') AND (w.queued_at<=? OR w.attempts>=3)`).bind(now - 900000).first();
    await setIncident(env, 'delivery', backlog.count > 0, now);
    const expired = await env.DB.prepare(`SELECT w.id FROM delivery_watch w JOIN receipts r ON r.id=w.id
      WHERE r.status='expired' AND NOT EXISTS (SELECT 1 FROM monitor_incidents m WHERE m.key='expired:'||w.id) LIMIT 5`).bind().all();
    for (const row of expired.results) await setIncident(env, 'expired:' + row.id, true, now);
    // 每小时只检查订阅配置，不读取时间线，不启动消息核对或补发。
    if (await claim(env, 'subscription', now, HOUR)) {
      let healthy = false;
      try { healthy = await check(env, now); } catch { log('subscription_check_failed'); }
      await setIncident(env, 'subscription', !healthy, now);
    }
    await setIncident(env, 'storage', false, now);
    phase = 'alert';
    await flushAlerts(env, send);
    log('monitor_checked', {backlog: backlog.count});
  } catch {
    log('monitor_failed');
    // 数据库不可用时无法可靠保存告警状态；固定小时 UUID 限制兜底私信重复。
    if (phase === 'storage') {
      try { await setIncident(env, 'storage', true, now); await flushAlerts(env, send); }
      catch { await send(env, {key:'storage',active:1,revision:'fallback-'+Math.floor(now/HOUR),changed_at:now}).catch(() => log('monitor_alert_failed')); }
    }
    throw new Error('Monitor failed');
  } finally {
    if (locked) await env.DB.prepare("UPDATE monitor_clock SET next_at=? WHERE key='monitor'").bind(now).run().catch(() => {});
  }
}
