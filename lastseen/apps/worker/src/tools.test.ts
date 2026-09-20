import { arrowAngle } from "@lastseen/shared";
import type { Frame, Pose, Target } from "@lastseen/shared";
import { describe, expect, it } from "vitest";
import { intake, extract, describeCrop, reconcile } from "./ingest/pipeline";
import { labelsCompatible, fuzzyScore } from "./memory/text";
import { T0, b64, candidate, hx, makeRig, pose } from "./testing/fixtures";
import type { TestRig } from "./testing/fixtures";
import { forget, findObject, guideTo, listRecent, runTool, verifyVisible } from "./tools";
import type { ToolHost } from "./tools";

async function place(rig: TestRig, opts: Parameters<typeof candidate>[0]) {
  const r = intake(rig.deps, candidate(opts));
  if (!r.accepted) throw new Error("not accepted: " + r.reason);
  await extract(rig.deps, r.candidateId);
  await describeCrop(rig.deps, r.candidateId);
  await reconcile(rig.deps, r.candidateId);
}

function host(rig: TestRig, over: Partial<ToolHost> & { frame?: Frame | null } = {}) {
  const state: { target: Target | null; pose: Pose; recentered: number; ledgerNotified: number; spent: number } = { target: null, pose: pose(T0 + 60_000), recentered: 0, ledgerNotified: 0, spent: 0 };
  const h: ToolHost = {
    ledger: rig.ledger, embedder: rig.deps.embedder, vectors: rig.deps.vectors, omni: rig.deps.omni, device: "dev1",
    now: () => T0 + 60_000,
    pose: () => state.pose,
    target: () => state.target,
    setTarget: (t) => { state.target = t; },
    requestFrame: async () => over.frame ?? null,
    sendRecenter: () => { state.recentered++; },
    notifyLedger: () => { state.ledgerNotified++; },
    cfg: { maxRangeM: 15, minConfidence: 0.35, hfovDeg: 70 },
    spent: async () => { state.spent++; },
    ...over,
  };
  return { h, state };
}

async function twoObjects() {
  const rig = makeRig();
  await place(rig, { t: T0, label: "keys", hash: hx(0), box: [0.6, 0.5, 0.2, 0.15], event: { zone_name: "desk", distance_m: 1.5 } });
  await place(rig, { t: T0 + 10_000, label: "mug", hash: hx(1), box: [0.2, 0.4, 0.2, 0.2], event: { zone_name: "shelf", description: "A white ceramic coffee mug", distinguishing_features: ["white", "ceramic", "handle"], distance_m: 2 } });
  return rig;
}

describe("find_object", () => {
  it("matches by label", async () => {
    const rig = await twoObjects();
    const r = (await findObject(host(rig).h, "keys")).candidates as Array<{ label: string; score: number }>;
    expect(r[0]).toMatchObject({ label: "keys" });
    expect(r[0]!.score).toBeGreaterThan(0.6);
  });
  it("matches by meaning: 'my drinking thing' finds the mug", async () => {
    const rig = await twoObjects();
    const r = (await findObject(host(rig).h, "drinking thing")).candidates as Array<{ label: string }>;
    expect(r[0]?.label).toBe("mug");
    expect(r.some((c) => c.label === "keys")).toBe(false);
  });
  it("returns nothing for an unrelated query", async () => {
    const rig = await twoObjects();
    expect((await findObject(host(rig).h, "bicycle")).candidates).toEqual([]);
  });
  it("still works when the semantic index is unavailable (fuzzy only)", async () => {
    const rig = await twoObjects();
    const { h } = host(rig, { vectors: { upsert: async () => { throw new Error("down"); }, query: async () => { throw new Error("down"); }, remove: async () => {} } });
    expect(((await findObject(h, "keys")).candidates as unknown[]).length).toBe(1);
  });
  it("ranks two similar objects close together so the agent can clarify", async () => {
    const rig = makeRig();
    await place(rig, { t: T0, label: "phillips screwdriver", hash: hx(0), box: [0.6, 0.5, 0.2, 0.15], event: { zone_name: "bench" } });
    await place(rig, { t: T0 + 10_000, label: "flathead screwdriver", hash: hx(1), box: [0.2, 0.5, 0.2, 0.15], event: { zone_name: "bench" } });
    const c = (await findObject(host(rig).h, "screwdriver")).candidates as Array<{ label: string; score: number }>;
    expect(c).toHaveLength(2);
    expect(Math.abs(c[0]!.score - c[1]!.score)).toBeLessThan(0.08);
  });
});

