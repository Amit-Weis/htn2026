import type { Detection, PlacementCandidate, PlacementEvent, Pose } from "@lastseen/shared";
import { DEFAULT_INGEST } from "../ingest/pipeline";
import type { IngestConfig, IngestDeps, TraceInput } from "../ingest/pipeline";
import { PassthroughCropper } from "../ingest/crop";
import type { Cropper } from "../ingest/crop";
import { Ledger } from "../ledger";
import { LocalEmbedder } from "../memory/embed";
import { SqlVectorStore } from "../memory/vectors";
import { MockOmni } from "../omni/mock";
import type { OmniClient } from "../omni/types";
import { memorySql } from "./sql";

export const T0 = 1_800_000_000_000;
export const b64 = (o: unknown) => btoa(JSON.stringify(o));

export const pose = (t: number, over: Partial<Pose> = {}): Pose => ({ t, x: 0, y: 0, headingDeg: 0, steps: 0, confidence: 1, stationary: true, ...over });
export const stillPoses = (t: number, n = 10, over: Partial<Pose> = {}) => Array.from({ length: n }, (_, i) => pose(t - (n - 1 - i) * 100, over));

let seq = 0;

/** Perceptual-style hashes that are all far apart (>4 bits), so dedupe only fires when a test wants it to. */
const FAR = ["0f0f0f0f", "f0f0f0f0", "00ff00ff", "ff00ff00", "0ff00ff0", "f00ff00f", "3c3c3c3c", "c3c3c3c3", "5a5a5a5a", "a5a5a5a5", "6666cccc", "9999333c"];
export const hx = (i: number) => FAR[i % FAR.length]!;

export interface CandOpts {
  t?: number;
  label?: string;
  box?: [number, number, number, number];
  /** detector boxes for the final frame; default = one box matching the label */
  detections?: Detection[] | null;
  /** explicit OMNI answer for detection_index; omit to let the mock choose */
  detection_index?: number | null;
  event?: Partial<PlacementEvent>;
  trigger?: PlacementCandidate["trigger"];
  poseSlice?: Pose[];
  hash?: string;
  still?: boolean;
  narration?: string;
}

/** A placement candidate whose final frame carries a mock script (see MockOmni). Box centre 0.7 => phi = +14 deg. */
export function candidate(o: CandOpts = {}): PlacementCandidate {
  const t = o.t ?? T0;
  const label = o.label ?? "keys";
  const box = o.box ?? [0.6, 0.5, 0.2, 0.15];
  const dets = o.detections === undefined ? [{ label, score: 0.9, bbox: box }] : o.detections;
  const event = {
    kind: "placed", label, description: `A ${label} on the desk`, distinguishing_features: ["silver"], surface: "desk", zone_name: "desk",
    bbox: box, distance_m: 1.5, holder: "wearer", confidence: 0.9,
    ...(o.detection_index !== undefined ? { detection_index: o.detection_index } : {}), ...o.event,
  };
  const n = ++seq;
  const frame = (dt: number, last: boolean) => ({ t: t + dt, w: 640, h: 480, hash: last ? (o.hash ?? `h${n}`) : `h${n}-${dt}`, jpegBase64: b64(last ? { mock: { events: [event] } } : { note: "early" }) });
  return {
    type: "placement_candidate", t, trigger: o.trigger ?? "detector",
    frames: [frame(-1000, false), frame(-500, false), frame(0, true)],
    stillFrame: o.still ? { t, w: 4000, h: 3000, jpegBase64: b64({ mock: { events: [event] } }) } : undefined,
    detections: dets ? [[], [], dets] : undefined,
    poseSlice: o.poseSlice ?? stillPoses(t),
    hfovDeg: 70,
    narrationAudioB64: o.narration ? b64({ mockTranscript: o.narration }) : undefined,
    narrationMime: o.narration ? "audio/wav" : undefined,
  };
}

export interface TestRig {
  deps: IngestDeps;
  ledger: Ledger;
  traces: TraceInput[];
  clock: { now: number };
}

export function makeRig(over: { cfg?: Partial<IngestConfig>; omni?: OmniClient; cropper?: Cropper; fetchImpl?: typeof fetch } = {}): TestRig {
  const ledger = new Ledger(memorySql());
  const clock = { now: T0 + 10_000 };
  const traces: TraceInput[] = [];
  const deps: IngestDeps = {
    ledger,
    omni: over.omni ?? new MockOmni(),
    embedder: new LocalEmbedder(),
    vectors: new SqlVectorStore(ledger),
    cropper: over.cropper ?? new PassthroughCropper(),
    cfg: { ...DEFAULT_INGEST, ...over.cfg },
    now: () => clock.now,
    currentPose: () => pose(clock.now),
    emitTrace: (t) => traces.push(t),
    fetchImpl: over.fetchImpl,
  };
  return { deps, ledger, traces, clock };
}
