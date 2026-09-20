import type { Detection, Frame, HeadPose, Pose } from "@lastseen/shared";

/**
 * Plugin contracts between the web layer (this app) and the native Android layer (Kotlin, owned by teammates).
 * Full spec with JSON examples and a verification checklist: docs/NATIVE_CONTRACT.md.
 *
 * CLOCK RULE: every `t` is epoch milliseconds (System.currentTimeMillis() in Kotlin, Date.now() in JS).
 * The WebView NEVER opens the camera: frames only ever arrive through DetectorPlugin.
 */

export type Unsubscribe = () => void;
export type PluginMode = "native" | "web" | "mock";

/** Kinds of plugin, also the Capacitor plugin-name suffix (`Lastseen<Kind>`). */
export type PluginKind = "Detector" | "Pose" | "HeadPose" | "Keys";

export interface DetectorConfig {
  /** analysis rate of the on-device detector */
  fps: number;
  /** keyframe ring buffer: JPEG width in px and quality 0..1 */
  keyframeWidthPx: number;
  jpegQuality: number;
  /** detector score threshold, 0..1 */
  scoreThreshold: number;
  /** how long the scene must stay settled before a candidate fires */
  settleMs: number;
  /** ring buffer length */
  ringSeconds: number;
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  fps: 2,
  keyframeWidthPx: 640,
  jpegQuality: 0.6,
  scoreThreshold: 0.35,
  settleMs: 800,
  ringSeconds: 6,
};

export interface DetectorStatus {
  running: boolean;
  /** false while the model is loading or the camera is unavailable */
  ready: boolean;
  fps: number;
  model: string | null;
  ringFrames: number;
  /** human-readable, e.g. "not implemented natively" */
  note?: string;
}

export interface GetFramesArgs {
  fromT: number;
  toT: number;
  /** at most 6 keyframes are ever uploaded */
  maxFrames: number;
}

export interface FramesResult {
  /** oldest first, each with jpegBase64 (640 px wide) */
  frames: Frame[];
  /** aligned index-for-index with `frames`; omitted when the detector is unavailable */
  detections?: Detection[][];
}

/** Fired by the native detector once a placement looks complete (object appeared, then the scene settled). */
export interface PlacementCandidateEvent {
  t: number;
  trigger: "detector";
  /** up to 6 keyframes spanning before/during/after, oldest first */
  frames: Frame[];
  /** optional full-resolution still, <= 1920 px long edge */
  stillFrame?: Frame;
  detections?: Detection[][];
}

/** Debug-only stream of the latest detections; never uploaded. */
export interface DetectionsEvent {
  t: number;
  detections: Detection[];
}

export interface DetectorPlugin {
  readonly mode: PluginMode;
  start(config: DetectorConfig): Promise<void>;
  stop(): Promise<void>;
  getStatus(): Promise<DetectorStatus>;
  getFrames(args: GetFramesArgs): Promise<FramesResult>;
  captureStill(): Promise<Frame | null>;
  onPlacementCandidate(cb: (e: PlacementCandidateEvent) => void): Unsubscribe;
  onDetections(cb: (e: DetectionsEvent) => void): Unsubscribe;
}

export interface PoseConfig {
  stepLengthM: number;
  /** pose event rate (Hz); putDown/stationary transitions may fire in between */
  sampleHz: number;
}

export const DEFAULT_POSE_CONFIG: PoseConfig = { stepLengthM: 0.7, sampleHz: 5 };

export interface PosePlugin {
  readonly mode: PluginMode;
  start(config: PoseConfig): Promise<void>;
  stop(): Promise<void>;
  /** the wearer is facing straight ahead of their body right now: derive the chest-mount yaw offset */
  calibrateForward(): Promise<void>;
  /** the wearer just walked `distanceM` metres in a straight line: refine the step length */
  calibrateStepLength(args: { distanceM: number }): Promise<{ stepLengthM: number }>;
  getPoseAt(args: { t: number }): Promise<Pose | null>;
  onPose(cb: (p: Pose) => void): Unsubscribe;
  /** the phone/chest dipped or the wearer bent to put something down */
  onPutDown(cb: (e: { t: number }) => void): Unsubscribe;
}

export interface HeadPosePlugin {
  readonly mode: PluginMode;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** treat the current head yaw as "straight ahead" (native side re-zeroes its own reference) */
  zeroView(): Promise<void>;
  onHeadPose(cb: (h: HeadPose) => void): Unsubscribe;
}

export interface KeyEvent {
  t: number;
  /** Android KeyEvent.KEYCODE_* */
  keyCode: number;
  action: "down" | "up";
}

export interface HardwareKeys {
  readonly mode: PluginMode;
  start(): Promise<void>;
  stop(): Promise<void>;
  onKey(cb: (e: KeyEvent) => void): Unsubscribe;
}

export interface Plugins {
  detector: DetectorPlugin;
  pose: PosePlugin;
  head: HeadPosePlugin;
  keys: HardwareKeys;
}

/** Android KeyEvent codes we react to. Native forwards every key; the TS layer decides meaning. */
export const KEYCODE = {
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  HEADSETHOOK: 79,
  MEDIA_PLAY_PAUSE: 85,
  MEDIA_NEXT: 87,
  MEDIA_PREVIOUS: 88,
} as const;
