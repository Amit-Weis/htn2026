import { arrowAngleFromHeading } from "@lastseen/shared";
import { describe, expect, it } from "vitest";
import { T0, b64, candidate, hx, makeRig, pose, stillPoses } from "../testing/fixtures";
import type { TestRig } from "../testing/fixtures";
import { MockOmni } from "../omni/mock";
import { BudgetExceededError } from "../omni/types";
import type { OmniClient } from "../omni/types";
import { NoCropper, cropRect, shouldCrop } from "./crop";
import { fetchDetections } from "./detector";
import { chooseBox, describeCrop, extract, intake, reconcile } from "./pipeline";
import type { PlacementEvent } from "@lastseen/shared";

const close = (a: number, b: number, eps = 0.02) => expect(Math.abs(a - b)).toBeLessThan(eps);

async function run(rig: TestRig, c = candidate()) {
  const r = intake(rig.deps, c);
  if (!r.accepted) return { intake: r } as const;
  const ex = await extract(rig.deps, r.candidateId);
  const cr = await describeCrop(rig.deps, r.candidateId);
  const sum = await reconcile(rig.deps, r.candidateId);
  return { intake: r, ex, cr, sum, id: r.candidateId } as const;
}
const reasonsOf = (rig: TestRig) => rig.traces.filter((t) => (t.result as { dropped?: boolean })?.dropped).map((t) => (t.result as { reason: string }).reason);

describe("keys on a table, with detector boxes", () => {
  it("creates one object positioned from the chosen detector box", async () => {
    const rig = makeRig();
    const r = await run(rig);
    expect(r.sum).toMatchObject({ created: 1, updated: 0 });
    const [o] = rig.ledger.listObjects();
    expect(o).toMatchObject({ label: "keys", zone: "desk", status: "placed", boxSource: "detector" });
    // wearer at (0,0) facing north; box centre 0.7 => +14 deg; 1.5 m
    const s = (14 * Math.PI) / 180;
    close(o!.x!, 1.5 * Math.sin(s));
    close(o!.y!, 1.5 * Math.cos(s));
    // and a later query from (0,0) facing north yields an arrow of +14 deg
    close(arrowAngleFromHeading({ x: o!.x!, y: o!.y! }, { x: 0, y: 0 }, 0), 14, 0.01);
  });

  it("OMNI is told the detector boxes and answers with an index", async () => {
    const rig = makeRig();
    const seen: unknown[] = [];
    const spy = new MockOmni();
    const orig = spy.extractPlacements.bind(spy);
    spy.extractPlacements = (frames, ctx) => (seen.push(ctx.detections), orig(frames, ctx));
    const rig2 = makeRig({ omni: spy });
    const r = await run(rig2, candidate({ detections: [{ label: "cup", score: 0.6, bbox: [0.1, 0.1, 0.1, 0.1] }, { label: "keys", score: 0.9, bbox: [0.6, 0.5, 0.2, 0.15] }] }));
    expect(seen[0]).toHaveLength(2);
    expect(r.sum?.objectIds).toHaveLength(1);
    expect(rig2.ledger.listObjects()[0]).toMatchObject({ label: "keys", boxSource: "detector", box: [0.6, 0.5, 0.2, 0.15] }); // index 1, not the higher-scored... the matching label
    void rig;
  });

  it("crops the chosen box from the full-res still and lets OMNI describe it", async () => {
    const rig = makeRig();
    const r = await run(rig, candidate({ still: true }));
    expect(r.cr).toMatchObject({ cropped: 1 });
    expect(rig.traces.some((t) => t.tool === "describeCrop")).toBe(true);
    expect(rig.ledger.listObjects()[0]!.features).toContain("mock-crop");
  });

  it("does not crop when no large frame exists, and skips quietly when no cropper is available", async () => {
    const small = makeRig();
    expect((await run(small)).cr).toMatchObject({ cropped: 0 });
    const noCrop = makeRig({ cropper: new NoCropper() });
    const r = await run(noCrop, candidate({ still: true }));
    expect(r.cr).toMatchObject({ cropped: 0 });
    expect(noCrop.traces.some((t) => t.tool === "crop_skipped")).toBe(true);
    expect(r.sum?.created).toBe(1); // ingest still completed
  });
});

