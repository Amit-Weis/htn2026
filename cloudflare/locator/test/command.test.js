import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const env = { OMNI_BASE_URL: 'https://omni.test/v1/', OMNI_MODEL: 'omni-x', OMNI_API_KEY: 'k' };
const wav = new Uint8Array(200).fill(1);
const post = (e = env, body = wav) => worker.fetch(new Request('http://x/command', { method: 'POST', body }), e);

const stubOmni = (content, status = 200) => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(status === 200 ? JSON.stringify({ choices: [{ message: { content } }] }) : 'boom', { status });
  };
  return calls;
};

test('find intent maps to a COCO label and sends audio to omni', async () => {
  const calls = stubOmni('{"intent":"find","target":"cell phone","heard":"where is my phone","reply":"Looking for your phone"}');
  const r = await (await post()).json();
  assert.deepEqual(r, { intent: 'find', target: 'cell phone', heard: 'where is my phone', reply: 'Looking for your phone' });

  assert.equal(calls[0].url, 'https://omni.test/v1/chat/completions');
  assert.equal(calls[0].init.headers.authorization, 'Bearer k');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'omni-x');
  const audio = body.messages[1].content[0];
  assert.equal(audio.type, 'input_audio');
  assert.equal(audio.input_audio.format, 'wav');
  assert.equal(Buffer.from(audio.input_audio.data, 'base64').length, wav.length);
});

test('json wrapped in a code fence still parses', async () => {
  stubOmni('```json\n{"intent":"find","target":"cup","heard":"a","reply":"b"}\n```');
  assert.equal((await (await post()).json()).target, 'cup');
});

test('a target outside the COCO list is dropped', async () => {
  stubOmni('{"intent":"find","target":"car keys","heard":"my keys","reply":"?"}');
  const r = await (await post()).json();
  assert.equal(r.intent, 'find');
  assert.equal(r.target, '');
});

test('non-find intent has no target even if omni sent one', async () => {
  stubOmni('{"intent":"none","target":"cup","heard":"hi","reply":"hello"}');
  const r = await (await post()).json();
  assert.equal(r.intent, 'none');
  assert.equal(r.target, '');
});

test('missing config -> 500', async () => {
  assert.equal((await post({})).status, 500);
});

test('empty audio -> 400', async () => {
  assert.equal((await post(env, new Uint8Array(4))).status, 400);
});

test('omni error -> 502', async () => {
  stubOmni('', 500);
  assert.equal((await post()).status, 502);
});

test('non-JSON model output -> 502', async () => {
  stubOmni('sure, I can help');
  assert.equal((await post()).status, 502);
});

test('GET -> 405', async () => {
  const res = await worker.fetch(new Request('http://x/command'), env);
  assert.equal(res.status, 405);
});
