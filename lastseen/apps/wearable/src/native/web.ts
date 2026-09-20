import { StepDetector, headingFromOrientation, pdrStep, poseAt, poseConfidence, wrap180 } from "@lastseen/shared";
import type { Frame, HeadPose, Pose } from "@lastseen/shared";
import { Emitter } from "./emitter";
import { MotionGate, motionEnergy } from "./motionGate";
import { DEFAULT_DETECTOR_CONFIG, KEYCODE } from "./types";
import type {
  DetectionsEvent, DetectorConfig, DetectorPlugin, DetectorStatus, FramesResult, GetFramesArgs, HardwareKeys,
  HeadPosePlugin, KeyEvent, PlacementCandidateEvent, PoseConfig, PosePlugin, Unsubscribe,
} from "./types";

/**
 * Browser-only fallbacks for desktop development. None of this is used on the phone: inside the Capacitor
 * WebView the native Kotlin plugins own the camera, sensors and keys.
 */

/** True inside the Capacitor Android/iOS shell. No import of @capacitor/core so this stays Node-safe. */
export function isNativeWebView(): boolean {
  const c = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return Boolean(c?.isNativePlatform?.());
}

/** 64-bit average hash of an 8x8 grayscale image, as 16 hex chars. Similar images differ in few bits. */
export function averageHash(gray8x8: Uint8Array): string {
  const mean = gray8x8.reduce((s, v) => s + v, 0) / Math.max(1, gray8x8.length);
  let hex = "";
  for (let i = 0; i < 16; i++) {
    let nib = 0;
    for (let b = 0; b < 4; b++) nib = (nib << 1) | ((gray8x8[i * 4 + b] ?? 0) >= mean ? 1 : 0);
    hex += nib.toString(16);
  }
  return hex;
}

const now = () => Date.now();

export interface WebDetectorOptions {
  /** CAMERA_ID: a specific deviceId from enumerateDevices(); the browser normally offers one lens at a time */
  cameraId?: string;
}

/**
 * Frame-diff detector for the browser: motion energy rises then settles => one placement candidate.
 * There is no object detector here, so candidates carry no detections and the backend falls back to
 * OMNI's own bounding box.
 */
export class WebDetector implements DetectorPlugin {
  readonly mode = "web" as const;
  private cfg = DEFAULT_DETECTOR_CONFIG;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ring: Frame[] = [];
  private prevGray: Uint8Array | null = null;
  private readonly gate = new MotionGate();
  private readonly candidates = new Emitter<PlacementCandidateEvent>();
  private readonly dets = new Emitter<DetectionsEvent>();

  constructor(private readonly opts: WebDetectorOptions = {}) {}

  async start(config: DetectorConfig): Promise<void> {
    // Hard rule: the WebView must NEVER open the camera; the native DetectorPlugin owns it.
    if (isNativeWebView()) throw new Error("WebDetector must not run inside the native WebView: the camera belongs to the native DetectorPlugin");
    this.cfg = config;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: this.opts.cameraId ? { deviceId: { exact: this.opts.cameraId } } : { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.srcObject = this.stream;
    await v.play();
    this.video = v;
    this.gate.reset();
    this.timer = setInterval(() => this.tick(), 1000 / config.fps);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video = null;
  }

  async getStatus(): Promise<DetectorStatus> {
    return { running: this.timer !== null, ready: this.video !== null, fps: this.cfg.fps, model: null, ringFrames: this.ring.length, note: "browser frame-diff fallback (no object detector)" };
  }

  private canvas(w: number, h: number) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }

  private grayscale(w: number, h: number): Uint8Array {
    const c = this.canvas(w, h);
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(this.video!, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const g = new Uint8Array(w * h);
    for (let i = 0; i < g.length; i++) g[i] = (d[i * 4]! * 77 + d[i * 4 + 1]! * 151 + d[i * 4 + 2]! * 28) >> 8;
    return g;
  }

  private jpeg(width: number, quality: number): { b64: string; w: number; h: number } {
    const v = this.video!;
    const w = Math.min(width, v.videoWidth || width);
    const h = Math.round((w * (v.videoHeight || 480)) / (v.videoWidth || 640));
    const c = this.canvas(w, h);
    c.getContext("2d")!.drawImage(v, 0, 0, w, h);
    return { b64: c.toDataURL("image/jpeg", quality).split(",")[1] ?? "", w, h };
  }

  private tick() {
    if (!this.video || this.video.readyState < 2) return;
    const t = now();
    const gray = this.grayscale(160, 120);
    const energy = this.prevGray ? motionEnergy(gray, this.prevGray) : 0;
    this.prevGray = gray;

    const small = this.grayscale(8, 8);
    const j = this.jpeg(this.cfg.keyframeWidthPx, this.cfg.jpegQuality);
    this.ring.push({ t, w: j.w, h: j.h, hash: averageHash(small), jpegBase64: j.b64 });
    const cutoff = t - this.cfg.ringSeconds * 1000;
    this.ring = this.ring.filter((f) => f.t >= cutoff);

    if (this.gate.push(energy, t)) {
      const frames = pickSpread(this.ring, 6);
      this.candidates.emit({ t, trigger: "detector", frames });
    }
  }

  async getFrames(a: GetFramesArgs): Promise<FramesResult> {
    return { frames: pickSpread(this.ring.filter((f) => f.t >= a.fromT && f.t <= a.toT), Math.min(a.maxFrames, 6)) };
  }

  async captureStill(): Promise<Frame | null> {
    if (!this.video) return null;
    const j = this.jpeg(1920, 0.85);
    return { t: now(), w: j.w, h: j.h, jpegBase64: j.b64 };
  }

  onPlacementCandidate(cb: (e: PlacementCandidateEvent) => void): Unsubscribe {
    return this.candidates.on(cb);
  }
  onDetections(cb: (e: DetectionsEvent) => void): Unsubscribe {
    return this.dets.on(cb);
  }
}

function pickSpread<T>(xs: T[], max: number): T[] {
  if (xs.length <= max) return xs;
  if (max <= 1) return xs.length ? [xs[xs.length - 1]!] : []; // the newest frame
  return Array.from({ length: max }, (_, i) => xs[Math.round((i * (xs.length - 1)) / (max - 1))]!);
}

/** DeviceOrientation + accelerometer pose for desktop/dev. On the phone the native PosePlugin replaces this. */
export class WebPose implements PosePlugin {
  readonly mode = "web" as const;
  private readonly poses = new Emitter<Pose>();
  private readonly putDowns = new Emitter<{ t: number }>();
  private readonly history: Pose[] = [];
  private readonly steps = new StepDetector();
  private timer: ReturnType<typeof setInterval> | null = null;
  private x = 0;
  private y = 0;
  private stepCount = 0;
  private stepsAtMark = 0;
  private stepLengthM = 0.7;
  private rawHeading = 0;
  private offset = 0;
  private lastStepT = 0;
  private anchorT = now();
  private off: Array<() => void> = [];

