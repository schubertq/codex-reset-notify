import test from 'node:test';
import assert from 'node:assert/strict';
import {card} from './worker.js';

const post = {id:'123',author_id:'456',text:'The first accounts are receiving a fresh allowance.',created_at:'2026-10-16T14:00:00Z'};
const render = (phase, extra={}) => card({kind:'x',post,translation:'第一批账户已开始恢复额度。',semantic:{relevant:true,phase,reset_type:'quota'},...extra});
test('cards render the semantic decision without reclassifying wording or translation', () => {
  for (const [phase,color,label] of [['announced','blue','预告中'],['in_progress','blue','进行中'],['completed','green','已完成'],['issue','red','异常'],['uncertain','blue','进展待确认']]) {
    const result=render(phase);
    assert.equal(result.header.template,color);
    assert.equal(result.header.title.content,'Codex 额度重置｜'+label);
    assert.ok(!/Tibo|原帖发布|北京时间/.test(result.header.title.content));
  }
  assert.equal(render('in_progress',{semantic:{relevant:true,phase:'in_progress',reset_type:'credit'}}).header.title.content,'重置卡发放｜进行中');
  assert.throws(()=>card({kind:'x',post}),/semantic classification/);
});
test('original links, Chinese-only text, markup escaping and weak-context caveat survive classification', () => {
  const result=render('announced',{translation:'Codex 将重置。<at id=all>所有人</at>'});
  assert.equal(result.elements[0].text.tag,'lark_md');
  assert.match(result.elements[0].text.content,/&lt;at id=all&gt;/);
  assert.ok(!JSON.stringify(result).includes(post.text));
  assert.equal(result.elements.at(-1).actions[0].url,'https://x.com/thsottiaux/status/123');
  const inferred=render('uncertain',{inferredFrom:{id:'99'}});
  assert.equal(inferred.header.template,'blue');
  assert.match(JSON.stringify(inferred),/不是明确的重置完成确认/);
  assert.match(JSON.stringify(render('completed',{translation:null})),/first accounts/);
});
