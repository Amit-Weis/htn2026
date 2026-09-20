import { objectPositionFromDepth } from "@lastseen/shared";
import { describe, expect, it } from "vitest";
import { Ledger } from "../ledger";
import { candidate, makeRig } from "../testing/fixtures";
import { memorySql } from "../testing/sql";
import { makeStereo, stereoJpegBase64 } from "../testing/stereoImage";
import { describeCrop, extract, intake, reconcile } from "./pipeline";
import type { TestRig } from "../testing/fixtures";
import type { PlacementCandidate } from "@lastseen/shared";

const W = 320;
const H = 240;
const HFOV = 70; // candidate() uses 70 degrees

async function run(rig: TestRig, c: PlacementCandidate) {
  const r = intake(rig.deps, c);
  if (!r.accepted) throw new Error("dropped");
  await extract(rig.deps, r.candidateId);
  await describeCrop(rig.deps, r.candidateId);
  await reconcile(rig.deps, r.candidateId);
  return r.candidateId;
}

const withStereo = (c: PlacementCandidate, disparity: number, extra: Partial<NonNullable<PlacementCandidate["stereo"]>> = {}): PlacementCandidate => ({
  ...c,
  stereo: { jpegBase64: stereoJpegBase64(makeStereo(W, H, disparity)), ...extra },
});

describe("stereo depth in ingest", () => {
  it("positions the object from the measured depth instead of OMNI's 1.5 m", async () => {
    const rig = makeRig();
    const id = await run(rig, withStereo(candidate(), 10)); // box centre (0.7, 0.575)
    const o = rig.ledger.listObjects()[0]!;
    expect(o.posSource).toBe("stereo");

    const fx = W / 2 / Math.tan((HFOV * Math.PI) / 360);
    const depth = (fx * 0.06) / 10;
    const want = objectPositionFromDepth({ x: 0, y: 0 }, 0, 0.7, 0.575, depth, HFOV, W / H);
    expect(Math.abs(o.x! - want.x)).toBeLessThan(0.08);
    expect(Math.abs(o.y! - want.y)).toBeLessThan(0.08);
    expect(o.z).toBeLessThan(0); // below the camera axis
    expect(Math.hypot(o.x!, o.y!)).not.toBeCloseTo(1.5, 1);

    const st = rig.traces.find((t) => t.tool === "stereo");
    expect(st?.result).toMatchObject({ ok: true });
    expect(rig.ledger.toRow(o, "d")).toMatchObject({ posSource: "stereo", heightM: o.z });
    expect(id).toBeTruthy();
  });

  it("uses the baseline and swap the candidate sends", async () => {
    const rig = makeRig();
    await run(rig, withStereo(candidate(), 10, { baselineM: 0.12 }));
    const doubled = Math.hypot(rig.ledger.listObjects()[0]!.x!, rig.ledger.listObjects()[0]!.y!);
    const rig2 = makeRig();
    await run(rig2, withStereo(candidate(), 10));
    const base = Math.hypot(rig2.ledger.listObjects()[0]!.x!, rig2.ledger.listObjects()[0]!.y!);
    expect(doubled / base).toBeCloseTo(2, 1);
  });

  it("falls back to OMNI's distance when the match is ambiguous, and says why", async () => {
    const rig = makeRig();
    const flat = { rgba: new Uint8Array(W * 2 * H * 4).fill(128), width2: W * 2, height: H };
    await run(rig, { ...candidate(), stereo: { jpegBase64: stereoJpegBase64(flat) } });
    const o = rig.ledger.listObjects()[0]!;
    expect(o.posSource).toBe("omni");
    expect(o.z).toBeNull();
    expect(rig.traces.find((t) => t.tool === "stereo")?.result).toMatchObject({ ok: false });
    // OMNI said 1.5 m along +14 deg
    expect(Math.hypot(o.x!, o.y!)).toBeCloseTo(1.5, 1);
  });

  it("falls back when the stereo JPEG is not decodable", async () => {
    const rig = makeRig();
    await run(rig, { ...candidate(), stereo: { jpegBase64: btoa("not a jpeg") } });
    expect(rig.ledger.listObjects()[0]!.posSource).toBe("omni");
    expect(rig.traces.find((t) => t.tool === "stereo")?.result).toMatchObject({ ok: false });
  });

  it("without a detector or OMNI box there is nothing to measure at: default range", async () => {
    const rig = makeRig();
    await run(rig, withStereo(candidate({ detections: null, detection_index: null, box: [0, 0, 0, 0], event: { distance_m: null } }), 10));
    const o = rig.ledger.listObjects()[0]!;
    expect(o.boxSource).toBe("none");
    expect(o.posSource).toBe("default");
  });

  it("does not keep the stereo pair after reconcile (privacy)", async () => {
    const rig = makeRig();
    const id = await run(rig, withStereo(candidate(), 10));
    expect(rig.ledger.getBlob(`stereo:${id}`)).toBeNull();
  });

  it("drops an oversize stereo pair with a trace but still ingests", async () => {
    const rig = makeRig();
    const c = { ...candidate(), stereo: { jpegBase64: "A".repeat(1_400_001) } };
    await run(rig, c);
    expect(rig.traces.some((t) => t.tool === "stereo_dropped")).toBe(true);
    expect(rig.ledger.listObjects()).toHaveLength(1);
  });
});

describe("ledger schema migration", () => {
  it("adds the new columns to a table created by the first deploy", () => {
    const sql = memorySql();
    sql`CREATE TABLE objects (
      id TEXT PRIMARY KEY, label TEXT, description TEXT, features TEXT, status TEXT,
      x REAL, y REAL, zone TEXT, last_seen_at INTEGER, confidence REAL,
      frame_id TEXT, box TEXT, box_source TEXT)`;
    sql`INSERT INTO objects VALUES ('o1','keys','d','[]','placed',1,2,'desk',5,0.9,NULL,NULL,'none')`;
    const ledger = new Ledger(sql);
    expect(ledger.getObject("o1")).toMatchObject({ label: "keys", z: null, posSource: "omni" });
    ledger.updateObject("o1", { z: 0.4, posSource: "stereo" });
    expect(ledger.getObject("o1")).toMatchObject({ z: 0.4, posSource: "stereo" });
    expect(() => new Ledger(sql)).not.toThrow(); // second init on the migrated table is a no-op
  });
});