describe("guide_to", () => {
  it("sets the HUD target immediately with the right arrow angle", async () => {
    const rig = await twoObjects();
    const { h, state } = host(rig);
    const keys = rig.ledger.listObjects().find((o) => o.label === "keys")!;
    const r = guideTo(h, keys.id);
    expect(r).toMatchObject({ ok: true, label: "keys", zone: "desk", mode: "arrow" });
    expect(state.target).toMatchObject({ objectId: keys.id, mode: "arrow", zone: "desk" });
    // wearer at the origin facing north: the keys were placed +14 deg to the right
    const angle = arrowAngle(state.target!, { x: 0, y: 0, headingDeg: 0 }, null, 0, T0);
    expect(Math.abs(angle - 14)).toBeLessThan(0.1);
    expect(state.target!.ageSec).toBeGreaterThan(0);
  });
  it("falls back to zone mode when pose confidence is low or the object is out of range", async () => {
    const rig = await twoObjects();
    const keys = rig.ledger.listObjects().find((o) => o.label === "keys")!;
    const low = host(rig);
    low.state.pose = pose(T0, { confidence: 0.1 });
    guideTo(low.h, keys.id);
    expect(low.state.target?.mode).toBe("zone");
    const far = host(rig);
    far.state.pose = pose(T0, { x: 200, y: 200 });
    guideTo(far.h, keys.id);
    expect(far.state.target?.mode).toBe("zone");
  });
  it("rejects unknown ids without touching the target", async () => {
    const rig = await twoObjects();
    const { h, state } = host(rig);
    expect(guideTo(h, "nope")).toMatchObject({ ok: false });
    expect(state.target).toBeNull();
  });
});

describe("verify_visible", () => {
  const scripted = (mock: unknown): Frame => ({ t: T0, w: 640, h: 480, jpegBase64: b64({ mock }) });

  it("when the object is still there it retargets to the live bearing and records a sighting", async () => {
    const rig = await twoObjects();
    const keys = rig.ledger.listObjects().find((o) => o.label === "keys")!;
    const { h, state } = host(rig, { frame: scripted({ visible: true, bbox: [0.05, 0.5, 0.1, 0.1], distance_m: 1 }) });
    const r = await verifyVisible(h, keys.id);
    expect(r).toMatchObject({ visible: true });
    const after = rig.ledger.getObject(keys.id)!;
    expect(after.status).toBe("placed");
    expect(after.x).not.toBe(keys.x); // moved to the live bearing (box centre 0.1 => left)
    expect(after.x!).toBeLessThan(0);
    expect(state.target?.objectId).toBe(keys.id);
    expect(rig.ledger.sightingCount(keys.id)).toBe(2);
    expect(state.ledgerNotified).toBeGreaterThan(0);
    expect(state.spent).toBe(1);
  });

  it("catches a mismatch: not visible -> marked moved in the ledger", async () => {
    const rig = await twoObjects();
    const keys = rig.ledger.listObjects().find((o) => o.label === "keys")!;
    const { h, state } = host(rig, { frame: scripted({ visible: false, note: "the desk is empty" }) });
    const r = await verifyVisible(h, keys.id);
    expect(r).toMatchObject({ visible: false, ledgerUpdated: "marked moved" });
    expect(rig.ledger.getObject(keys.id)).toMatchObject({ status: "moved", x: keys.x, y: keys.y }); // last known spot kept
    expect(state.ledgerNotified).toBeGreaterThan(0);
  });

  it("is inconclusive (and leaves the ledger alone) when the phone has no frame", async () => {
    const rig = await twoObjects();
    const keys = rig.ledger.listObjects().find((o) => o.label === "keys")!;
    const r = await verifyVisible(host(rig, { frame: null }).h, keys.id);
    expect(r).toMatchObject({ visible: false, inconclusive: true });
    expect(rig.ledger.getObject(keys.id)!.status).toBe("placed");
  });
});

