// Deterministic stereo test image: a sum of sines, sampled continuously so fractional disparities are exact.
// A left point at x appears at right x - d, so right(x) = T(x + d).
export function makeStereo(W, H, d) {
  let s = 12345;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const waves = Array.from({ length: 24 }, () => ({
    fx: (rnd() * 0.6 + 0.05) * (rnd() < 0.5 ? -1 : 1),
    fy: (rnd() * 0.6 + 0.05) * (rnd() < 0.5 ? -1 : 1),
    p: rnd() * 6.28,
    a: 10 + rnd() * 10,
  }));
  const T = (x, y) => waves.reduce((sum, w) => sum + w.a * Math.sin(w.fx * x + w.fy * y + w.p), 128);
  const data = new Uint8Array(W * 2 * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (const [ox, val] of [[0, T(x, y)], [W, T(x + d, y)]]) {
        const v = Math.max(0, Math.min(255, val));
        const i = (y * W * 2 + ox + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
  }
  return { data, width: W * 2, height: H };
}
