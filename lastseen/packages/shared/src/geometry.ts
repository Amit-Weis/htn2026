/**
 * Geometry for Lastseen. Local frame: meters, x east, y north.
 * Heading h = azimuth in degrees clockwise from north of the camera-forward direction.
 */

export const DEG = Math.PI / 180;

export interface Vec2 {
  x: number;
  y: number;
}

/** Wrap an angle to (-180, 180]. */
export function wrap180(deg: number): number {
  let r = ((deg % 360) + 360) % 360;
  if (r > 180) r -= 360;
  return r;
}

/** Wrap an angle to [0, 360). */
export function wrap360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Camera-forward heading from W3C DeviceOrientation angles (alpha/beta/gamma, degrees).
 *
 * Uses the full rotation matrix R = Rz(alpha) Rx(beta) Ry(gamma). The device -Z axis
 * (out of the back camera) in the earth frame (x east, y north, z up) is -R[:,2], and the
 * heading is the azimuth of its horizontal projection. Raw alpha is NOT used: with the phone
 * upright (beta ~ 90) alpha and gamma are degenerate (gimbal lock) but alpha+gamma is not.
 */
export function headingFromOrientation(alphaDeg: number, betaDeg: number, gammaDeg: number): number {
  const a = alphaDeg * DEG;
  const b = betaDeg * DEG;
  const g = gammaDeg * DEG;
  const zEast = Math.cos(a) * Math.sin(g) + Math.sin(a) * Math.sin(b) * Math.cos(g);
  const zNorth = Math.sin(a) * Math.sin(g) - Math.cos(a) * Math.sin(b) * Math.cos(g);
  // camera-forward = -z_device; alpha grows counter-clockwise, so azimuth = atan2(east, north)
  const fEast = -zEast;
  const fNorth = -zNorth;
  return wrap360(Math.atan2(fEast, fNorth) / DEG);
}

/** Azimuth (deg clockwise from north, [0,360)) of the vector (dx east, dy north). */
export function azimuthDeg(dx: number, dy: number): number {
  return wrap360(Math.atan2(dx, dy) / DEG);
}

/** Pedestrian dead reckoning: advance one step of length L along heading h. */
export function pdrStep(p: Vec2, headingDeg: number, stepLengthM = 0.7): Vec2 {
  const h = headingDeg * DEG;
  return { x: p.x + stepLengthM * Math.sin(h), y: p.y + stepLengthM * Math.cos(h) };
}

export const DEFAULT_HFOV_DEG = 70;
export const DEFAULT_OBJECT_DISTANCE_M = 0.8;
export const MIN_OBJECT_DISTANCE_M = 0.3;
export const MAX_OBJECT_DISTANCE_M = 3;

/** OMNI distance estimate clipped to [0.3, 3] m; missing/invalid falls back to 0.8 m. */
export function clipDistance(d: number | null | undefined): number {
  if (d == null || !Number.isFinite(d) || d <= 0) return DEFAULT_OBJECT_DISTANCE_M;
  return Math.min(MAX_OBJECT_DISTANCE_M, Math.max(MIN_OBJECT_DISTANCE_M, d));
}

/**
 * Object position at placement = pose at frame time + d * (sin(h+phi), cos(h+phi)),
 * phi = (bboxCenterX - 0.5) * hfov.
 */
export function objectPosition(
  pose: Vec2,
  headingDeg: number,
  bboxCenterX: number,
  distanceM: number | null | undefined,
  hfovDeg = DEFAULT_HFOV_DEG,
): Vec2 {
  const phi = (bboxCenterX - 0.5) * hfovDeg;
  const d = clipDistance(distanceM);
  const b = (headingDeg + phi) * DEG;
  return { x: pose.x + d * Math.sin(b), y: pose.y + d * Math.cos(b) };
}

