import test from 'node:test';
import assert from 'node:assert/strict';
import {translateChinese} from './translation.js';

test('cloud translation bounds its input and accepts Chinese output', async () => {
  let input;
  const ai = {run:async (model, payload) => {input=payload;return {choices:[{finish_reason:'stop',message:{content:'Codex 将在两小时内重置。'}}]};}};
  assert.equal(await translateChinese('x'.repeat(4000),ai),'Codex 将在两小时内重置。');
  assert.equal(input.messages[1].content.length,3000);
  assert.match(input.messages[0].content,/Simplified Chinese/);
});
test('missing binding, quota errors, malformed output and timeout cannot block notification', async () => {
  assert.equal(await translateChinese('Codex reset',undefined),null);
  assert.equal(await translateChinese('Codex reset',{run:async()=>{throw new Error('Quota exceeded');}}),null);
  for (const result of [{}, {choices:[{finish_reason:'length',message:{content:'中文不完整'}}]}, {choices:[{finish_reason:'stop',message:{content:'English only'}}]}, {choices:[{finish_reason:'stop',message:{content:'中文'.repeat(4000)}}]}]) assert.equal(await translateChinese('Codex reset',{run:async()=>result}),null);
  assert.equal(await translateChinese('Codex reset',{run:()=>new Promise(()=>{})},5),null);
});
