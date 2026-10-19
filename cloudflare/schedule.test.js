import test from 'node:test';
import assert from 'node:assert/strict';
import {effectiveSchedule} from './schedule.js';
import {card as renderCard, feishuContent} from './worker.js';

const card = value => renderCard({...value,semantic:{relevant:true,phase:'completed',reset_type:value.resetType??'quota'}});

const published = '2026-10-15T04:56:07Z';
const schedule = (text, date = published) => effectiveSchedule(text, date);
const post = (text, extra = {}) => ({id: '123', author_id: '456', created_at: published, text, ...extra});

test('relative deadlines use original publication time, not delivery time', () => {
  const s = schedule('Landing within the next 2 hours');
  assert.equal(s.label, '预计生效时间（北京时间 UTC+8）：2026-10-15 14:56 前');
  assert.equal(s.at, Date.parse('2026-10-15T06:56:07Z'));
  assert.equal(schedule('Codex reset in two hours').label, '预计生效时间（北京时间 UTC+8）：2026-10-15 14:56');
  assert.equal(schedule('Codex reset within the next hour').at, Date.parse('2026-10-15T05:56:07Z'));
  assert.equal(schedule('Codex reset in 30 minutes').at, Date.parse('2026-10-15T05:26:07Z'));
});
test('relative deadlines cross Beijing midnight and year boundaries', () => {
  assert.equal(schedule('Codex reset within 2 hours', '2026-12-31T15:30:00Z').label, '预计生效时间（北京时间 UTC+8）：2027-01-01 01:30 前');
});
test('PST and PDT retain explicitly written offsets', () => {
  assert.equal(schedule('Codex reset tomorrow 10am PST', '2026-10-02T02:14:51Z').label, '预计生效时间（北京时间 UTC+8）：2026-10-03 02:00');
  assert.equal(schedule('Codex reset tomorrow 10am PDT', '2026-10-02T02:14:51Z').label, '预计生效时间（北京时间 UTC+8）：2026-10-03 01:00');
});
test('Pacific local time uses DST on the target date', () => {
  assert.equal(schedule('Codex reset tomorrow 10am PT', '2026-10-02T02:14:51Z').label, '预计生效时间（北京时间 UTC+8）：2026-10-03 01:00');
  assert.equal(schedule('Codex reset tomorrow 10am Pacific Time', '2026-12-02T02:00:00Z').label, '预计生效时间（北京时间 UTC+8）：2026-12-03 02:00');
  assert.equal(schedule('Codex reset 2026-11-01 at 10am PT', '2026-10-31T12:00:00Z').label, '预计生效时间（北京时间 UTC+8）：2026-11-02 02:00');
});
test('explicit calendar dates and deadlines preserve their precision', () => {
  assert.equal(schedule('Codex reset on October 17, 2026 at 6pm PST').label, '预计生效时间（北京时间 UTC+8）：2026-10-18 10:00');
  assert.equal(schedule('Codex reset by 18:30 UTC').label, '预计生效时间（北京时间 UTC+8）：2026-10-16 02:30 前');
  assert.equal(schedule('Codex reset tomorrow 12am PST').label, '预计生效时间（北京时间 UTC+8）：2026-10-15 16:00');
  assert.equal(schedule('Codex reset tomorrow 12pm PST').label, '预计生效时间（北京时间 UTC+8）：2026-10-16 04:00');
});
test('no invented times for missing zones, vague wording, negations or unrelated times', () => {
  for (const text of ['Codex reset tomorrow', 'Codex reset at 6pm', 'Codex reset soon', 'Codex reset by EOD PST', 'No Codex reset in 2 hours', 'Codex reset might land in two hours', 'Codex reset in 2 hours?', 'Codex reset completed at 6pm PST', 'Codex reset. Meeting tomorrow 10am PST', 'Codex reset credits expire in 2 hours', 'Codex reset on Friday at 10am PST', 'Codex reset next week at 10am PST', 'Codex reset between 1pm and 3pm PST', 'Codex reset in 1-2 hours', 'Codex reset in 0 hours', 'Codex reset in 2 hours. Another reset in 4 hours', 'Codex reset 2026-02-30 at 10am PST', 'Codex reset today tomorrow 10am PST', 'Codex reset at 25:00 UTC']) {
    assert.equal(schedule(text), null, text);
  }
});
test('DST missing and repeated wall times are not guessed', () => {
  assert.equal(schedule('Codex reset 2026-03-08 at 2:30am PT', '2026-03-07T00:00:00Z'), null);
  assert.equal(schedule('Codex reset 2026-11-01 at 1:30am PT', '2026-10-31T00:00:00Z'), null);
});
test('unsupported date ordering and multiple clocks cannot borrow publication date', () => {
  for (const text of ['Codex reset on 17 October at 10am PST', 'Codex reset on the 17th at 10am PST', 'Codex reset at 1pm or 3pm PST', 'Codex reset in 2 hours after maintenance']) assert.equal(schedule(text), null, text);
});
test('all cards omit publication time while all-post reset estimates remain intact', () => {
  const p = post('Codex reset within the next 2 hours');
  const c = card({kind: 'x', post: p});
  assert.ok(!/北京时间|预计生效|发布时间|适用范围/.test(JSON.stringify(c)));
  assert.ok(!JSON.stringify(card({kind: 'x', post: post('Codex reset soon')})).includes('预计生效时间'));
  assert.ok(!JSON.stringify(card({kind: 'smoke'})).includes('预计生效时间'));
  const all = JSON.parse(feishuContent({kind: 'x-all', post: p, translation:'Codex 将在两小时内重置。'}).content);
  assert.ok(!JSON.stringify(all).includes('发布时间：'));
  assert.match(all.elements[0].text.content, /预计生效时间/);
});
