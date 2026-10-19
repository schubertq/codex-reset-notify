import test from 'node:test';
import assert from 'node:assert/strict';
import {eventPhotos, displayText, hasText, uploadPhotos} from './media.js';

const url = 'https://pbs.twimg.com/media/example.jpg';
const attached = {text: 'https://t.co/photo', attachments: {media_keys: ['3_1']}, entities: {urls: [{url: 'https://t.co/photo', media_key: '3_1'}]}};

test('event media joins only the current post photo keys, preserves order and removes duplicates', () => {
  const includes = {media: [{media_key: '3_1', type: 'photo', url}, {media_key: '3_2', type: 'photo', url: url + '?name=small'}, {media_key: '13_3', type: 'video', url}]};
  assert.deepEqual(eventPhotos(attached, includes), [{url}]);
  assert.deepEqual(eventPhotos({...attached, attachments: {media_keys: ['3_2', '3_1', '3_2', '13_3']}}, includes), [{url: url + '?name=small'}, {url}]);
  assert.deepEqual(eventPhotos({text: 'no attachments'}, includes), []);
  assert.deepEqual(eventPhotos(attached, undefined), []);
});

test('callback images cannot point at internal hosts, unrelated paths, credentials or redirects', async t => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => {calls++; throw new Error('must not fetch');});
  for (const bad of ['http://pbs.twimg.com/media/a.jpg', 'https://pbs.twimg.com.evil.test/media/a.jpg', 'https://127.0.0.1/media/a.jpg', 'https://pbs.twimg.com:8080/media/a.jpg', 'https://user:pass@pbs.twimg.com/media/a.jpg', 'https://pbs.twimg.com/profile_images/a.jpg']) {
    assert.deepEqual(eventPhotos(attached, {media: [{media_key: '3_1', type: 'photo', url: bad}]}), []);
    assert.deepEqual(await uploadPhotos([{url: bad}], 'unit-token'), []);
  }
  assert.equal(calls, 0);
});

test('only attachment links disappear; text, other links and long-post entities survive', () => {
  assert.equal(displayText(attached), '');
  const text = 'Look https://t.co/photo https://t.co/article';
  assert.equal(displayText({...attached, text}), 'Look  https://t.co/article');
  assert.equal(displayText({...attached, note_tweet: {text, entities: attached.entities}}), 'Look  https://t.co/article');
  assert.equal(hasText('@somebody https://t.co/photo'), false);
  assert.equal(hasText('Codex reset https://t.co/photo'), true);
});

test('image download and multipart upload carry credentials only to Feishu', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (target, init) => {
    calls.push(String(target));
    if (String(target).startsWith('https://pbs.twimg.com/')) {
      assert.equal(init.redirect, 'manual'); assert.equal(init.headers, undefined);
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {headers: {'Content-Type': 'image/jpeg'}});
    }
    assert.equal(target, 'https://open.feishu.cn/open-apis/im/v1/images');
    assert.equal(init.headers.Authorization, 'Bearer unit-token');
    assert.equal(init.body.get('image_type'), 'message');
    assert.equal(init.body.get('image').size, 3);
    return Response.json({code: 0, data: {image_key: 'img_v3_uploaded'}});
  });
  assert.deepEqual(await uploadPhotos([{url}], 'unit-token'), ['img_v3_uploaded']);
  assert.equal(calls.length, 2);
  assert.ok(!calls.some(value => value.includes('api.x.com')));
});

test('bad type, empty image, declared or streamed oversize never upload', async t => {
  const responses = [new Response('html', {headers: {'Content-Type': 'text/html'}}), new Response('', {headers: {'Content-Type': 'image/png'}}), new Response('x', {headers: {'Content-Type': 'image/png', 'Content-Length': 9 * 1024 * 1024}}), new Response(new Uint8Array(8 * 1024 * 1024 + 1), {headers: {'Content-Type': 'image/png'}})];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async target => {assert.equal(target, url); calls++; return responses.shift();});
  assert.deepEqual(await uploadPhotos(Array.from({length: 4}, () => ({url})), 'unit-token'), []);
  assert.equal(calls, 4);
});

test('a redirect is rejected without following its location or uploading its body', async t => {
  let calls=0;
  t.mock.method(globalThis,'fetch',async(target,init)=>{
    calls++;assert.equal(target,url);assert.equal(init.redirect,'manual');
    return new Response('image',{status:302,headers:{'Content-Type':'image/png',Location:'https://other.example/image.png'}});
  });
  assert.deepEqual(await uploadPhotos([{url}],'unit-token'),[]);
  assert.equal(calls,1);
});

test('failed image does not prevent other pictures and only four are processed', async t => {
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async target => {
    if (String(target).startsWith('https://pbs.twimg.com/')) {
      if (++downloads === 1) throw new Error('Image unavailable');
      return new Response('image', {headers: {'Content-Type': 'image/png'}});
    }
    return Response.json({code: 0, data: {image_key: 'img_v3_' + downloads}});
  });
  assert.deepEqual(await uploadPhotos(Array.from({length: 6}, () => ({url})), 'unit-token'), ['img_v3_2', 'img_v3_3', 'img_v3_4']);
  assert.equal(downloads, 4);
});
