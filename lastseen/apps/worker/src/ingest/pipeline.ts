import { distanceM, objectPosition, poseAt } from "@lastseen/shared";
import type { Detection, PlacementCandidate, PlacementEvent, Pose, Trace } from "@lastseen/shared";
import type { Ledger, ObjectRecord, BoxSource, FrameRecord } from "../ledger";
import { nid } from "../ledger";
import type { Embedder } from "../memory/embed";
import { labelsCompatible } from "../memory/text";
import type { VectorStore } from "../memory/vectors";
import { BudgetExceededError } from "../omni/types";
import type { AudioClip, OmniClient } from "../omni/types";
import { cropRect, shouldCrop } from "./crop";
import type { Cropper } from "./crop";
import { fetchDetections } from "./detector";
import { DEFAULT_GUARDS, EMPTY_GUARD, evaluateCandidate, omniCallsLeft, recordOmniCall } from "./guards";
import type { DropReason, GuardConfig, GuardState } from "./guards";

type Box = [number, number, number, number];
export type TraceInput = Omit<Trace, "id" | "ts">;

export interface IngestConfig {
  guards: GuardConfig;
  /** used only when a candidate omits hfovDeg (v1 upgrade) */
  defaultHfovDeg: number;
  detectorUrl?: string;
  detectorSecret?: string;
  /** crop when the source frame has at least this many pixels */
  cropMinPixels: number;
  cropMargin: number;
  /** cosine similarity at which a new sighting is the same object (label must also be compatible) */
  sameObjectSimilarity: number;
  /** re-placing a compatible object within this radius is the same object even if the vector index lags */
  sameSpotMeters: number;
}

export const DEFAULT_INGEST: IngestConfig = {
  guards: DEFAULT_GUARDS,
  defaultHfovDeg: 70,
  cropMinPixels: 1_000_000,
  cropMargin: 0.25,
  sameObjectSimilarity: 0.85,
  sameSpotMeters: 1.5,
};

export interface IngestDeps {
  ledger: Ledger;
  omni: OmniClient;
  embedder: Embedder;
  vectors: VectorStore;
  cropper: Cropper;
  cfg: IngestConfig;
  /** epoch ms */
  now: () => number;
  currentPose: () => Pose;
  emitTrace: (t: TraceInput) => void;
  fetchImpl?: typeof fetch;
}

/** DO SQLite rows are limited to 2 MB; a base64 still beyond this is dropped (it is only used for cropping). */
export const MAX_STILL_B64_CHARS = 1_400_000;

const GUARD_KEY = "guard";
const trace = (deps: IngestDeps, candidateId: string, kind: Trace["kind"], tool: string | null, args: unknown, result: unknown, latencyMs: number | null = null, costCad = 0) =>
  deps.emitTrace({ turnId: candidateId, step: 0, kind, tool, args, result, latencyMs, costCad });

const guardState = (d: IngestDeps) => d.ledger.getKv<GuardState>(GUARD_KEY) ?? EMPTY_GUARD;
const noteCall = (d: IngestDeps) => d.ledger.setKv(GUARD_KEY, recordOmniCall(guardState(d), d.now()));

export type IntakeResult = { accepted: true; candidateId: string } | { accepted: false; reason: DropReason; detail: string };

/** Guards + storage. Cheap and synchronous: nothing here calls OMNI. Every drop writes a trace with its reason. */
export function intake(deps: IngestDeps, c: PlacementCandidate): IntakeResult {
  const r = evaluateCandidate(c, guardState(deps), deps.cfg.guards, deps.now());
  if (!r.ok) {
    trace(deps, `cand:${c.t}`, "ingest", "guard", { trigger: c.trigger, t: c.t }, { dropped: true, reason: r.reason, detail: r.detail });
    return { accepted: false, reason: r.reason, detail: r.detail };
  }
  deps.ledger.setKv(GUARD_KEY, r.next);

  const id = nid("c");
  deps.ledger.createCandidate(id, c.t, c.trigger, {
    hfovDeg: c.hfovDeg,
    poseSlice: c.poseSlice,
    hasNarration: Boolean(c.narrationAudioB64),
  });
  c.frames.forEach((f, i) => {
    if (!f.jpegBase64) return;
    deps.ledger.putFrame({ id: `${id}-${i}`, candidateId: id, idx: i, t: f.t, w: f.w, h: f.h, hash: f.hash ?? null, detections: c.detections?.[i] ?? null, jpeg: f.jpegBase64, isStill: false });
  });
  const still = c.stillFrame;
  let stillKept = false;
  if (still?.jpegBase64) {
    if (still.jpegBase64.length <= MAX_STILL_B64_CHARS) {
      deps.ledger.putFrame({ id: `${id}-still`, candidateId: id, idx: 99, t: still.t, w: still.w, h: still.h, hash: still.hash ?? null, detections: null, jpeg: still.jpegBase64, isStill: true });
      stillKept = true;
    } else {
      trace(deps, id, "ingest", "still_dropped", { chars: still.jpegBase64.length }, { reason: "still larger than the 2 MB row limit; downscale to <=1920 px on the phone" });
    }
  }
  if (c.narrationAudioB64) deps.ledger.putBlob(`narration:${id}`, c.narrationMime ?? "audio/wav", c.narrationAudioB64);

  trace(deps, id, "ingest", "accepted", { trigger: c.trigger, t: c.t }, {
    frames: c.frames.length,
    detections: (c.detections ?? []).reduce((n, d) => n + d.length, 0),
    still: stillKept,
  });
  return { accepted: true, candidateId: id };
}

