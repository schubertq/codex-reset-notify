// 仅在本地数据库生成卡片；没有飞书发信配置，也不查询 X。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {getPlatformProxy} = require('wrangler');

(async () => {
  const [config, output, limitArg = '10', budgetArg = '500', filterArg] = process.argv.slice(2);
  if (!config || !output) throw new Error('Usage: node evaluate-semantic.cjs AI_ONLY_CONFIG OUTPUT_JSONL [LIMIT=10] [MAX_NEURONS=500] [CASE_NAMES_OR_POST_IDS]');
  const limit = Number(limitArg), budget = Number(budgetArg);
  if (!Number.isInteger(limit) || limit < 1 || !(budget > 0)) throw new Error('Invalid evaluation limits');
  const {consume, card} = await import('./worker.js');
  const {SEMANTIC_MODEL} = await import('./semantic.js');
  const suite = JSON.parse(fs.readFileSync(path.join(__dirname, 'semantic-cases.json'), 'utf8'));
  const fingerprint = crypto.createHash('sha256');
  for (const name of ['semantic.js', 'worker.js', 'semantic-cases.json']) fingerprint.update(fs.readFileSync(path.join(__dirname, name)));
  const revision = fingerprint.digest('hex');
  const previous = fs.existsSync(output) ? fs.readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const done = new Map(previous.filter(row => row.revision === revision && !row.error).map(row => [row.name, row]));
  const filters = filterArg ? new Set(filterArg.split(',')) : null;
  if (filters && [...filters].some(filter => !suite.cases.some(value => value.name === filter || value.post.id === filter))) throw new Error('Unknown acceptance case');
  const selected = filters ? [...filters].map(filter => suite.cases.find(value => value.name === filter || value.post.id === filter)) : suite.cases;
  const candidates = selected.filter(value => !done.has(value.name)).slice(0, limit);
  let neurons = 0, calls = 0, responses = [];
  const proxy = await getPlatformProxy({configPath:path.resolve(config), persist:false, envFiles:[]});
  const db = new DatabaseSync(':memory:');
  for (const name of ['0001_receipts.sql', '0006_reset_analysis.sql']) db.exec(fs.readFileSync(path.join(__dirname, name), 'utf8'));
  const env = {X_ENABLED:'true', X_TIBO_USER_ID:suite.cases[0].post.author_id, X_OAUTH2_CLIENT_SECRET:'isolated-only', X_SUBSCRIPTION_START_AT:'2020-01-01T00:00:00Z',
    AI:{async run(...args) {
      // 还需先在控制台确认可用额度；此上限只限制本次验收，不代表账号剩余额度。
      if (neurons >= budget) throw new Error('Evaluation budget exhausted');
      // 本次专项遇到格式错误或额外分类请求即停，禁止内部修复重试消耗额度。
      if (responses.length) throw new Error('Evaluation stopped before repeated semantic call');
      calls++;
      const result = await proxy.env.AI.run(...args);
      const used = Number(result.usage?.neurons);
      if (!Number.isFinite(used) || used < 0) throw new Error('Evaluation usage unavailable');
      neurons += used;
      responses.push({finish_reason:result.choices?.[0]?.finish_reason, content:result.choices?.[0]?.message?.content});
      return result;
    }},
    DB:{prepare(sql) {return {bind(...args) {return {
      async first() {return db.prepare(sql).get(...args) ?? null;},
      async run() {return {meta:{changes:db.prepare(sql).run(...args).changes}};},
    };}};}},
  };
  try {
    for (const sample of candidates) {
      db.exec('DELETE FROM reset_analysis; DELETE FROM receipts');
      if (sample.recent) db.prepare('INSERT INTO reset_analysis VALUES(?,?,?,?,?)').run(sample.recent.id, sample.recent.author_id,
        Date.parse(sample.recent.created_at), 'announced', JSON.stringify({post:sample.recent, semantic:{relevant:true,phase:'announced'}}));
      const start = Date.now(), before = neurons;
      responses = [];
      const item = {kind:'x', id:'x-'+sample.post.id, created:Date.parse(sample.post.created_at), post:sample.post};
      let row = {name:sample.name, post_id:sample.post.id, expected:sample.expected, model:SEMANTIC_MODEL, revision};
      try {
        let rendered;
        const status = await consume(item, env, {now:item.created+1, context:async()=>suite.context,
          send:async value => {rendered=card(value); return 'om_local_validation';}});
        const stored = db.prepare('SELECT payload FROM reset_analysis WHERE post_id=?').get(sample.post.id);
        const decision = stored && JSON.parse(stored.payload).semantic;
        row = {...row, status, decision, header:rendered?.header, pass:Boolean(decision) && decision.relevant===sample.expected.relevant &&
          sample.expected.phases.includes(decision.phase) && decision.reset_type===sample.expected.reset_type};
      } catch (error) {row = {...row, error:error.message, pass:false};}
      row.ms = Date.now()-start; row.neurons = neurons-before; row.responses = responses;
      fs.appendFileSync(output, JSON.stringify(row)+'\n');
      done.set(row.name, row);
      console.log(JSON.stringify({name:row.name, pass:row.pass, error:row.error, neurons:row.neurons}));
      // 平台错误、超时、无效响应或预算耗尽后立即停止，不继续消耗线上共享额度。
      if (row.error || neurons >= budget) break;
    }
  } finally {db.close(); await proxy.dispose();}
  const names = new Set(selected.map(value => value.name));
  const rows = [...done.values()].filter(row => names.has(row.name));
  const summary = {model:SEMANTIC_MODEL, revision, total:selected.length, evaluated:rows.length, passed:rows.filter(row=>row.pass).length, calls, neurons};
  fs.writeFileSync(output+'.summary.json', JSON.stringify(summary, null, 2)+'\n');
  console.log(JSON.stringify(summary));
  if (summary.evaluated !== summary.total || summary.passed !== summary.total) process.exitCode = 1;
})().catch(error => {console.error(error.message); process.exitCode=1;});