/** Arrow angle = wrap180(atan2(dx, dy) - h_now); 0 = straight ahead, + = clockwise (right). */
export function arrowAngle(target: Vec2, pose: Vec2, headingDeg: number): number {
  return wrap180(azimuthDeg(target.x - pose.x, target.y - pose.y) - headingDeg);
}

export function distanceM(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export interface ConfidenceConfig {
  /** Steps after which pose confidence has decayed to 1/e. */
  stepScale: number;
  /** Seconds after which pose confidence has decayed to 1/e. */
  timeScale: number;
}

export const DEFAULT_CONFIDENCE: ConfidenceConfig = { stepScale: 120, timeScale: 600 };

/** Pose confidence decays with steps and time since the last anchor (zone anchor or start). */
export function poseConfidence(
  stepsSinceAnchor: number,
  secSinceAnchor: number,
  cfg: ConfidenceConfig = DEFAULT_CONFIDENCE,
): number {
  return Math.exp(-Math.max(0, stepsSinceAnchor) / cfg.stepScale) * Math.exp(-Math.max(0, secSinceAnchor) / cfg.timeScale);
}

export const DEFAULT_MIN_CONFIDENCE = 0.35;
export const DEFAULT_MAX_RANGE_M = 15;

/** "arrow" when we trust the position and it is in range; otherwise the coarse "zone" mode. */
export function chooseMode(
  confidence: number,
  distance: number,
  minConfidence = DEFAULT_MIN_CONFIDENCE,
  maxRangeM = DEFAULT_MAX_RANGE_M,
): "arrow" | "zone" {
  return confidence < minConfidence || distance > maxRangeM ? "zone" : "arrow";
}

/** Exponential low-pass on an angle (handles wraparound by smoothing the wrapped difference). */
export function smoothAngle(prevDeg: number, targetDeg: number, alpha: number): number {
  return wrap180(prevDeg + alpha * wrap180(targetDeg - prevDeg));
}

export interface StepDetectorConfig {
  /** Minimum time between steps. */
  minIntervalMs: number;
  /** Absolute floor for the adaptive threshold (m/s^2 of deviation from gravity). */
  minThreshold: number;
  /** Threshold = mean + k * std of the recent deviation signal. */
  k: number;
}

export const DEFAULT_STEP_DETECTOR: StepDetectorConfig = { minIntervalMs: 300, minThreshold: 0.6, k: 0.8 };

/**
 * Streaming accelerometer-magnitude peak detector with an adaptive threshold.
 * Feed samples with push(); it returns true when a step peak is confirmed
 * (one sample after the peak, since a peak needs its successor).
 */
export class StepDetector {
  private gravity = 9.81;
  private prevPrev = 0;
  private prev = 0;
  private prevT = 0;
  private lastStepT = -Infinity;
  private mean = 0;
  private variance = 0;
  private smoothed = 0;
  private n = 0;

  constructor(private readonly cfg: StepDetectorConfig = DEFAULT_STEP_DETECTOR) {}

  /** ax/ay/az in m/s^2 (including gravity), tMs monotonic ms. */
  push(ax: number, ay: number, az: number, tMs: number): boolean {
    const mag = Math.hypot(ax, ay, az);
    this.gravity += 0.01 * (mag - this.gravity);
    const dev = mag - this.gravity;
    this.smoothed += 0.4 * (dev - this.smoothed);
    const s = this.smoothed;

    const a = 0.02;
    this.mean += a * (s - this.mean);
    this.variance += a * ((s - this.mean) ** 2 - this.variance);
    this.n++;

    const threshold = Math.max(this.cfg.minThreshold, this.mean + this.cfg.k * Math.sqrt(this.variance));
    let step = false;
    if (
      this.n > 3 &&
      this.prev > this.prevPrev &&
      this.prev >= s &&
      this.prev > threshold &&
      this.prevT - this.lastStepT >= this.cfg.minIntervalMs
    ) {
      this.lastStepT = this.prevT;
      step = true;
    }
    this.prevPrev = this.prev;
    this.prev = s;
    this.prevT = tMs;
    return step;
  }
}