const validBox = (b: readonly number[] | null | undefined): b is Box =>
  !!b && b.length === 4 && b.every(Number.isFinite) && b[2]! > 0 && b[3]! > 0;

const eventsOf = (result: unknown): PlacementEvent[] => ((result as { events?: PlacementEvent[] } | null)?.events ?? []);

const asFrame = (f: FrameRecord) => ({ t: f.t, w: f.w, h: f.h, jpegBase64: f.jpeg });

/** Step 1: ask OMNI what was put down, giving it the detector boxes of the final frame. */
export async function extract(deps: IngestDeps, id: string): Promise<{ events: number; skipped?: string }> {
  const { ledger } = deps;
  const cand = ledger.getCandidate(id);
  if (!cand) return { events: 0, skipped: "missing" };
  if (cand.status !== "queued") return { events: eventsOf(cand.result).length }; // idempotent under workflow retries

  const frames = ledger.framesOf(id).filter((f) => !f.isStill);
  const final = frames[frames.length - 1];
  if (!final) {
    ledger.updateCandidate(id, { status: "failed", result: { error: "no frames" } });
    return { events: 0, skipped: "no_frames" };
  }

  // Optional remote detector, only when the phone sent no detections. Never blocks ingest.
  if (!frames.some((f) => f.detections) && deps.cfg.detectorUrl && deps.cfg.detectorSecret) {
    const t0 = deps.now();
    const got = await fetchDetections(frames.map(asFrame), { url: deps.cfg.detectorUrl, secret: deps.cfg.detectorSecret, fetchImpl: deps.fetchImpl });
    if (got) {
      frames.forEach((f, i) => {
        f.detections = got[i] ?? [];
        ledger.putFrame(f);
      });
      trace(deps, id, "ingest", "remote_detector", { frames: frames.length }, { ok: true, boxes: got.reduce((n, d) => n + d.length, 0) }, deps.now() - t0);
    } else {
      trace(deps, id, "ingest", "remote_detector", { frames: frames.length }, { ok: false, note: "detector unavailable; continuing without boxes" }, deps.now() - t0);
    }
  }

  if (omniCallsLeft(guardState(deps), deps.now(), deps.cfg.guards) < 1) {
    ledger.updateCandidate(id, { status: "failed", result: { error: "rate_limit" } });
    trace(deps, id, "ingest", "guard", {}, { dropped: true, reason: "rate_limit", detail: "budget for OMNI vision calls used up before extraction" });
    return { events: 0, skipped: "rate_limit" };
  }
  noteCall(deps);

  const narrationBlob = ledger.getBlob(`narration:${id}`);
  const narration: AudioClip | undefined = narrationBlob ? { b64: narrationBlob.b64, mime: narrationBlob.mime } : undefined;
  const detections = final.detections ?? undefined;
  try {
    const r = await deps.omni.extractPlacements(frames.map((f) => ({ b64: f.jpeg })), { knownZones: ledger.zoneNames(), narration, detections });
    ledger.updateCandidate(id, { status: "extracted", result: { events: r.value.events } });
    trace(deps, id, "omni", "extractPlacements", { frames: frames.length, detectorBoxes: detections?.length ?? 0, narration: Boolean(narration) }, { events: r.value.events.map((e) => ({ kind: e.kind, label: e.label, detection_index: e.detection_index })) }, r.latencyMs, r.costCad);
    return { events: r.value.events.length };
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      ledger.updateCandidate(id, { status: "failed", result: { error: "budget" } });
      trace(deps, id, "system", "budget", {}, { error: e.message });
      return { events: 0, skipped: "budget" };
    }
    throw e; // transient: the Workflow retries this step
  }
}

