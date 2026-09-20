// Smoke test of the HTTP API (POST /api/ingest, POST /api/query, GET /api/memory) against a running worker.
// This is the path the Unity client uses: no WebSocket, no phone-side filter, the pose and frame travel in the body.
import jpeg from "jpeg-js";

/**
 * Deterministic side-by-side test image: a sum of sines, sampled continuously so fractional disparities are exact.
 * Same generator as apps/worker/src/testing/stereoImage.ts (kept separate so the sim does not import worker sources).
 */
function stereoJpegB64(W: number, H: number, d: number): string {
  let s = 12345;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const waves = Array.from({ length: 24 }, () => ({ fx: (rnd() * 0.6 + 0.05) * (rnd() < 0.5 ? -1 : 1), fy: (rnd() * 0.6 + 0.05) * (rnd() < 0.5 ? -1 : 1), p: rnd() * 6.28, a: 10 + rnd() * 10 }));
  const T = (x: number, y: number) => waves.reduce((sum, w) => sum + w.a * Math.sin(w.fx * x + w.fy * y + w.p), 128);
  const data = new Uint8Array(W * 2 * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      for (const [ox, val] of [[0, T(x, y)], [W, T(x + d, y)]] as const) {
        const v = Math.max(0, Math.min(255, val));
        const i = (y * W * 2 + ox + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
  return Buffer.from(jpeg.encode({ data, width: W * 2, height: H }, 92).data).toString("base64");
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

/** Read a dotted path out of parsed JSON; anything missing is undefined. */
const at = (o: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((v, k) => (v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);

interface Opts {
  url: string;
  token: string;
  log: (s: string) => void;
}

export async function runHttpSmoke({ url, token, log }: Opts): Promise<boolean> {
  const device = `http-${Math.random().toString(36).slice(2, 8)}`;
  let failed = 0;
  const check = (ok: boolean, what: string, detail?: unknown) => {
    log(`  ${ok ? "✓" : "✗"} ${what}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 300)}`}`);
    if (!ok) failed++;
  };
  const call = async (method: string, path: string, body?: unknown, auth = true) => {
    const res = await fetch(`${url}${path}${path.includes("?") ? "&" : "?"}device=${device}`, {
      method,
      headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, text };
  };

  log(`▶ http api (device ${device})`);
  const t = Date.now();
  const pose = (dt: number) => ({ t: t + dt, x: 0, y: 0, headingDeg: 0, steps: 0, confidence: 1, stationary: true });
  const box = [0.6, 0.5, 0.2, 0.15];
  const event = { kind: "placed", label: "keys", description: "A ring of keys on the desk", distinguishing_features: ["silver"], surface: "desk", zone_name: "desk", bbox: box, distance_m: 1.5, holder: "wearer", confidence: 0.9 };
  const frame = (dt: number, last: boolean) => ({ t: t + dt, w: 640, h: 480, hash: last ? "0f0f0f0f" : `e${dt}`, jpegBase64: b64(last ? { mock: { events: [event] } } : { note: "early" }) });
  const candidate = {
    t,
    trigger: "detector",
    frames: [frame(-1000, false), frame(-500, false), frame(0, true)],
    detections: [[], [], [{ label: "keys", score: 0.9, bbox: box }]],
    stereo: { jpegBase64: stereoJpegB64(320, 240, 10) },
    poseSlice: Array.from({ length: 10 }, (_, i) => pose(-900 + i * 100)),
    hfovDeg: 70,
  };

  check((await call("GET", "/api/memory", undefined, false)).status === 401, "memory without a token is 401");
  check((await call("GET", "/api/ingest")).status === 405, "GET /api/ingest is 405");
  const bad = await call("POST", "/api/ingest", { t, trigger: "detector", frames: [], poseSlice: [], hfovDeg: 70 });
  check(bad.status === 400 && String(at(bad.json, "error")).includes("frames"), "invalid candidate is 400 and names the field", bad.json);
  check((await call("POST", "/api/query", {})).status === 400, "empty query is 400");

  const ing = await call("POST", "/api/ingest?wait=1", candidate);
  check(ing.status === 200 && at(ing.json, "accepted") === true, "ingest accepted and reconciled", ing.json);
  const obj = at(ing.json, "objects.0");
  check(at(obj, "label") === "keys", "the object came back in the ingest response", obj);
  check(at(obj, "posSource") === "stereo", "position came from stereo depth", obj);
  check(typeof at(obj, "heightM") === "number", "height was measured", obj);
  const range = Math.hypot(Number(at(obj, "x")), Number(at(obj, "y")));
  check(range > 1.0 && range < 2.0 && Math.abs(range - 1.5) > 0.02, "range is the stereo one, not OMNI's 1.5 m", range);

  const dup = await call("POST", "/api/ingest", candidate);
  check(dup.status === 200 && at(dup.json, "accepted") === false && typeof at(dup.json, "reason") === "string", "the same candidate again is dropped with a reason", dup.json);

  const q = await call("POST", "/api/query", { text: "where are my keys", poseAtT: pose(30_000) });
  check(q.status === 200 && at(q.json, "addressed") === true, "query answered", q.json);
  check(at(q.json, "target.label") === "keys", "the query set the keys as the HUD target", at(q.json, "target"));
  check(typeof at(q.json, "target.x") === "number" && typeof at(q.json, "target.heightM") === "number", "target carries x, y and height", at(q.json, "target"));
  check(String(at(q.json, "text") ?? "").length > 0, "there is a spoken reply", at(q.json, "text"));

  const mem = await call("GET", "/api/memory");
  const objects = at(mem.json, "objects");
  check(mem.status === 200 && Array.isArray(objects) && objects.length === 1, "memory lists the one object", objects);
  check(at(mem.json, "ingest.accepted") === 1 && at(mem.json, "ingest.dropped") === 1, "ingest stats: 1 accepted, 1 dropped", at(mem.json, "ingest"));
  const traces = at(mem.json, "traces");
  check(Array.isArray(traces) && traces.some((tr) => at(tr, "tool") === "stereo"), "the stereo step is traced", Array.isArray(traces) ? traces.length : traces);

  // POST /api/intent: stateless "did the wearer ask to be pointed to the hacker badge?" (the on-device detector already knows where it is)
  check((await call("POST", "/api/intent", { text: "where is my hacker badge" }, false)).status === 401, "intent without a token is 401");
  check((await call("GET", "/api/intent")).status === 405, "GET /api/intent is 405");
  check((await call("POST", "/api/intent", {})).status === 400, "empty intent is 400");
  for (const say of ["where is my hacker badge", "find my hacker tag", "I lost my name tag"]) {
    const r = await call("POST", "/api/intent", { text: say });
    check(r.status === 200 && at(r.json, "wants") === "hacker_card", `"${say}" wants the hacker card`, r.json);
  }
  const voiced = await call("POST", "/api/intent", { audioB64: b64({ mockTranscript: "point me to my hacker badge" }), mime: "audio/wav" });
  check(at(voiced.json, "wants") === "hacker_card" && at(voiced.json, "heard") === "point me to my hacker badge", "a spoken request is understood", voiced.json);
  const other = await call("POST", "/api/intent", { text: "where are my keys" });
  check(other.status === 200 && at(other.json, "wants") === null, "another object does not trigger the arrow", other.json);
  for (const say of ["I found my hacker tag", "got my badge"]) {
    const r = await call("POST", "/api/intent", { text: say });
    check(r.status === 200 && at(r.json, "found") === "hacker_card" && at(r.json, "wants") === null, `"${say}" says it was found`, r.json);
  }
  const foundKeys = await call("POST", "/api/intent", { text: "I found my keys" });
  check(at(foundKeys.json, "found") === null && at(foundKeys.json, "wants") === null, "finding something else does not hide the arrow", foundKeys.json);
  const idle = await call("POST", "/api/intent", { text: "what a nice hacker badge" });
  check(idle.status === 200 && at(idle.json, "wants") === null, "a mention that is not a request does not trigger it", idle.json);

  log(`${failed ? "FAIL" : "PASS"} http api\n`);
  return failed === 0;
}
