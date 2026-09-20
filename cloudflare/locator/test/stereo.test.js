import test from 'node:test';
import assert from 'node:assert/strict';
import { matchDisparity } from '../src/stereo.js';
import { makeStereo } from './synthetic.js';

const W = 320, H = 240;

for (const d of [4, 10.5, 37.25]) {
  test(`recovers disparity ${d}`, () => {
    const img = makeStereo(W, H, d);
    const m = matchDisparity({ rgba: img.data, width2: img.width, height: H, cx: 170, cy: 120, half: 12, dMax: 80 });
    assert.ok(Math.abs(m.disparity - d) < 0.5, `got ${m.disparity}`);
    assert.ok(m.ratio > 1.1);
  });
}

test('swap flips the search direction', () => {
  const img = makeStereo(W, H, -10);
  const m = matchDisparity({ rgba: img.data, width2: img.width, height: H, cx: 170, cy: 120, half: 12, swap: true });
  assert.ok(Math.abs(m.disparity - 10) < 0.5, `got ${m.disparity}`);
});

test('patch outside the image returns null', () => {
  const img = makeStereo(W, H, 10);
  assert.equal(matchDisparity({ rgba: img.data, width2: img.width, height: H, cx: 3, cy: 120, half: 12 }), null);
});

test('flat image is rejected as ambiguous or unmatched', () => {
  const data = new Uint8Array(W * 2 * H * 4).fill(128);
  const m = matchDisparity({ rgba: data, width2: W * 2, height: H, cx: 170, cy: 120, half: 12 });
  assert.ok(m === null || m.ratio < 1.1);
});