describe("fallbacks when detection is missing", () => {
  it("OMNI answering null falls back to OMNI's own bbox", async () => {
    const rig = makeRig();
    await run(rig, candidate({ detection_index: null, box: [0.1, 0.5, 0.2, 0.2] }));
    const o = rig.ledger.listObjects()[0]!;
    expect(o.boxSource).toBe("omni");
    expect(o.box).toEqual([0.1, 0.5, 0.2, 0.2]);
    // box centre 0.2 => phi = -21 deg
    close(Math.atan2(o.x!, o.y!) * (180 / Math.PI), -21, 0.1);
  });

  it("no detections at all uses OMNI's bbox", async () => {
    const rig = makeRig();
    await run(rig, candidate({ detections: null }));
    expect(rig.ledger.listObjects()[0]!.boxSource).toBe("omni");
  });

  it("no usable box anywhere stores the sighting straight ahead with low confidence", async () => {
    const rig = makeRig();
    await run(rig, candidate({ detections: null, detection_index: null, box: [0, 0, 0, 0] }));
    const o = rig.ledger.listObjects()[0]!;
    expect(o.boxSource).toBe("none");
    expect(o.confidence).toBeLessThan(0.4);
    close(o.x!, 0, 0.001); // phi = 0, heading north
    expect(o.y!).toBeGreaterThan(1);
  });

  it("an out-of-range detection_index is ignored", () => {
    const ev = { detection_index: 7, bbox: [0.2, 0.2, 0.2, 0.2] } as PlacementEvent;
    expect(chooseBox(ev, [{ label: "x", score: 1, bbox: [0, 0, 1, 1] }])).toEqual({ box: [0.2, 0.2, 0.2, 0.2], source: "omni" });
  });
});

