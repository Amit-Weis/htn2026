import type { ClientMessage, Frame, PlacementTrigger, Pose, ServerMessage } from "@lastseen/shared";
import type { CandidateFilter, FilterResult, PoseRing } from "./candidateFilter";
import type { PoseCorrector } from "./poseCorrector";
import type { DetectorPlugin, PosePlugin, Unsubscribe } from "./native/types";

export interface BridgeDeps {
  plugins: { detector: DetectorPlugin; pose: PosePlugin };
  send: (m: ClientMessage) => void;
  filter: CandidateFilter;
  ring: PoseRing;
  corrector: PoseCorrector;
  /** epoch ms; the sim injects a virtual clock */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  note?: (s: string) => void;
  /** send at most one pose per this many ms of pose time */
  poseIntervalMs?: number;
}

export interface Narration {
  audioB64: string;
  mime: string;
}

/**
 * DOM-free core of the wearer app: native plugin events -> guarded uploads to the agent.
 * The app (real device / browser) and the sim (tools/sim) both run exactly this code.
 */
export class Bridge {
  pose: Pose | null = null;
  private lastPoseSentT = -Infinity;
  private readonly offs: Unsubscribe[] = [];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly d: BridgeDeps) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.offs.push(
      d.plugins.pose.onPose((raw) => this.onPose(raw)),
      d.plugins.pose.onPutDown((e) => void this.backupCapture("put_down", e.t)),
      d.plugins.detector.onPlacementCandidate((e) => this.upload(d.filter.process({ ...e, trigger: "detector" }))),
    );
  }

  dispose() {
    this.offs.forEach((o) => o());
  }

  private note(s: string) {
    this.d.note?.(s);
  }

  private onPose(raw: Pose) {
    const p = this.d.corrector.apply(raw);
    this.pose = p;
    this.d.ring.push(p);
    if (p.t - this.lastPoseSentT >= (this.d.poseIntervalMs ?? 500)) {
      this.lastPoseSentT = p.t;
      this.d.send({ type: "pose", ...p });
    }
  }

  /** Runs the phone-side filter result: upload on success, note the reason on a drop. */
  upload(r: FilterResult) {
    if (r.ok) {
      this.d.send(r.candidate);
      this.note(`upload ${r.candidate.trigger} (${r.candidate.frames.length} frames)`);
    } else {
      this.note(`drop ${r.reason}: ${r.detail}`);
    }
    return r;
  }

  /**
   * Backup triggers (voice narration, dashboard remote button, put_down): read frames around `t` from the
   * native ring buffer instead of relying on the detector's own candidate.
   */
  async backupCapture(trigger: PlacementTrigger, t: number, narration?: Narration) {
    await this.sleep(trigger === "put_down" ? 800 : 300); // let the "after" frames land in the ring
    const got = await this.d.plugins.detector.getFrames({ fromT: t - 3000, toT: this.now(), maxFrames: 6 });
    const still = await this.d.plugins.detector.captureStill().catch(() => null);
    return this.upload(
      this.d.filter.process({
        t, trigger, frames: got.frames, detections: got.detections, stillFrame: still ?? undefined,
        narrationAudioB64: narration?.audioB64, narrationMime: narration?.mime,
      }),
    );
  }

  /** The latest small frame for `request_frame` and utterances. */
  async latestFrame(): Promise<Frame | null> {
    const t = this.now();
    const got = await this.d.plugins.detector.getFrames({ fromT: t - 2000, toT: t, maxFrames: 1 }).catch(() => ({ frames: [] as Frame[] }));
    return got.frames.at(-1) ?? null;
  }

  /** Handles the server messages that are pure bridge business; returns true if it consumed the message. */
  async onServer(m: ServerMessage): Promise<boolean> {
    switch (m.type) {
      case "capture_now":
        void this.backupCapture("manual", this.now());
        return true;
      case "request_frame":
        this.d.send({ type: "frame_response", requestId: m.requestId, frame: await this.latestFrame() });
        return true;
      case "pose_correction":
        this.d.corrector.add(m);
        return true;
      default:
        return false;
    }
  }
}
