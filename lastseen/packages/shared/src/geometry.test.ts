import { describe, expect, it } from "vitest";
import {
  arrowAngle,
  azimuthDeg,
  chooseMode,
  clipDistance,
  distanceM,
  headingFromOrientation,
  objectPosition,
  pdrStep,
  poseConfidence,
  smoothAngle,
  StepDetector,
  wrap180,
  wrap360,
} from "./geometry";

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("wrap180 / wrap360", () => {
  it("wraps into (-180, 180]", () => {
    close(wrap180(0), 0);
    close(wrap180(180), 180);
    close(wrap180(-180), 180);
    close(wrap180(181), -179);
    close(wrap180(-181), 179);
    close(wrap180(360), 0);
    close(wrap180(725), 5);
    close(wrap180(-725), -5);
  });
  it("wraps into [0, 360)", () => {
    close(wrap360(-1), 359);
    close(wrap360(360), 0);
    close(wrap360(721), 1);
  });
});

describe("azimuthDeg (clockwise from north)", () => {
  it("cardinal directions", () => {
    close(azimuthDeg(0, 1), 0);
    close(azimuthDeg(1, 0), 90);
    close(azimuthDeg(0, -1), 180);
    close(azimuthDeg(-1, 0), 270);
    close(azimuthDeg(1, 1), 45);
  });
});

describe("pdrStep", () => {
  it("moves north / east / south / west", () => {
    let p = pdrStep({ x: 0, y: 0 }, 0, 0.7);
    close(p.x, 0);
    close(p.y, 0.7);
    p = pdrStep({ x: 0, y: 0 }, 90, 0.7);
    close(p.x, 0.7);
    close(p.y, 0);
    p = pdrStep({ x: 0, y: 0 }, 180, 1);
    close(p.y, -1);
    p = pdrStep({ x: 0, y: 0 }, 270, 1);
    close(p.x, -1);
  });
  it("accumulates a square walk back to the origin", () => {
    let p = { x: 0, y: 0 };
    for (const h of [0, 90, 180, 270]) for (let i = 0; i < 10; i++) p = pdrStep(p, h, 0.7);
    close(p.x, 0);
    close(p.y, 0);
  });
  it("default step length is 0.7 m", () => {
    close(distanceM({ x: 0, y: 0 }, pdrStep({ x: 0, y: 0 }, 33)), 0.7);
  });
});

describe("headingFromOrientation (upright phone, rear camera forward)", () => {
  it("alpha=0 upright faces north", () => close(headingFromOrientation(0, 90, 0), 0));
  it("alpha counter-clockwise => azimuth clockwise", () => {
    close(headingFromOrientation(90, 90, 0), 270); // west
    close(headingFromOrientation(270, 90, 0), 90); // east
    close(headingFromOrientation(180, 90, 0), 180); // south
  });
  it("is invariant to the alpha/gamma gimbal ambiguity at beta=90", () => {
    close(headingFromOrientation(30, 90, 20), headingFromOrientation(50, 90, 0));
    close(headingFromOrientation(300, 90, -40), headingFromOrientation(260, 90, 0));
  });
  it("stays stable for small tilt away from upright", () => {
    const h = headingFromOrientation(270, 80, 0);
    expect(Math.abs(wrap180(h - 90))).toBeLessThan(1);
  });
});

describe("clipDistance / objectPosition", () => {
  it("clips to [0.3, 3] and defaults to 0.8", () => {
    close(clipDistance(0.1), 0.3);
    close(clipDistance(10), 3);
    close(clipDistance(1.5), 1.5);
    close(clipDistance(null), 0.8);
    close(clipDistance(undefined), 0.8);
    close(clipDistance(Number.NaN), 0.8);
    close(clipDistance(-2), 0.8);
  });
  it("places an object straight ahead when the bbox is centered", () => {
    const p = objectPosition({ x: 1, y: 2 }, 0, 0.5, 2);
    close(p.x, 1);
    close(p.y, 4);
  });
  it("offsets by phi = (cx - 0.5) * hfov", () => {
    // right edge with hfov 70 => +35 deg; heading 0, d=1
    const p = objectPosition({ x: 0, y: 0 }, 0, 1, 1, 70);
    close(p.x, Math.sin((35 * Math.PI) / 180));
    close(p.y, Math.cos((35 * Math.PI) / 180));
  });
  it("combines heading and phi across the north wraparound", () => {
    // heading 350 + phi 20 = 10 deg
    const p = objectPosition({ x: 0, y: 0 }, 350, 0.5 + 20 / 70, 1, 70);
    close(azimuthDeg(p.x, p.y), 10, 1e-6);
  });
});