  async start(cfg: PoseConfig): Promise<void> {
    this.stepLengthM = cfg.stepLengthM;
    const onOrient = (e: DeviceOrientationEvent) => {
      if (e.alpha == null || e.beta == null || e.gamma == null) return;
      this.rawHeading = headingFromOrientation(e.alpha, e.beta, e.gamma);
    };
    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null || a.y == null || a.z == null) return;
      const t = now();
      if (this.steps.push(a.x, a.y, a.z, t)) {
        this.lastStepT = t;
        this.stepCount++;
        const p = pdrStep({ x: this.x, y: this.y }, this.heading(), this.stepLengthM);
        this.x = p.x;
        this.y = p.y;
      }
    };
    const orientEvent = "ondeviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation";
    window.addEventListener(orientEvent, onOrient as EventListener);
    window.addEventListener("devicemotion", onMotion);
    this.off = [() => window.removeEventListener(orientEvent, onOrient as EventListener), () => window.removeEventListener("devicemotion", onMotion)];
    this.timer = setInterval(() => this.emit(), 1000 / cfg.sampleHz);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.off.forEach((f) => f());
    this.off = [];
  }

  private heading() {
    return (this.rawHeading + this.offset + 360) % 360;
  }

  private emit() {
    const t = now();
    const p: Pose = {
      t, x: this.x, y: this.y, headingDeg: this.heading(), steps: this.stepCount,
      confidence: poseConfidence(this.stepCount, (t - this.anchorT) / 1000),
      stationary: t - this.lastStepT > 1500,
    };
    this.history.push(p);
    if (this.history.length > 600) this.history.shift();
    this.poses.emit(p);
  }

  /** Dev-only meaning: treat the direction the phone points now as heading 0. */
  async calibrateForward() {
    this.offset = wrap180(-this.rawHeading);
    this.anchorT = now();
  }
  async calibrateStepLength({ distanceM }: { distanceM: number }) {
    const n = this.stepCount - this.stepsAtMark;
    if (n > 0) this.stepLengthM = distanceM / n;
    this.stepsAtMark = this.stepCount;
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
}

/** No glasses in a browser: arrow keys simulate head yaw so the HUD head-tracking path can be exercised. */
export class WebHeadPose implements HeadPosePlugin {
  readonly mode = "web" as const;
  private readonly heads = new Emitter<HeadPose>();
  private yaw = 0;
  private zero = 0;
  private active = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    this.active = true;
    this.yaw += e.key === "ArrowRight" ? 5 : -5;
  };

  async start() {
    window.addEventListener("keydown", this.onKey);
    this.timer = setInterval(() => {
      if (this.active) this.heads.emit({ t: now(), yawDeg: (this.yaw - this.zero + 360) % 360, pitchDeg: 0, source: "glasses" });
    }, 50);
  }
  async stop() {
    window.removeEventListener("keydown", this.onKey);
    if (this.timer) clearInterval(this.timer);
  }
  async zeroView() {
    this.zero = this.yaw;
  }
  onHeadPose(cb: (h: HeadPose) => void): Unsubscribe {
    return this.heads.on(cb);
  }
}

/** Desktop keyboard standing in for the native key events: Space = PTT, N = narrate placement, M (hold) = recenter. */
export class WebKeys implements HardwareKeys {
  readonly mode = "web" as const;
  private readonly keys = new Emitter<KeyEvent>();
  private static readonly MAP: Record<string, number> = { " ": KEYCODE.VOLUME_UP, n: KEYCODE.VOLUME_DOWN, m: KEYCODE.MEDIA_NEXT };
  private handler = (action: "down" | "up") => (e: KeyboardEvent) => {
    const code = WebKeys.MAP[e.key.toLowerCase()];
    if (code === undefined || e.repeat) return;
    if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
    e.preventDefault();
    this.keys.emit({ t: now(), keyCode: code, action });
  };
  private down = this.handler("down");
  private up = this.handler("up");

  async start() {
    window.addEventListener("keydown", this.down);
    window.addEventListener("keyup", this.up);
  }
  async stop() {
    window.removeEventListener("keydown", this.down);
    window.removeEventListener("keyup", this.up);
  }
  onKey(cb: (e: KeyEvent) => void): Unsubscribe {
    return this.keys.on(cb);
  }
}
