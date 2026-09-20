/**
 * Browser/sim FALLBACK trigger gate (the real detector runs natively on the phone).
 * Motion energy rises when something moves into view, then must stay low for `settleMs`
 * (the scene settled) to produce one placement candidate.
 */
export interface MotionGateConfig {
  /** energy above this is "activity" */
  highThreshold: number;
  /** energy below this counts as settled */
  lowThreshold: number;
  settleMs: number;
  /** ignore activity that lasts longer than this (camera being swung around, not a placement) */
  maxActivityMs: number;
}

export const DEFAULT_MOTION_GATE: MotionGateConfig = { highThreshold: 6, lowThreshold: 2, settleMs: 800, maxActivityMs: 6000 };

export class MotionGate {
  private activeSince: number | null = null;
  private settledSince: number | null = null;

  constructor(private readonly cfg: MotionGateConfig = DEFAULT_MOTION_GATE) {}

  /** Feed one motion-energy sample (epoch ms). Returns true when a candidate should fire. */
  push(energy: number, t: number): boolean {
    if (energy >= this.cfg.highThreshold) {
      if (this.activeSince === null) this.activeSince = t;
      this.settledSince = null;
      return false;
    }
    if (this.activeSince === null) return false;
    if (energy > this.cfg.lowThreshold) {
      this.settledSince = null;
      return false;
    }
    this.settledSince ??= t;
    if (t - this.settledSince < this.cfg.settleMs) return false;
    const activityMs = this.settledSince - this.activeSince;
    this.activeSince = null;
    this.settledSince = null;
    return activityMs <= this.cfg.maxActivityMs;
  }

  reset() {
    this.activeSince = null;
    this.settledSince = null;
  }
}

/** Mean absolute difference between two same-size grayscale frames. */
export function motionEnergy(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(a[i]! - b[i]!);
  return s / n;
}
