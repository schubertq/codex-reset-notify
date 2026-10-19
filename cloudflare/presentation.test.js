import test from 'node:test';
import assert from 'node:assert/strict';
import {scopeOf, originalExcerpt, translatedBody, scheduleBasis} from './presentation.js';
import {card as renderCard} from './worker.js';

const card = value => renderCard({...value,semantic:{relevant:true,phase:'completed',reset_type:value.resetType??'quota'}});

const parent = {id:'100', author_id:'456', created_at:'2026-10-08T03:19:00Z', text:"Day 3/ Codex and ChatGPT Work. Loading a banked reset in everyone's paid accounts."};
const post = {id:'101', author_id:'456', created_at:'2026-10-08T03:44:55Z', text:'Confirmed landed across all accounts. How are we doing so far?', referenced_tweets:[{type:'quoted',id:'100'}]};

test('quoted completion shows explicit scope and places the translated reply above its source panel without timestamps', () => {
  const result = card({kind:'x',post,contextPost:parent,resetType:'credit',translation:'已确认所有账户均已收到。大家用得怎么样？',contextTranslation:'第3天，为所有付费账户加载一张重置卡。'});
  const raw = JSON.stringify(result);
  assert.equal(result.header.template,'green');
  assert.match(result.elements[0].text.content,/^\*\*适用范围\*\*/);
  assert.ok(!/北京时间|确认时间|发布时间|预计生效/.test(raw));
  assert.match(raw,/所有付费账户 · Codex、ChatGPT Work/);
  assert.match(raw,/第3天，为所有付费账户加载一张重置卡/);
  assert.ok(!raw.includes(post.text));
  assert.equal(result.elements.at(-1).actions[1].url,'https://aihot.news/codex-reset');
  assert.equal(result.elements[1].text.content, '已确认所有账户均已收到。大家用得怎么样？');
  const quote = result.elements[2];
  assert.equal(quote.tag, 'interactive_container');
  assert.equal(quote.has_border, true);
  assert.equal(quote.behaviors[0].default_url, 'https://x.com/i/status/100');
  assert.match(quote.elements[0].content, /Tibo.*@thsottiaux/);
  assert.equal(quote.elements[1].content, '第3天，为所有付费账户加载一张重置卡。');
});

test('unspecified scope and product names alone add no metadata; quoted photos stay inside their source panel', () => {
  const result = card({kind:'x',post:{...post,text:'Codex reset completed.'},contextPost:{...parent,text:'Codex reset tomorrow.'},imageKeys:['img_main'],contextImageKeys:['img_quoted']});
  assert.equal(result.elements[0].text.content,'Codex reset completed.');
  assert.equal(result.elements[1].img_key,'img_main');
  assert.equal(result.elements[2].tag,'interactive_container');
  assert.equal(result.elements[2].elements.at(-1).img_key,'img_quoted');
  assert.equal(result.elements[2].elements.at(-1).preview,true);
  assert.ok(!/适用范围|北京时间|未说明/.test(JSON.stringify(result)));
  const foreign = card({kind:'x',post:{...post,text:'Thank you!'},contextPost:{...parent,author_id:'789'},externalContext:true});
  assert.ok(!JSON.stringify(foreign).includes('适用范围'));
});

test('scope never borrows an external audience or fabricates all plans from global reset', () => {
  assert.deepEqual(scopeOf(post,{...parent,author_id:'789'}),{label:'所有账户（套餐未说明）',inherited:false});
  assert.equal(scopeOf({...post,text:'Global reset tomorrow'},null).label,'未说明');
  assert.equal(scopeOf({...post,text:'Codex Pro is faster. Reset for all accounts.'},null).label,'所有账户（套餐未说明） · Codex');
  assert.equal(scopeOf({...post,text:'Loading a banked reset into all accounts of our Plus, Pro and Business users.'},null).label,'Plus、Pro、Business 用户');
});

test('translation failure retains the complete original instead of an empty error card', () => {
  const rendered = card({kind:'x',post,contextPost:parent,translation:null,contextTranslation:null});
  const raw = JSON.stringify(rendered);
  assert.ok(raw.includes(post.text));
  assert.ok(raw.includes(parent.text));
  assert.ok(!raw.includes('翻译暂不可用'));
  assert.equal(translatedBody({...post,text:'😂'},null),'😂');
});

test('long reset post foregrounds relevant original paragraphs without altering numbers or ordinary links', () => {
  const long = {...post,text:'Product announcement '.repeat(40)+'\n\nWe will reset Codex limits in 2 hours.\n\nDocumentation https://t.co/document'};
  assert.match(originalExcerpt(long,3000,true),/^We will reset Codex limits in 2 hours\./);
  assert.match(originalExcerpt(long,3000,true),/原文节选/);
  assert.ok(originalExcerpt({...post,text:'More information https://t.co/document'}).includes('https://t.co/document'));
  assert.equal(originalExcerpt({...post,text:'https://t.co/photo'}),'');
  assert.match(scheduleBasis({source:'6pm PST'}),/UTC−8.*夏令时可能相差一小时/);
});
