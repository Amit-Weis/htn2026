// Block-matching disparity for one patch of a side-by-side stereo image.
// rgba is the whole side-by-side image (left half | right half), width2 = full width.
// A point at left x appears at right x = x - d (or x + d when swap is true) for disparity d > 0.

const gray = (data, i) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

// Returns { disparity (subpixel), cost (mean abs diff per pixel), ratio (2nd best cost / best) } or null.
// A ratio near 1 means the match is ambiguous (flat or repetitive texture).
export function matchDisparity({ rgba, width2, height, cx, cy, half = 12, dMin = 1, dMax = 80, vRange = 2, swap = false }) {
  const W = width2 >> 1;
  const sign = swap ? 1 : -1;
  cx = Math.round(cx);
  cy = Math.round(cy);
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
        for (let px = 0; px <= 2 * half; px++) {
          sad += Math.abs(gray(rgba, li + px * 4) - gray(rgba, ri + px * 4));
        }
      }
      if (sad < best) best = sad;
    }
    costs[d] = best;
  }

  let bd = -1;
  for (let d = dMin; d <= dMax; d++) if (bd < 0 || costs[d] < costs[bd]) bd = d;
  if (bd < 0 || !Number.isFinite(costs[bd])) return null;

  let second = Infinity;
  for (let d = dMin; d <= dMax; d++) if (Math.abs(d - bd) > 2 && costs[d] < second) second = costs[d];

  let disparity = bd;
  if (bd > dMin && bd < dMax && Number.isFinite(costs[bd - 1]) && Number.isFinite(costs[bd + 1])) {
    const denom = costs[bd - 1] - 2 * costs[bd] + costs[bd + 1];
    if (denom > 0) disparity += (0.5 * (costs[bd - 1] - costs[bd + 1])) / denom;
  }

  const px = (2 * half + 1) ** 2;
  // Tied costs (e.g. a perfectly flat patch) are ambiguous even when the best cost is 0.
  const ratio = second === costs[bd] ? 1 : costs[bd] > 0 ? second / costs[bd] : Infinity;
  return { disparity, cost: costs[bd] / px, ratio };
}
