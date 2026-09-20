import { registerPlugin } from "@capacitor/core";
import type { Frame, HeadPose, Pose } from "@lastseen/shared";
import type {
  DetectionsEvent, DetectorConfig, DetectorPlugin, DetectorStatus, FramesResult, GetFramesArgs, HardwareKeys,
  HeadPosePlugin, KeyEvent, PlacementCandidateEvent, PluginKind, PoseConfig, PosePlugin, Unsubscribe,
} from "./types";

/**
 * Capacitor bindings to the Kotlin plugins (names `Lastseen<Kind>`; see docs/NATIVE_CONTRACT.md).
 * Until a teammate's plugin lands, every call rejects with Capacitor's UNIMPLEMENTED error, `ping()` fails,
 * and select.ts reports "not implemented natively" and falls back.
 */

interface Handle {
  remove(): Promise<void>;
}
interface NativeBase {
  ping(): Promise<{ ok: true; version: number }>;
  addListener(event: string, cb: (payload: never) => void): Promise<Handle>;
}
interface NativeDetector extends NativeBase {
  start(cfg: DetectorConfig): Promise<void>;
  stop(): Promise<void>;
  getStatus(): Promise<DetectorStatus>;
  getFrames(a: GetFramesArgs): Promise<FramesResult>;
  captureStill(): Promise<{ frame: Frame | null }>;
}
interface NativePose extends NativeBase {
  start(cfg: PoseConfig): Promise<void>;
  stop(): Promise<void>;
  calibrateForward(): Promise<void>;
  calibrateStepLength(a: { distanceM: number }): Promise<{ stepLengthM: number }>;
  getPoseAt(a: { t: number }): Promise<{ pose: Pose | null }>;
}
interface NativeHead extends NativeBase {
  start(): Promise<void>;
  stop(): Promise<void>;
  zeroView(): Promise<void>;
}
interface NativeKeys extends NativeBase {
  start(): Promise<void>;
  stop(): Promise<void>;
}

const name = (k: PluginKind) => `Lastseen${k}`;

function listen<T>(p: NativeBase, event: string, cb: (v: T) => void): Unsubscribe {
  let handle: Handle | null = null;
  let cancelled = false;
  p.addListener(event, cb as (payload: never) => void)
    .then((h) => (cancelled ? void h.remove() : (handle = h)))
    .catch(() => undefined); // plugin missing: the caller was already told by ping()
  return () => {
    cancelled = true;
    void handle?.remove();
  };
}

export class NativeDetectorPlugin implements DetectorPlugin {
  readonly mode = "native" as const;
  constructor(readonly api: NativeDetector = registerPlugin<NativeDetector>(name("Detector"))) {}
  start(cfg: DetectorConfig) { return this.api.start(cfg); }
  stop() { return this.api.stop(); }
  getStatus() { return this.api.getStatus(); }
  getFrames(a: GetFramesArgs) { return this.api.getFrames(a); }
  async captureStill() { return (await this.api.captureStill()).frame; }
  onPlacementCandidate(cb: (e: PlacementCandidateEvent) => void) { return listen(this.api, "placementCandidate", cb); }
  onDetections(cb: (e: DetectionsEvent) => void) { return listen(this.api, "detections", cb); }
}

export class NativePosePlugin implements PosePlugin {
  readonly mode = "native" as const;
  constructor(readonly api: NativePose = registerPlugin<NativePose>(name("Pose"))) {}
  start(cfg: PoseConfig) { return this.api.start(cfg); }
  stop() { return this.api.stop(); }
  calibrateForward() { return this.api.calibrateForward(); }
  calibrateStepLength(a: { distanceM: number }) { return this.api.calibrateStepLength(a); }
  async getPoseAt(a: { t: number }) { return (await this.api.getPoseAt(a)).pose; }
  onPose(cb: (p: Pose) => void) { return listen(this.api, "pose", cb); }
  onPutDown(cb: (e: { t: number }) => void) { return listen(this.api, "putDown", cb); }
}

export class NativeHeadPosePlugin implements HeadPosePlugin {
  readonly mode = "native" as const;
  constructor(readonly api: NativeHead = registerPlugin<NativeHead>(name("HeadPose"))) {}
  start() { return this.api.start(); }
  stop() { return this.api.stop(); }
  zeroView() { return this.api.zeroView(); }
  onHeadPose(cb: (h: HeadPose) => void) { return listen(this.api, "headPose", cb); }
}

export class NativeKeysPlugin implements HardwareKeys {
  readonly mode = "native" as const;
  constructor(readonly api: NativeKeys = registerPlugin<NativeKeys>(name("Keys"))) {}
  start() { return this.api.start(); }
  stop() { return this.api.stop(); }
  onKey(cb: (e: KeyEvent) => void) { return listen(this.api, "key", cb); }
}

export type NativeProbeResult = { ok: true; version: number } | { ok: false; note: string };

/** Does the Kotlin plugin exist and answer `ping()` within `timeoutMs`? */
export async function probeNative(p: { ping(): Promise<{ ok: true; version: number }> }, timeoutMs = 1500): Promise<NativeProbeResult> {
  try {
    const r = await Promise.race([
      p.ping(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("ping timed out")), timeoutMs)),
    ]);
    return { ok: true, version: r.version };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const unimplemented = err.code === "UNIMPLEMENTED" || /not implemented|unimplemented/i.test(err.message ?? "");
    return { ok: false, note: unimplemented ? "not implemented natively" : `ping failed: ${err.message ?? String(e)}` };
  }
}
