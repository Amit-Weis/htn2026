import { arrowAngle, distanceM, formatAge, headHeading, smoothAngle, wrap180 } from "@lastseen/shared";
import type { AgentStatus, HeadPose, Pose, TrackerState } from "@lastseen/shared";

export interface HudInput {
  state: Pick<TrackerState, "target" | "status" | "lastReply">;
  /** the phone's own current pose (after any pose_correction) */
  pose: Pose;
  headPose: HeadPose | null;
  headOffsetDeg: number;
  /** epoch ms */
  nowMs: number;
  /** previous displayed angle, for low-pass smoothing */
  prevAngleDeg: number;
  /** ms since the previous frame */
  dtMs: number;
}

export interface HudView {
  hasTarget: boolean;
  mode: "arrow" | "zone" | "none";
  /** angle to draw: 0 = straight ahead, clockwise positive, smoothed */
  angleDeg: number;
  label: string;
  zone: string;
  age: string;
  distance: string;
  status: AgentStatus;
  /** true while the arrow follows the glasses head pose instead of the chest heading */
  usingHead: boolean;
  headingDeg: number;
}

/** Time constant of the arrow's low-pass filter. The HUD loop runs at >= 10 Hz. */
export const ARROW_TAU_MS = 120;

/** Zone mode shows only a coarse direction: snap to 45-degree sectors. */
export const quantize45 = (deg: number) => wrap180(Math.round(deg / 45) * 45);

export function computeHud(i: HudInput): HudView {
  const t = i.state.target;
  const headingDeg = headHeading(i.pose, i.headPose, i.headOffsetDeg, i.nowMs);
  const usingHead = Boolean(i.headPose) && i.nowMs - (i.headPose?.t ?? 0) < 300 && i.nowMs - (i.headPose?.t ?? 0) >= 0;
  const base = { status: i.state.status, usingHead, headingDeg };
  if (!t) return { ...base, hasTarget: false, mode: "none", angleDeg: i.prevAngleDeg, label: "", zone: "", age: "", distance: "" };

  const raw = arrowAngle(t, i.pose, i.headPose, i.headOffsetDeg, i.nowMs);
  const target = t.mode === "zone" ? quantize45(raw) : raw;
  const alpha = 1 - Math.exp(-Math.max(0, i.dtMs) / ARROW_TAU_MS);
  const angleDeg = smoothAngle(i.prevAngleDeg, target, alpha);
  const ageSec = t.ageSec + Math.max(0, i.nowMs - t.setAt) / 1000;
  const d = distanceM(i.pose, t);
  return {
    ...base,
    hasTarget: true,
    mode: t.mode,
    angleDeg,
    label: t.label,
    zone: t.zone ?? "",
    age: formatAge(ageSec),
    distance: d < 10 ? `${d.toFixed(1)} m` : `${Math.round(d)} m`,
  };
}
