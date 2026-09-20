import { WALK_EXEMPT_TRIGGERS, movingFraction, poseAt } from "@lastseen/shared";
import type { Detection, Frame, PlacementCandidate, PlacementTrigger, Pose } from "@lastseen/shared";

/** Local ring buffer of recent poses (epoch-ms timestamps). */
export class PoseRing {
  private items: Pose[] = [];
  constructor(private readonly keepMs = 30_000) {}

  push(p: Pose) {
    this.items.push(p);
    const cutoff = p.t - this.keepMs;
    if (this.items[0]!.t < cutoff) this.items = this.items.filter((x) => x.t >= cutoff);
  }
  slice(fromT: number, toT: number): Pose[] {
    return this.items.filter((p) => p.t >= fromT && p.t <= toT);
  }
  at(t: number): Pose | null {
    return poseAt(this.items, t);
  }
  latest(): Pose | null {
    return this.items[this.items.length - 1] ?? null;
  }
  get size() {
    return this.items.length;
  }
}

export interface FilterConfig {
  hfovDeg: number;
  /** "was the wearer walking during [t - walkBeforeMs, t + walkAfterMs]" */
  walkBeforeMs: number;
  walkAfterMs: number;
  /** walking if more than this fraction of the window's poses are non-stationary */
  walkFraction: number;
  cooldownMs: number;
  /** pose slice attached to the upload */
  sliceBeforeMs: number;
  sliceAfterMs: number;
  maxFrames: number;
}

export const DEFAULT_FILTER: FilterConfig = {
  hfovDeg: 70,
  walkBeforeMs: 1500,
  walkAfterMs: 500,
  walkFraction: 0.5,
  cooldownMs: 4000,
  sliceBeforeMs: 4000,
  sliceAfterMs: 500,
  maxFrames: 6,
};

export interface RawCandidate {
  t: number;
  trigger: PlacementTrigger;
  frames: Frame[];
  stillFrame?: Frame;
  detections?: Detection[][];
  narrationAudioB64?: string;
  narrationMime?: string;
}

export type FilterResult =
  | { ok: true; candidate: PlacementCandidate }
  | { ok: false; reason: "walking" | "cooldown" | "no_frames"; detail: string };

/**
 * Phone-side gate in front of the upload: drop a candidate when the wearer was walking around the event
 * (unless the trigger is explicit wearer intent), enforce the cooldown, then attach the pose slice.
 * Every drop is reported so the HUD/debug overlay can show why nothing was uploaded.
 */
export class CandidateFilter {
  private lastAcceptedT: number | null = null;
  readonly drops: Record<string, number> = {};

  constructor(
    private readonly ring: PoseRing,
    private readonly cfg: FilterConfig = DEFAULT_FILTER,
  ) {}

  private drop(reason: "walking" | "cooldown" | "no_frames", detail: string): FilterResult {
    this.drops[reason] = (this.drops[reason] ?? 0) + 1;
    return { ok: false, reason, detail };
  }

  process(raw: RawCandidate): FilterResult {
    const frames = raw.frames.filter((f) => f.jpegBase64 || f.uri);
    if (!frames.length) return this.drop("no_frames", "candidate carries no frames");

    if (!WALK_EXEMPT_TRIGGERS.includes(raw.trigger)) {
      const win = this.ring.slice(raw.t - this.cfg.walkBeforeMs, raw.t + this.cfg.walkAfterMs);
      const moving = movingFraction(win);
      if (win.length && moving > this.cfg.walkFraction) return this.drop("walking", `${Math.round(moving * 100)}% of poses in the window were non-stationary`);
    }

    if (this.lastAcceptedT !== null && Math.abs(raw.t - this.lastAcceptedT) < this.cfg.cooldownMs) {
      return this.drop("cooldown", `${Math.abs(raw.t - this.lastAcceptedT)} ms since the last upload (< ${this.cfg.cooldownMs})`);
    }
    this.lastAcceptedT = raw.t;

    // at most 6 keyframes, evenly spread; keep detections aligned with the frames we keep
    const idx = pickEven(frames.length, this.cfg.maxFrames);
    const kept = idx.map((i) => frames[i]!);
    const detections = raw.detections && raw.detections.length === raw.frames.length && frames.length === raw.frames.length
      ? idx.map((i) => raw.detections![i] ?? [])
      : raw.detections && raw.detections.length === frames.length
        ? idx.map((i) => raw.detections![i] ?? [])
        : undefined;

    return {
      ok: true,
      candidate: {
        type: "placement_candidate",
        t: raw.t,
        trigger: raw.trigger,
        frames: kept,
        stillFrame: raw.stillFrame,
        detections,
        poseSlice: this.ring.slice(raw.t - this.cfg.sliceBeforeMs, raw.t + this.cfg.sliceAfterMs),
        hfovDeg: this.cfg.hfovDeg,
        narrationAudioB64: raw.narrationAudioB64,
        narrationMime: raw.narrationMime,
      },
    };
  }
}

function pickEven(n: number, max: number): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  if (max <= 1) return [n - 1]; // the newest frame
  return Array.from({ length: max }, (_, i) => Math.round((i * (n - 1)) / (max - 1)));
}
