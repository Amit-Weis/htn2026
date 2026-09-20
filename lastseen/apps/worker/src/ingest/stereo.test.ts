import { describe, expect, it } from "vitest";
import { makeStereo, stereoJpegBase64 } from "../testing/stereoImage";
import { decodeStereo, estimateDepth, matchDisparity } from "./stereo";

const W = 320;
const H = 240;

describe("matchDisparity", () => {
  for (const d of [4, 10.5, 37.25]) {
    it(`recovers disparity ${d}`, () => {
      const img = makeStereo(W, H, d);
      const m = matchDisparity({ ...img, cx: 170, cy: 120, half: 12, dMax: 80 });
      expect(Math.abs(m!.disparity - d)).toBeLessThan(0.5);
      expect(m!.ratio).toBeGreaterThan(1.1);
    });
  }

  it("swap flips the search direction", () => {
    const img = makeStereo(W, H, -10);
    const m = matchDisparity({ ...img, cx: 170, cy: 120, half: 12, swap: true });
    expect(Math.abs(m!.disparity - 10)).toBeLessThan(0.5);
  });

  it("returns null for a patch outside the image", () => {
    expect(matchDisparity({ ...makeStereo(W, H, 10), cx: 3, cy: 120, half: 12 })).toBeNull();
  });

  it("a flat image is unmatched or ambiguous", () => {
    const m = matchDisparity({ rgba: new Uint8Array(W * 2 * H * 4).fill(128), width2: W * 2, height: H, cx: 170, cy: 120, half: 12 });
    expect(m === null || m.ratio < 1.1).toBe(true);
  });
});

describe("estimateDepth", () => {
  // fx = 160 / tan(32.5 deg) = 251.2 px for a 320 px half and a 65 degree FOV; baseline 0.06 m
  const opts = { hfovDeg: 65, baselineM: 0.06 };
  const fx = W / 2 / Math.tan((65 * Math.PI) / 360);

  it("turns a 10 px disparity into fx * baseline / 10", () => {
    const r = estimateDepth(makeStereo(W, H, 10), [0.45, 0.4, 0.15, 0.2], opts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Math.abs(r.depthM - (fx * 0.06) / 10)).toBeLessThan(0.06);
  });

  it("survives a JPEG round trip", () => {
    const img = decodeStereo(stereoJpegBase64(makeStereo(W, H, 12)));
    expect(img).not.toBeNull();
    const r = estimateDepth(img!, [0.45, 0.4, 0.15, 0.2], opts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Math.abs(r.disparityPx - 12)).toBeLessThan(1);
  });

  it("rejects a match that implies more than the maximum depth", () => {
    const r = estimateDepth(makeStereo(W, H, 1.5), [0.45, 0.4, 0.15, 0.2], { ...opts, maxDepthM: 8 });
    expect(r).toMatchObject({ ok: false });
  });

  it("reports a box at the image edge as out_of_image", () => {
    expect(estimateDepth(makeStereo(W, H, 10), [0, 0.4, 0.02, 0.1], opts)).toEqual({ ok: false, reason: "out_of_image" });
  });

  it("decodeStereo never throws on garbage", () => {
    expect(decodeStereo("not a jpeg")).toBeNull();
    expect(decodeStereo(btoa("hello world, definitely not a jpeg"))).toBeNull();
  });
});