/** Step 2: crop the chosen box from the (large) best frame and let OMNI describe just that object. Best-effort. */
export async function describeCrop(deps: IngestDeps, id: string): Promise<{ cropped: number }> {
  const { ledger } = deps;
  const cand = ledger.getCandidate(id);
  if (!cand || cand.status !== "extracted") return { cropped: 0 };
  const events = eventsOf(cand.result);
  const frames = ledger.framesOf(id);
  const final = frames.filter((f) => !f.isStill).at(-1);
  const src = frames.find((f) => f.isStill) ?? final;
  let cropped = 0;

  if (final && src && shouldCrop(src.w, src.h, deps.cfg.cropMinPixels)) {
    for (const ev of events.slice(0, 2)) {
      const det = ev.detection_index != null ? final.detections?.[ev.detection_index] : undefined;
      const box = det?.bbox ?? (validBox(ev.bbox) ? ev.bbox : null);
      if (!box) continue;
      if (omniCallsLeft(guardState(deps), deps.now(), deps.cfg.guards) < 1) {
        trace(deps, id, "ingest", "crop_skipped", {}, { reason: "rate_limit" });
        break;
      }
      const crop = await deps.cropper.crop(src.jpeg, src.w, src.h, cropRect(box, src.w, src.h, deps.cfg.cropMargin));
      if (!crop) {
        trace(deps, id, "ingest", "crop_skipped", { label: ev.label }, { reason: "cropper unavailable in this environment" });
        continue;
      }
      noteCall(deps);
      try {
        const d = await deps.omni.describeCrop({ b64: crop }, { label: ev.label });
        if (d.value.label) ev.label = d.value.label;
        if (d.value.description.length > ev.description.length) ev.description = d.value.description;
        ev.distinguishing_features = [...new Set([...ev.distinguishing_features, ...d.value.distinguishing_features])];
        cropped++;
        trace(deps, id, "omni", "describeCrop", { label: ev.label, from: src.isStill ? "still" : "frame" }, d.value, d.latencyMs, d.costCad);
      } catch (e) {
        if (e instanceof BudgetExceededError) break;
        trace(deps, id, "system", "describeCrop_failed", {}, { error: e instanceof Error ? e.message : String(e) }); // enhancement only
      }
    }
  }
  ledger.updateCandidate(id, { status: "described", result: { events } });
  return { cropped };
}

/** Which box positions the object: the detector box OMNI chose, else OMNI's own box, else none (low confidence). */
export function chooseBox(ev: PlacementEvent, detections: Detection[] | null | undefined): { box: Box | null; source: BoxSource } {
  const chosen = ev.detection_index != null ? detections?.[ev.detection_index] : undefined;
  if (chosen && validBox(chosen.bbox)) return { box: chosen.bbox as Box, source: "detector" };
  if (validBox(ev.bbox)) return { box: ev.bbox as Box, source: "omni" };
  return { box: null, source: "none" };
}

const SOURCE_FACTOR: Record<BoxSource, number> = { detector: 1, omni: 0.85, none: 0.4 };

const textOf = (ev: Pick<PlacementEvent, "label" | "description" | "distinguishing_features">) =>
  `${ev.label}. ${ev.description}. ${ev.distinguishing_features.join(", ")}`;

async function findSame(deps: IngestDeps, ev: PlacementEvent, pos: { x: number; y: number } | null, vec: number[] | null): Promise<ObjectRecord | null> {
  if (vec) {
    try {
      for (const m of await deps.vectors.query(vec, 3)) {
        const o = deps.ledger.getObject(m.id);
        if (o && m.score >= deps.cfg.sameObjectSimilarity && labelsCompatible(o.label, ev.label)) return o;
      }
    } catch {
      /* index unavailable: fall through to the deterministic match */
    }
  }
  for (const o of deps.ledger.listObjects()) {
    if (!labelsCompatible(o.label, ev.label)) continue;
    if (pos && o.x !== null && o.y !== null && distanceM({ x: o.x, y: o.y }, pos) <= deps.cfg.sameSpotMeters) return o;
  }
  return null;
}

