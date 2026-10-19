import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyReset, linkedContext, semanticInput, validateDecision, SEMANTIC_MODEL} from './semantic.js';

const post={id:'2111492738025959922',author_id:'456',created_at:'2026-10-20T01:00:00Z',text:'Landing at 3pm PST.',in_reply_to_tweet_id:'99'};
const parent={id:'99',author_id:'456',created_at:'2026-10-20T00:00:00Z',text:'Codex usage reset tomorrow.'};
const value=(extra={})=>({relevant:true,phase:'announced',reset_type:'quota',needs_context:false,context_id:null,evidence:[{id:post.id,quote:post.text}],reason:'The reset arrival is in the future.',...extra});
const output=content=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}]});

test('model reads the full note tweet, uses aliases and restores exact source IDs',async()=>{
  let sent;
  const p={...post,note_tweet:{text:'Full introduction. '.repeat(200)+'The reset arrives at midnight.'}};
  const ai={run:async(model,input)=>{
    assert.equal(model,SEMANTIC_MODEL); sent=input;
    const data=JSON.parse(input.messages.at(-1).content);
    const source=(data.source??data).current;
    return output(value({evidence:[{id:'current',segment:Object.keys(source.segments).at(-1)}]}));
  }};
  const result=await classifyReset(p,[],ai,{complete:true});
  assert.equal(JSON.parse(sent.messages.at(-1).content).current.text,p.note_tweet.text);
  assert.equal(Object.values(JSON.parse(sent.messages.at(-1).content).current.segments).join(' '),p.note_tweet.text);
  assert.equal(result.evidence[0].id,post.id);
  assert.match(sent.messages[0].content,/untrusted data/);
  assert.equal(sent.temperature,0);
});
test('only actual ancestor chains and bounded same-author recent context reach the model',()=>{
  const unrelated={...parent,id:'98'};
  assert.deepEqual(linkedContext(post,[unrelated,parent]),[parent]);
  assert.deepEqual(linkedContext(post,[unrelated]),[]);
  const standalone={...post,in_reply_to_tweet_id:undefined};
  assert.equal(semanticInput(standalone,[],{recent:parent}).context[0].relation,'recent');
  for (const recent of [{...parent,author_id:'789'},{...parent,created_at:'2026-10-19T00:00:00Z'},{...parent,created_at:'2026-10-21T00:00:00Z'}]) assert.equal(semanticInput(standalone,[],{recent}).context.length,0);
});
test('multiple segment references remain grounded and do not require another model call',async()=>{
  const p={...post,text:'Day 15/ Whatever, we are still cooking......and reset. Enjoy.',in_reply_to_tweet_id:undefined};
  let calls=0;
  const ai={run:async()=>{calls++;return output(value({phase:'completed',evidence:[{id:'current',segment:['s0','s1']}]}));}};
  const result=await classifyReset(p,[],ai,{complete:true});
  assert.equal(calls,1);
  assert.equal(result.phase,'completed');
  assert.deepEqual(result.evidence,[{id:p.id,quote:'Day 15/ Whatever, we are still cooking......and reset.'},{id:p.id,quote:'Enjoy.'}]);
  for (const segment of [[],['s0','missing'],['s0',1]]) {
    await assert.rejects(classifyReset(p,[],{run:async()=>output(value({evidence:[{id:'current',segment}]}))},{complete:true}),/Ungrounded semantic segment/);
  }
});
test('hallucinated evidence, IDs, phases and contradictory responses cannot authorize delivery',()=>{
  const input=semanticInput(post,[parent],{complete:true});
  for (const invalid of [value({phase:'guess'}),value({relevant:false}),value({evidence:[]}),value({context_id:'missing'}),value({needs_context:true}),value({evidence:[{id:post.id,quote:'Reset completed!'}]}),value({context_id:'99'})]) {
    assert.throws(()=>validateDecision(invalid,input));
  }
  assert.equal(validateDecision(value(),input).phase,'announced');
});
test('excluded posts may retain grounded evidence without authorizing delivery',()=>{
  const input=semanticInput(post,[],{complete:true});
  const excluded=value({relevant:false,phase:'none',reset_type:'none'});
  assert.equal(validateDecision(excluded,input).relevant,false);
  assert.throws(()=>validateDecision({...excluded,evidence:[{id:post.id,quote:'Fabricated exclusion'}]},input),/Ungrounded/);
});
test('weak proximity and external personal reports cannot establish a completed reset',()=>{
  const standalone={...post,in_reply_to_tweet_id:undefined};
  const result=value({phase:'completed',context_id:'99',evidence:[{id:post.id,quote:post.text},{id:'99',quote:parent.text}]});
  assert.throws(()=>validateDecision(result,semanticInput(standalone,[],{recent:parent,complete:true})),/association/);
  assert.throws(()=>validateDecision(result,semanticInput(post,[{...parent,author_id:'789'}],{complete:true})),/completion/);
});
test('missing model, timeout, quota errors and truncated or invalid output remain retryable failures',async()=>{
  await assert.rejects(classifyReset(post,[],undefined),/Missing semantic AI/);
  await assert.rejects(classifyReset(post,[],{run:async()=>{throw new Error('Quota exceeded');}}),/Quota/);
  await assert.rejects(classifyReset(post,[],{run:()=>new Promise(()=>{})},{timeoutMs:5}),/timeout/);
  for (const result of [{},{choices:[{finish_reason:'length',message:{content:'{}'}}]},output({})]) await assert.rejects(classifyReset(post,[],{run:async()=>result}));
});
