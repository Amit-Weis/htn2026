import jpeg from "jpeg-js";

/**
 * Stereo depth for one object. Ported from the teammates' `cloudflare/locator` Worker (block matching on the centre patch
 * of the detected box), with the same conventions:
 *  - the image is ONE side-by-side frame, left camera on the left half, right camera on the right half;
 *  - a point at left x appears at right x - d (x + d when `swap`) for disparity d > 0;
 *  - depth = fx * baseline / disparity, with fx from the horizontal FOV of ONE half.
 * The baseline and FOV defaults are placeholders until measured on the Beam Pro (see docs/DECISIONS.md).
 */

export interface StereoImage {
  /** RGBA of the whole side-by-side image */
  rgba: Uint8Array;
  /** full width (both halves) */
  width2: number;
  height: number;
}

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Decode a side-by-side JPEG. Returns null (never throws) for anything that is not a decodable JPEG with an even width. */
export function decodeStereo(jpegBase64: string): StereoImage | null {
  try {
    const img = jpeg.decode(b64ToBytes(jpegBase64), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 96 });
    if (img.width < 16 || img.height < 16) return null;
    return { rgba: img.data as unknown as Uint8Array, width2: img.width, height: img.height };
  } catch {
    return null;
  }
}

const gray = (d: Uint8Array, i: number) => 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;

export interface DisparityMatch {
  /** sub-pixel disparity */
  disparity: number;
  /** mean absolute difference per pixel at the best match */
  cost: number;
  /** second-best cost / best cost: near 1 means an ambiguous (flat or repetitive) match */
  ratio: number;
}

export interface MatchArgs {
  rgba: Uint8Array;
  width2: number;
  height: number;
  /** patch centre in the LEFT image, pixels */
  cx: number;
  cy: number;
  half?: number;
  dMin?: number;
  dMax?: number;
  vRange?: number;
  swap?: boolean;
}

/** Block-matching disparity of one patch, or null when the patch (or every search position) falls outside the image. */
export function matchDisparity(a: MatchArgs): DisparityMatch | null {
  const { rgba, width2, height } = a;
  const half = a.half ?? 12;
  const dMin = a.dMin ?? 1;
  const dMax = a.dMax ?? 80;
  const vRange = a.vRange ?? 2;
  const W = width2 >> 1;
  const sign = a.swap ? 1 : -1;
  const cx = Math.round(a.cx);
  const cy = Math.round(a.cy);
  if (cx - half < 0 || cx + half >= W || cy - half < 0 || cy + half >= height) return null;

  const costs = new Float64Array(dMax + 2).fill(Infinity);
  for (let d = dMin; d <= dMax; d++) {
    const xr = cx + sign * d;
    if (xr - half < 0 || xr + half >= W) continue;
    let best = Infinity;
    for (let dy = -vRange; dy <= vRange; dy++) {
      if (cy + dy - half < 0 || cy + dy + half >= height) continue;
      let sad = 0;
      for (let py = -half; py <= half; py++) {
        const li = ((cy + py) * width2 + cx - half) * 4;
        const ri = ((cy + dy + py) * width2 + W + xr - half) * 4;
        for (let px = 0; px <= 2 * half; px++) sad += Math.abs(gray(rgba, li + px * 4) - gray(rgba, ri + px * 4));
      }
      if (sad < best) best = sad;
    }
    costs[d] = best;
  }

  let bd = -1;
  for (let d = dMin; d <= dMax; d++) if (bd < 0 || costs[d]! < costs[bd]!) bd = d;
  if (bd < 0 || !Number.isFinite(costs[bd]!)) return null;

  let second = Infinity;
  for (let d = dMin; d <= dMax; d++) if (Math.abs(d - bd) > 2 && costs[d]! < second) second = costs[d]!;

  let disparity = bd;
  if (bd > dMin && bd < dMax && Number.isFinite(costs[bd - 1]!) && Number.isFinite(costs[bd + 1]!)) {
    const denom = costs[bd - 1]! - 2 * costs[bd]! + costs[bd + 1]!;
    if (denom > 0) disparity += (0.5 * (costs[bd - 1]! - costs[bd + 1]!)) / denom;
  }

  const px = (2 * half + 1) ** 2;
  const cost = costs[bd]! / px;
  // Tied costs (e.g. a perfectly flat patch) are ambiguous even when the best cost is 0.
  const ratio = second === costs[bd]! ? 1 : costs[bd]! > 0 ? second / costs[bd]! : Infinity;
  return { disparity, cost, ratio };
}

export interface DepthOptions {
  /** horizontal FOV of ONE camera image */
  hfovDeg: number;
  baselineM: number;
  swap?: boolean;
  /** reject matches whose second-best/best cost ratio is below this (default 1.1) */
  minRatio?: number;
  /** reject depths beyond this (default 8 m): the disparity is then under about 3 px and mostly noise */
  maxDepthM?: number;
}

export type DepthResult =
  | { ok: true; depthM: number; disparityPx: number; ratio: number; fxPx: number; halfWidth: number; height: number }
  | { ok: false; reason: "no_match" | "ambiguous" | "too_far" | "out_of_image" | "bad_image" };

/** Depth at the centre of `box` ([x, y, w, h] normalized in the LEFT image, origin top-left). */
export function estimateDepth(img: StereoImage, box: readonly [number, number, number, number], o: DepthOptions): DepthResult {
  const W = img.width2 >> 1;
  const H = img.height;
  if (W < 16) return { ok: false, reason: "bad_image" };
  const u = (box[0] + box[2] / 2) * W;
  const v = (box[1] + box[3] / 2) * H;
  const boxPx = Math.min(box[2] * W, box[3] * H);
  const half = Math.max(6, Math.min(24, Math.round(boxPx / 4)));
  const m = matchDisparity({ rgba: img.rgba, width2: img.width2, height: H, cx: u, cy: v, half, dMax: Math.floor(W / 4), swap: o.swap });
  if (!m) return { ok: false, reason: "out_of_image" };
  if (m.disparity < 1) return { ok: false, reason: "no_match" };
  if (m.ratio < (o.minRatio ?? 1.1)) return { ok: false, reason: "ambiguous" };
  const fxPx = W / 2 / Math.tan((o.hfovDeg * Math.PI) / 360);
  const depthM = (fxPx * o.baselineM) / m.disparity;
  if (depthM > (o.maxDepthM ?? 8)) return { ok: false, reason: "too_far" };
  return { ok: true, depthM, disparityPx: m.disparity, ratio: m.ratio, fxPx, halfWidth: W, height: H };
}