describe("list_recent / mark_moved / forget / clarify / recenter", () => {
  it("list_recent is newest first and filterable by zone", async () => {
    const rig = await twoObjects();
    const { h } = host(rig);
    expect((listRecent(h, 5).items as Array<{ label: string }>).map((i) => i.label)).toEqual(["mug", "keys"]);
    expect((listRecent(h, 1).items as unknown[]).length).toBe(1);
    expect((listRecent(h, 5, "desk").items as Array<{ label: string }>).map((i) => i.label)).toEqual(["keys"]);
  });
  it("forget one removes it (and its target); forget all wipes everything", async () => {
    const rig = await twoObjects();
    const { h, state } = host(rig);
    const keys = rig.ledger.listObjects().find((o) => o.label === "keys")!;
    guideTo(h, keys.id);
    expect(await forget(h, keys.id)).toEqual({ forgotten: 1 });
    expect(state.target).toBeNull();
    expect(rig.ledger.listObjects().map((o) => o.label)).toEqual(["mug"]);
    expect(await forget(h, "all")).toEqual({ forgotten: 1 });
    expect(rig.ledger.listObjects()).toHaveLength(0);
    expect(rig.ledger.sightingCount()).toBe(0);
    expect(await rig.deps.vectors.query(await rig.deps.embedder.embed("mug"), 5)).toEqual([]);
  });
  it("runTool validates arguments and dispatches", async () => {
    const rig = await twoObjects();
    const { h, state } = host(rig);
    expect(await runTool(h, "find_object", {})).toMatchObject({ error: expect.any(String) });
    expect(await runTool(h, "guide_to", { objectId: 5 })).toMatchObject({ error: expect.any(String) });
    expect(await runTool(h, "clarify", { question: "Which one?" })).toEqual({ question: "Which one?" });
    expect(await runTool(h, "recenter", {})).toEqual({ ok: true });
    expect(state.recentered).toBe(1);
    const keys = rig.ledger.listObjects().find((o) => o.label === "keys")!;
    expect(await runTool(h, "mark_moved", { objectId: keys.id })).toMatchObject({ ok: true });
    expect(rig.ledger.getObject(keys.id)!.status).toBe("moved");
  });
});

describe("text matching", () => {
  it("label compatibility", () => {
    expect(labelsCompatible("keys", "keys")).toBe(true);
    expect(labelsCompatible("car keys", "keys")).toBe(true);
    expect(labelsCompatible("mug", "coffee cup")).toBe(true);
    expect(labelsCompatible("keys", "mug")).toBe(false);
    expect(labelsCompatible("phillips screwdriver", "flathead screwdriver")).toBe(false); // same head noun, conflicting modifiers
    expect(labelsCompatible("red mug", "blue mug")).toBe(false);
    expect(labelsCompatible("mug", "coffee cup")).toBe(true);
  });
  it("fuzzy score orders sensible matches first", () => {
    expect(fuzzyScore("keys", "keys silver", "keys")).toBeGreaterThan(fuzzyScore("keys", "mug white", "mug"));
    expect(fuzzyScore("drinking thing", "mug ceramic", "mug")).toBeGreaterThan(0.2);
  });
});
