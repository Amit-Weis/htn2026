import jpeg from "jpeg-js";
import type { StereoImage } from "../ingest/stereo";

/**
 * Deterministic side-by-side test image: a sum of sines sampled continuously, so fractional disparities are exact.
 * A left point at x appears at right x - d, i.e. right(x) = T(x + d). (Same generator as cloudflare/locator/test/synthetic.js.)
 */
export function makeStereo(W: number, H: number, d: number): StereoImage {
  let s = 12345;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const waves = Array.from({ length: 24 }, () => ({
    fx: (rnd() * 0.6 + 0.05) * (rnd() < 0.5 ? -1 : 1),
    fy: (rnd() * 0.6 + 0.05) * (rnd() < 0.5 ? -1 : 1),
    p: rnd() * 6.28,
    a: 10 + rnd() * 10,
  }));
  const T = (x: number, y: number) => waves.reduce((sum, w) => sum + w.a * Math.sin(w.fx * x + w.fy * y + w.p), 128);
  const rgba = new Uint8Array(W * 2 * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (const [ox, val] of [[0, T(x, y)], [W, T(x + d, y)]] as const) {
        const v = Math.max(0, Math.min(255, val));
        const i = (y * W * 2 + ox + x) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
        rgba[i + 3] = 255;
      }
    }
  }
  return { rgba, width2: W * 2, height: H };
}

export function stereoJpegBase64(img: StereoImage, quality = 92): string {
  const out = jpeg.encode({ data: img.rgba, width: img.width2, height: img.height }, quality).data;
  let bin = "";
  for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return btoa(bin);
}
