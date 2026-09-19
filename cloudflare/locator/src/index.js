import jpeg from 'jpeg-js';
import { matchDisparity } from './stereo.js';

// Reject matches that are barely better than the runner-up (flat / repetitive texture).
const MIN_MATCH_RATIO = 1.1;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const num = (v, fallback) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

function cropLeft(img, W) {
  const H = img.height;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    out.set(img.data.subarray(y * img.width * 4, (y * img.width + W) * 4), y * W * 4);
  }
  return out;
}

// Body: JPEG of two cameras side by side (left | right). Query: label=<target>, optional
// fx, fy, cx, cy (pixels at the sent size) and baseline (meters) to override the defaults in wrangler.toml.
// Response matches Depth/LocateResponse.cs in the Unity project.
export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return json({ found: false, error: 'POST a side-by-side JPEG' }, 405);

    const q = new URL(request.url).searchParams;
    const label = (q.get('label') || 'target').toLowerCase();

    let img;
    try {
      img = jpeg.decode(new Uint8Array(await request.arrayBuffer()), { useTArray: true, formatAsRGBA: true });
    } catch (e) {
      return json({ found: false, error: 'bad JPEG: ' + e.message }, 400);
    }
    const W = img.width >> 1;
    const H = img.height;

    // Calibration defaults: pinhole with the configured horizontal FOV, principal point at the center.
    const hfov = num(env.HFOV_DEG, 65);
    const fx = num(q.get('fx'), W / 2 / Math.tan((hfov * Math.PI) / 360));
    const fy = num(q.get('fy'), fx);
    const cx = num(q.get('cx'), W / 2);
    const cy = num(q.get('cy'), H / 2);
    const baseline = num(q.get('baseline'), num(env.BASELINE_M, 0.06));

    // 1. Find the target in the left image.
    const leftJpeg = jpeg.encode({ data: cropLeft(img, W), width: W, height: H }, 85).data;
    let dets = await env.AI.run(env.DETECT_MODEL, { image: Array.from(leftJpeg) });
    const minScore = num(env.MIN_SCORE, 0.5);
    dets = (dets || [])
      .filter((d) => d.score >= minScore && (label === 'target' || label === 'any' || d.label.toLowerCase() === label))
      .sort((a, b) => b.score - a.score);
    if (!dets.length) return json({ found: false, error: `no "${label}" in the photo` });
    const det = dets[0];
    const { xmin, ymin, xmax, ymax } = det.box;
    const u = (xmin + xmax) / 2;
    const v = (ymin + ymax) / 2;

    // 2. Depth from the disparity of the box center patch.
    const half = Math.max(6, Math.min(24, Math.round(Math.min(xmax - xmin, ymax - ymin) / 4)));
    const m = matchDisparity({
      rgba: img.data,
      width2: img.width,
      height: H,
      cx: u,
      cy: v,
      half,
      dMax: Math.floor(W / 4),
      swap: env.STEREO_SWAP === '1',
    });
    if (!m || m.ratio < MIN_MATCH_RATIO || m.disparity < 1) {
      return json({ found: false, error: 'could not get a reliable stereo match on the target' });
    }

    return json({
      found: true,
      label: det.label,
      confidence: det.score,
      u,
      v,
      depth_m: (fx * baseline) / m.disparity,
      width: W,
      height: H,
      fx,
      fy,
      cx,
      cy,
      timestamp_ns: Date.now() * 1e6,
      disparity_px: m.disparity,
      match_ratio: m.ratio,
    });
  },
};
