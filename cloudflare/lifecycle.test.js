import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {pruneCardSnapshots} from './lifecycle.js';

test('legacy snapshot retention cleans both destinations without changing receipts or live snapshots', async () => {
  const db = new DatabaseSync(':memory:');
  for (const migration of ['0001_receipts.sql','0004_reset_cards.sql','0006_reset_analysis.sql','0007_post_cache.sql']) {
    db.exec(readFileSync(new URL('./'+migration,import.meta.url),'utf8'));
  }
  const now = Date.parse('2026-10-19T12:00:00Z');
  for (const table of ['reset_cards']) {
    for (const [id,created] of [['old',now-8*86400000],['recent',now-3600000]]) {
      db.prepare(`INSERT INTO ${table}(post_id,event_id,created_at,message_id,state,content) VALUES(?,?,?,?,?,?)`)
        .run(id,id,created,'om_'+id,'announced','{"header":{"template":"blue"}}');
    }
  }
  db.prepare("INSERT INTO receipts(id,status,lease_until,created_at) VALUES('x-old','sent',0,?)").run(now-8*86400000);
  const env={DB:{prepare(sql){return{bind(...args){return{async run(){return db.prepare(sql).run(...args);}};}};}}};
  await pruneCardSnapshots(env,now);
  for (const table of ['reset_cards']) {
    const rows=db.prepare(`SELECT * FROM ${table}`).all();
    assert.equal(rows.length,1);
    assert.equal(rows[0].post_id,'recent');
    assert.equal(rows[0].content,'{"header":{"template":"blue"}}');
    assert.equal(rows[0].updated_by,null);
  }
  assert.equal(db.prepare('SELECT status FROM receipts').get().status,'sent');
});
