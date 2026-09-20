import { wrap360 } from "@lastseen/shared";
import type { Pose } from "@lastseen/shared";

/**
 * The native PosePlugin reports raw dead-reckoned poses. When the agent snaps to a zone anchor it sends
 * `pose_correction{dx,dy,dHeadingDeg}`; the web layer accumulates those and applies them to every pose it
 * uses or uploads, so native never needs to know about anchors.
 */
export class PoseCorrector {
  dx = 0;
  dy = 0;
  dHeadingDeg = 0;

  add(c: { dx: number; dy: number; dHeadingDeg: number }) {
    this.dx += c.dx;
    this.dy += c.dy;
    this.dHeadingDeg += c.dHeadingDeg;
  }

  apply(p: Pose): Pose {
    if (!this.dx && !this.dy && !this.dHeadingDeg) return p;
    return { ...p, x: p.x + this.dx, y: p.y + this.dy, headingDeg: wrap360(p.headingDeg + this.dHeadingDeg) };
  }
}
