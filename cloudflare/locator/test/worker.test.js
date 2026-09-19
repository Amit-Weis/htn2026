import test from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import worker from '../src/index.js';
import { makeStereo } from './synthetic.js';

const W = 320, H = 240, D = 10;
const body = jpeg.encode(makeStereo(W, H, D), 95).data;

const env = (dets) => ({
  AI: { run: async () => dets },
  DETECT_MODEL: 'test-model',
  MIN_SCORE: '0.5',
  BASELINE_M: '0.06',
  HFOV_DEG: '65',
  STEREO_SWAP: '0',
});
const cup = { label: 'cup', score: 0.9, box: { xmin: 140, ymin: 90, xmax: 200, ymax: 150 } };
const post = (e, qs = '') => worker.fetch(new Request('http://x/' + qs, { method: 'POST', body }), e);

test('returns the LocateResponse contract with plausible depth', async () => {
  const r = await (await post(env([cup]), '?label=cup')).json();
  assert.equal(r.found, true);
  assert.equal(r.label, 'cup');
  assert.equal(r.u, 170);
  assert.equal(r.v, 120);
  assert.equal(r.width, W);
  assert.equal(r.height, H);
  const fx = W / 2 / Math.tan((65 * Math.PI) / 360);
  assert.ok(Math.abs(r.fx - fx) < 1e-6);
  assert.ok(Math.abs(r.depth_m - (fx * 0.06) / D) / r.depth_m < 0.05, `depth ${r.depth_m}`);
});

test('query overrides calibration', async () => {
  const r = await (await post(env([cup]), '?label=cup&fx=500&baseline=0.1')).json();
  assert.ok(Math.abs(r.depth_m - (500 * 0.1) / D) / r.depth_m < 0.05, `depth ${r.depth_m}`);
});

test('label "target" takes the best detection of any class', async () => {
  const dogs = [{ ...cup, label: 'dog', score: 0.6 }, cup];
  const r = await (await post(env(dogs))).json();
  assert.equal(r.label, 'cup');
});

test('wrong label -> found false', async () => {
  const r = await (await post(env([cup]), '?label=dog')).json();
  assert.equal(r.found, false);
});

test('low-confidence detection is ignored', async () => {
  const r = await (await post(env([{ ...cup, score: 0.2 }]), '?label=cup')).json();
  assert.equal(r.found, false);
});

test('non-JPEG body -> 400', async () => {
  const res = await worker.fetch(new Request('http://x/', { method: 'POST', body: 'nope' }), env([cup]));
  assert.equal(res.status, 400);
});

test('GET -> 405', async () => {
  const res = await worker.fetch(new Request('http://x/'), env([cup]));
  assert.equal(res.status, 405);
});