describe("optional remote detector (DETECTOR_URL)", () => {
  const cfg = { detectorUrl: "https://det.example/detect", detectorSecret: "s3cret" };

  it("is used only when detections are missing, sends the shared secret, and its boxes drive the position", async () => {
    let seen: { headers: Headers; body: { frames: unknown[] } } | undefined;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      seen = { headers: new Headers(init.headers), body: JSON.parse(String(init.body)) };
      return Response.json({ detections: [[], [], [{ label: "keys", score: 0.95, bbox: [0.6, 0.5, 0.2, 0.15] }]] });
    }) as unknown as typeof fetch;
    const rig = makeRig({ cfg, fetchImpl });
    await run(rig, candidate({ detections: null }));
    expect(seen?.headers.get("X-Detector-Secret")).toBe("s3cret");
    expect(seen?.body.frames).toHaveLength(3);
    expect(rig.ledger.listObjects()[0]!.boxSource).toBe("detector");

    let called = false;
    const rig2 = makeRig({ cfg, fetchImpl: (async () => ((called = true), Response.json({ detections: [] }))) as unknown as typeof fetch });
    await run(rig2); // phone already sent detections
    expect(called).toBe(false);
  });

  it("failure or garbage never blocks ingest", async () => {
    for (const fetchImpl of [
      (async () => { throw new Error("down"); }) as unknown as typeof fetch,
      (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
      (async () => Response.json({ wrong: true })) as unknown as typeof fetch,
    ]) {
      const rig = makeRig({ cfg, fetchImpl });
      const r = await run(rig, candidate({ detections: null }));
      expect(r.sum?.created).toBe(1);
      expect(rig.ledger.listObjects()[0]!.boxSource).toBe("omni");
    }
  });

  it("times out after 2 s", async () => {
    const fetchImpl = ((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    const t0 = Date.now();
    const out = await fetchDetections([{ t: T0, w: 1, h: 1, jpegBase64: "x" }], { url: "https://x", secret: "s", timeoutMs: 50, fetchImpl });
    expect(out).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("guards inside intake write a trace with the reason", () => {
  it("walking, duplicate, cooldown and rate_limit each leave a dropped trace", async () => {
    const rig = makeRig();
    expect((await run(rig, candidate({ t: T0, hash: hx(0) }))).intake.accepted).toBe(true);
    // duplicate (same hash, past cooldown)
    expect((await run(rig, candidate({ t: T0 + 5000, hash: hx(0) }))).intake.accepted).toBe(false);
    // cooldown (different hash, 1 s later)
    expect((await run(rig, candidate({ t: T0 + 1000, hash: hx(1) }))).intake.accepted).toBe(false);
    // walking
    const moving = Array.from({ length: 10 }, (_, i) => pose(T0 + 9000 - i * 100, { stationary: false }));
    expect((await run(rig, candidate({ t: T0 + 9000, hash: hx(2), poseSlice: moving }))).intake.accepted).toBe(false);
    expect(reasonsOf(rig)).toEqual(["duplicate", "cooldown", "walking"]);
    expect(rig.ledger.listObjects()).toHaveLength(1);
  });

  it("a rate-limited device stops calling OMNI", async () => {
    const rig = makeRig({ cfg: { guards: { cooldownMs: 0, maxOmniPerMin: 2, hashWindow: 10, walkFraction: 0.5 } } });
    let calls = 0;
    const omni = new MockOmni();
    const orig = omni.extractPlacements.bind(omni);
    omni.extractPlacements = (f, c) => (calls++, orig(f, c));
    rig.deps.omni = omni;
    for (let i = 0; i < 5; i++) await run(rig, candidate({ t: T0 + i * 10, hash: hx(i), label: `thing${i}` }));
    expect(calls).toBe(2);
    expect(reasonsOf(rig)).toEqual(["rate_limit", "rate_limit", "rate_limit"]);
  });
});

describe("reconcile", () => {
  it("re-placing the same object elsewhere updates it instead of creating a duplicate", async () => {
    const rig = makeRig();
    await run(rig, candidate({ t: T0, label: "keys", hash: hx(3) }));
    const before = rig.ledger.listObjects()[0]!;
    await run(rig, candidate({ t: T0 + 10_000, label: "keys", box: [0.1, 0.5, 0.2, 0.2], event: { zone_name: "kitchen counter", distance_m: 2 }, hash: hx(4) }));
    const all = rig.ledger.listObjects();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(before.id);
    expect(all[0]).toMatchObject({ zone: "kitchen counter", status: "placed", lastSeenAt: T0 + 10_000 });
    expect(all[0]!.x).not.toBeCloseTo(before.x!, 1);
    expect(rig.ledger.sightingCount(before.id)).toBe(2);
  });

  it("different objects stay separate", async () => {
    const rig = makeRig();
    await run(rig, candidate({ t: T0, label: "keys", hash: hx(3) }));
    await run(rig, candidate({ t: T0 + 10_000, label: "mug", box: [0.2, 0.4, 0.2, 0.2], event: { zone_name: "shelf" }, hash: hx(4) }));
    expect(rig.ledger.listObjects().map((o) => o.label).sort()).toEqual(["keys", "mug"]);
  });

  it("picked_up marks the object held and keeps its last known location", async () => {
    const rig = makeRig();
    await run(rig, candidate({ t: T0, hash: hx(3) }));
    const placed = rig.ledger.listObjects()[0]!;
    const r = await run(rig, candidate({ t: T0 + 10_000, hash: hx(4), event: { kind: "picked_up" } }));
    expect(r.sum).toMatchObject({ held: 1, created: 0 });
    const held = rig.ledger.getObject(placed.id)!;
    expect(held.status).toBe("held");
    expect([held.x, held.y]).toEqual([placed.x, placed.y]);
  });

  it("picking up something never seen creates nothing", async () => {
    const rig = makeRig();
    await run(rig, candidate({ event: { kind: "picked_up" } }));
    expect(rig.ledger.listObjects()).toHaveLength(0);
    expect(rig.traces.some((t) => t.tool === "picked_up_unknown")).toBe(true);
  });

  it("uses the pose at the frame time, not the latest pose", async () => {
    const rig = makeRig();
    const slice = [pose(T0 - 1000, { x: 0, y: 0 }), pose(T0, { x: 10, y: 0, headingDeg: 90 })];
    await run(rig, candidate({ poseSlice: slice, box: [0.45, 0.5, 0.1, 0.1] })); // centred => straight ahead = east
    const o = rig.ledger.listObjects()[0]!;
    close(o.x!, 11.5, 0.05);
    close(o.y!, 0, 0.05);
  });

  it("keeps only the thumbnail frame; the other keyframes and narration audio are deleted", async () => {
    const rig = makeRig();
    const r = await run(rig, candidate({ narration: "putting my keys here", trigger: "voice" }));
    expect(rig.ledger.framesOf(r.id!)).toHaveLength(1);
    expect(rig.ledger.getBlob(`narration:${r.id}`)).toBeNull();
    expect(rig.ledger.getFrameJpeg(rig.ledger.listObjects()[0]!.frameId!)).toBeTruthy();
  });

  it("is idempotent under workflow retries", async () => {
    const rig = makeRig();
    const r = await run(rig);
    await extract(rig.deps, r.id!);
    await describeCrop(rig.deps, r.id!);
    const again = await reconcile(rig.deps, r.id!);
    expect(again.objectIds).toEqual(r.sum!.objectIds);
    expect(rig.ledger.listObjects()).toHaveLength(1);
    expect(rig.ledger.sightingCount()).toBe(1);
  });
});

describe("voice narration trigger", () => {
  it("names the object from the narration and is exempt from the walking guard", async () => {
    const rig = makeRig();
    const walkingSlice = Array.from({ length: 10 }, (_, i) => pose(T0 - i * 100, { stationary: false }));
    const c = candidate({ trigger: "voice", narration: "putting my wallet here", detections: [{ label: "book", score: 0.7, bbox: [0.6, 0.5, 0.2, 0.15] }], poseSlice: walkingSlice, event: undefined });
    // strip the scripted event so the mock has to use narration + detections
    c.frames = c.frames.map((f) => ({ ...f, jpegBase64: b64({ note: "plain frame" }) }));
    const r = await run(rig, c);
    expect(r.intake.accepted).toBe(true);
    expect(rig.ledger.listObjects()[0]).toMatchObject({ label: "wallet", boxSource: "detector" });
  });
});

describe("failure modes", () => {
  it("budget exhaustion fails the candidate cleanly without throwing", async () => {
    const omni = new MockOmni();
    omni.extractPlacements = async () => {
      throw new BudgetExceededError(30, 30);
    };
    const rig = makeRig({ omni: omni as OmniClient });
    const r = await run(rig);
    expect(r.ex).toMatchObject({ events: 0, skipped: "budget" });
    expect(rig.ledger.listObjects()).toHaveLength(0);
  });
  it("transient OMNI errors propagate so the Workflow retries the step", async () => {
    const omni = new MockOmni();
    omni.extractPlacements = async () => {
      throw new Error("502");
    };
    const rig = makeRig({ omni: omni as OmniClient });
    const c = intake(rig.deps, candidate());
    if (!c.accepted) throw new Error("setup");
    await expect(extract(rig.deps, c.candidateId)).rejects.toThrow("502");
    expect(rig.ledger.getCandidate(c.candidateId)!.status).toBe("queued");
  });
});

describe("crop geometry", () => {
  it("grows the box by the margin and clamps to the image", () => {
    expect(cropRect([0.4, 0.4, 0.2, 0.2], 1000, 1000, 0.25)).toEqual({ left: 350, top: 350, width: 300, height: 300 });
    expect(cropRect([0, 0, 0.2, 0.2], 1000, 1000, 0.25)).toEqual({ left: 0, top: 0, width: 250, height: 250 });
    const edge = cropRect([0.9, 0.9, 0.2, 0.2], 1000, 1000, 0.25);
    expect(edge.left + edge.width).toBe(1000);
    expect(edge.top + edge.height).toBe(1000);
  });
  it("only crops large frames", () => {
    expect(shouldCrop(640, 480, 1_000_000)).toBe(false);
    expect(shouldCrop(1920, 1080, 1_000_000)).toBe(true);
    expect(shouldCrop(0, 0, 1)).toBe(false);
  });
});

describe("stillPoses fixture sanity", () => {
  it("is stationary", () => expect(stillPoses(T0).every((p) => p.stationary)).toBe(true));
});
