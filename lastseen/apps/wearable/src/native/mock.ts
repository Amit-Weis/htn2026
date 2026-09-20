import { poseAt } from "@lastseen/shared";
import type { Frame, HeadPose, Pose } from "@lastseen/shared";
import { Emitter } from "./emitter";
import { DEFAULT_DETECTOR_CONFIG } from "./types";
import type {
  DetectionsEvent, DetectorConfig, DetectorPlugin, DetectorStatus, FramesResult, GetFramesArgs, HardwareKeys,
  HeadPosePlugin, KeyEvent, PlacementCandidateEvent, PoseConfig, PosePlugin, Unsubscribe,
} from "./types";

/**
 * Deterministic mocks of every native plugin. Silent until driven through their `emit*` / `push*` helpers,
 * so they are also the "plugin missing" fallback on a device where the Kotlin side has not landed yet.
 * Used by the sim (tools/sim) and by tests.
 */

export class MockDetector implements DetectorPlugin {
  readonly mode = "mock" as const;
  private running = false;
  private cfg: DetectorConfig = DEFAULT_DETECTOR_CONFIG;
  private readonly ring: Array<{ frame: Frame; detections: NonNullable<FramesResult["detections"]>[number] }> = [];
  private stillFrame: Frame | null = null;
  private readonly candidates = new Emitter<PlacementCandidateEvent>();
  private readonly dets = new Emitter<DetectionsEvent>();
  readonly calls = { start: 0, stop: 0, getFrames: 0, captureStill: 0 };

  async start(config: DetectorConfig) {
    this.calls.start++;
    this.cfg = config;
    this.running = true;
  }
  async stop() {
    this.calls.stop++;
    this.running = false;
  }
  async getStatus(): Promise<DetectorStatus> {
    return { running: this.running, ready: this.running, fps: this.cfg.fps, model: "mock", ringFrames: this.ring.length, note: "mock detector" };
  }
  /** test/sim helper: add a frame (with its detections) to the ring */
  pushFrame(frame: Frame, detections: NonNullable<FramesResult["detections"]>[number] = []) {
    this.ring.push({ frame, detections });
    const cutoff = frame.t - this.cfg.ringSeconds * 1000;
    while (this.ring.length && this.ring[0]!.frame.t < cutoff) this.ring.shift();
  }
  setStill(frame: Frame | null) {
    this.stillFrame = frame;
  }
  async getFrames(a: GetFramesArgs): Promise<FramesResult> {
    this.calls.getFrames++;
    const inRange = this.ring.filter((r) => r.frame.t >= a.fromT && r.frame.t <= a.toT);
    const max = Math.max(1, Math.min(a.maxFrames, 6));
    const picked = inRange.length <= max ? inRange : max === 1 ? [inRange[inRange.length - 1]!] : Array.from({ length: max }, (_, i) => inRange[Math.round((i * (inRange.length - 1)) / (max - 1))]!);
    return { frames: picked.map((r) => r.frame), detections: picked.map((r) => r.detections) };
  }
  async captureStill() {
    this.calls.captureStill++;
    return this.stillFrame;
  }
  onPlacementCandidate(cb: (e: PlacementCandidateEvent) => void): Unsubscribe {
    return this.candidates.on(cb);
  }
  onDetections(cb: (e: DetectionsEvent) => void): Unsubscribe {
    return this.dets.on(cb);
  }
  emitCandidate(e: PlacementCandidateEvent) {
    this.candidates.emit(e);
  }
  emitDetections(e: DetectionsEvent) {
    this.dets.emit(e);
  }
}

export class MockPose implements PosePlugin {
  readonly mode = "mock" as const;
  private readonly poses = new Emitter<Pose>();
  private readonly putDowns = new Emitter<{ t: number }>();
  readonly history: Pose[] = [];
  stepLengthM = 0.7;
  running = false;
  calibratedForward = 0;

  async start(config: PoseConfig) {
    this.stepLengthM = config.stepLengthM;
    this.running = true;
  }
  async stop() {
    this.running = false;
  }
  async calibrateForward() {
    this.calibratedForward++;
  }
  async calibrateStepLength({ distanceM }: { distanceM: number }) {
    const last = this.history[this.history.length - 1];
    const steps = last?.steps ?? 0;
    if (steps > 0) this.stepLengthM = distanceM / steps;
    return { stepLengthM: this.stepLengthM };
  }
  async getPoseAt({ t }: { t: number }) {
    return poseAt(this.history, t);
  }
  onPose(cb: (p: Pose) => void): Unsubscribe {
    return this.poses.on(cb);
  }
  onPutDown(cb: (e: { t: number }) => void): Unsubscribe {
    return this.putDowns.on(cb);
  }
  emitPose(p: Pose) {
    this.history.push(p);
    this.poses.emit(p);
  }
  emitPutDown(t: number) {
    this.putDowns.emit({ t });
  }
}

export class MockHeadPose implements HeadPosePlugin {
  readonly mode = "mock" as const;
  private readonly heads = new Emitter<HeadPose>();
  zeroed = 0;
  async start() {}
  async stop() {}
  async zeroView() {
    this.zeroed++;
  }
  onHeadPose(cb: (h: HeadPose) => void): Unsubscribe {
    return this.heads.on(cb);
  }
  emitHead(t: number, yawDeg: number, pitchDeg = 0) {
    this.heads.emit({ t, yawDeg, pitchDeg, source: "glasses" });
  }
}

export class MockKeys implements HardwareKeys {
  readonly mode = "mock" as const;
  private readonly keys = new Emitter<KeyEvent>();
  async start() {}
  async stop() {}
  onKey(cb: (e: KeyEvent) => void): Unsubscribe {
    return this.keys.on(cb);
  }
  emitKey(e: KeyEvent) {
    this.keys.emit(e);
  }
}

export function mockPlugins() {
  return { detector: new MockDetector(), pose: new MockPose(), head: new MockHeadPose(), keys: new MockKeys() };
}