export interface ReconcileSummary {
  objectIds: string[];
  created: number;
  updated: number;
  held: number;
}

/** Step 3: turn events into ledger rows: position, re-identification, sighting, vector upsert. Idempotent. */
export async function reconcile(deps: IngestDeps, id: string): Promise<ReconcileSummary> {
  const { ledger } = deps;
  const cand = ledger.getCandidate(id);
  const empty: ReconcileSummary = { objectIds: [], created: 0, updated: 0, held: 0 };
  if (!cand) return empty;
  if (cand.status === "done") return (cand.result as { summary?: ReconcileSummary } | null)?.summary ?? empty;
  if (cand.status === "failed" || cand.status === "queued") return empty;

  const events = eventsOf(cand.result);
  const final = ledger.framesOf(id).filter((f) => !f.isStill).at(-1);
  const meta = cand.meta as { hfovDeg?: number; poseSlice?: Pose[] };
  const t = final?.t ?? cand.t;
  const pose = poseAt(meta.poseSlice ?? [], t) ?? deps.currentPose();
  const summary: ReconcileSummary = { ...empty, objectIds: [] };
  const keep: string[] = [];

  for (const ev of events) {
    const { box, source } = chooseBox(ev, final?.detections);
    const cx = box ? box[0] + box[2] / 2 : 0.5;
    const pos = objectPosition(pose, pose.headingDeg, cx, ev.distance_m, meta.hfovDeg ?? deps.cfg.defaultHfovDeg);
    let vec: number[] | null = null;
    try {
      vec = await deps.embedder.embed(textOf(ev));
    } catch {
      trace(deps, id, "system", "embed_failed", {}, { note: "continuing with label matching only" });
    }
    const same = await findSame(deps, ev, pos, vec);

    if (ev.kind === "picked_up") {
      if (!same) {
        trace(deps, id, "ingest", "picked_up_unknown", { label: ev.label }, { note: "no matching object in memory" });
        continue;
      }
      // held: the last known location stays where it was picked up
      ledger.updateObject(same.id, { status: "held", lastSeenAt: t });
      ledger.addSighting({ id: nid("s"), objectId: same.id, t, kind: "picked_up", x: same.x, y: same.y, zone: same.zone, confidence: ev.confidence, frameId: null, box: null, boxSource: "none", candidateId: id });
      summary.held++;
      summary.objectIds.push(same.id);
      continue;
    }

    const confidence = Math.min(1, ev.confidence * SOURCE_FACTOR[source] * pose.confidence);
    const zone = ev.zone_name.trim() || ledger.nearestZone(pos.x, pos.y);
    const frameId = final ? final.id : null;
    let objectId: string;
    if (same) {
      objectId = same.id;
      if (same.frameId && same.frameId !== frameId) ledger.deleteFrame(same.frameId); // old thumbnail is superseded
      ledger.updateObject(same.id, {
        description: ev.description.length >= same.description.length ? ev.description : same.description,
        features: [...new Set([...same.features, ...ev.distinguishing_features])],
        status: "placed", x: pos.x, y: pos.y, zone, lastSeenAt: t, confidence, frameId, box, boxSource: source,
      });
      summary.updated++;
    } else {
      objectId = nid("o");
      ledger.createObject({
        id: objectId, label: ev.label, description: ev.description, features: ev.distinguishing_features, status: "placed",
        x: pos.x, y: pos.y, zone, lastSeenAt: t, confidence, frameId, box, boxSource: source,
      });
      summary.created++;
    }
    if (frameId) keep.push(frameId);
    ledger.addSighting({ id: nid("s"), objectId, t, kind: "placed", x: pos.x, y: pos.y, zone, confidence, frameId, box, boxSource: source, candidateId: id });
    if (zone) ledger.touchZone(zone, pos.x, pos.y, t);
    if (vec) {
      try {
        await deps.vectors.upsert(objectId, vec);
      } catch {
        trace(deps, id, "system", "vector_upsert_failed", { objectId }, { note: "semantic recall degraded; label matching still works" });
      }
    }
    summary.objectIds.push(objectId);
  }

  // Privacy: keep only the frame(s) that became thumbnails; delete the other keyframes and any narration audio.
  ledger.dropFramesExcept(id, keep);
  ledger.updateCandidate(id, { status: "done", result: { events, summary } });
  trace(deps, id, "ingest", "reconciled", { events: events.length }, summary);
  return summary;
}