describe("arrowAngle", () => {
  const origin = { x: 0, y: 0 };
  it("is 0 when the target is straight ahead", () => {
    close(arrowAngle({ x: 0, y: 5 }, origin, 0), 0);
    close(arrowAngle({ x: 5, y: 0 }, origin, 90), 0);
  });
  it("is +90 when the target is to the right, -90 to the left", () => {
    close(arrowAngle({ x: 5, y: 0 }, origin, 0), 90);
    close(arrowAngle({ x: -5, y: 0 }, origin, 0), -90);
  });
  it("is +/-180 when the target is behind", () => {
    close(Math.abs(arrowAngle({ x: 0, y: -5 }, origin, 0)), 180);
  });
  it("wraps correctly across +/-180", () => {
    // heading 170, target due south (bearing 180) => +10
    close(arrowAngle({ x: 0, y: -5 }, origin, 170), 10);
    // heading 190 (=-170), target due south => -10
    close(arrowAngle({ x: 0, y: -5 }, origin, 190), -10);
    // heading 10, target bearing 350 => -20 (through north)
    close(arrowAngle({ x: -Math.sin((10 * Math.PI) / 180), y: Math.cos((10 * Math.PI) / 180) }, origin, 10), -20);
    // heading 350, target bearing 10 => +20
    close(arrowAngle({ x: Math.sin((10 * Math.PI) / 180), y: Math.cos((10 * Math.PI) / 180) }, origin, 350), 20);
  });
  it("handles a pose that is not at the origin", () => {
    close(arrowAngle({ x: 11, y: 20 }, { x: 10, y: 20 }, 0), 90);
  });
});

describe("smoothAngle", () => {
  it("takes the short way around the wrap", () => {
    // 170 -> -170 is a 20 deg move through 180, not 340 the other way
    const s = smoothAngle(170, -170, 0.5);
    close(s, 180);
  });
  it("converges", () => {
    let a = 0;
    for (let i = 0; i < 100; i++) a = smoothAngle(a, 90, 0.2);
    close(a, 90, 1e-3);
  });
});

describe("confidence and mode", () => {
  it("decays with steps and time", () => {
    close(poseConfidence(0, 0), 1);
    expect(poseConfidence(120, 0)).toBeLessThan(poseConfidence(60, 0));
    expect(poseConfidence(0, 600)).toBeLessThan(poseConfidence(0, 60));
    expect(poseConfidence(50, 100)).toBeLessThan(poseConfidence(50, 0));
  });
  it("switches to zone mode on low confidence or long range", () => {
    expect(chooseMode(0.9, 3)).toBe("arrow");
    expect(chooseMode(0.2, 3)).toBe("zone");
    expect(chooseMode(0.9, 40)).toBe("zone");
    expect(chooseMode(0.9, 15)).toBe("arrow");
  });
});

describe("StepDetector", () => {
  function walk(hz: number, amp: number, seconds: number, rate = 50): number {
    const det = new StepDetector();
    let steps = 0;
    for (let i = 0; i < seconds * rate; i++) {
      const t = i / rate;
      const az = 9.81 + amp * Math.sin(2 * Math.PI * hz * t);
      if (det.push(0, 0, az, t * 1000)) steps++;
    }
    return steps;
  }

  it("counts steps for a 1.8 Hz walk", () => {
    const n = walk(1.8, 2.5, 10);
    expect(n).toBeGreaterThanOrEqual(16);
    expect(n).toBeLessThanOrEqual(19);
  });
  it("counts steps for a gentler 1.4 Hz walk", () => {
    const n = walk(1.4, 1.5, 10);
    expect(n).toBeGreaterThanOrEqual(12);
    expect(n).toBeLessThanOrEqual(15);
  });
  it("counts nothing when standing still with sensor noise", () => {
    const det = new StepDetector();
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.2;
    let steps = 0;
    for (let i = 0; i < 1000; i++) if (det.push(rnd(), rnd(), 9.81 + rnd(), i * 20)) steps++;
    expect(steps).toBe(0);
  });
  it("enforces the ~300 ms minimum step interval", () => {
    // 5 Hz shaking would be 50 peaks in 10 s; the limiter caps it at 1000/300 = 33
    expect(walk(5, 3, 10)).toBeLessThanOrEqual(34);
  });
});
