import { describe, expect, it } from "vitest";
import {
  HEAD_POSE_FRESH_MS,
  arrowAngle,
  arrowAngleFromHeading,
  calibrateHeadOffset,
  headHeading,
  movingFraction,
  poseAt,
} from "./geometry";

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);
const NOW = 1_800_000_000_000;
const origin = { x: 0, y: 0 };

describe("headHeading", () => {
  it("uses the glasses yaw plus offset when the head pose is fresh", () => {
    close(headHeading({ headingDeg: 10 }, { t: NOW - 100, yawDeg: 40 }, 5, NOW), 45);
  });
  it("wraps yaw + offset across 360", () => {
    close(headHeading({ headingDeg: 0 }, { t: NOW, yawDeg: 350 }, 20, NOW), 10);
    close(headHeading({ headingDeg: 0 }, { t: NOW, yawDeg: 10 }, -20, NOW), 350);
  });
  it("falls back to the chest heading when the head pose is stale (>= 300 ms)", () => {
    expect(HEAD_POSE_FRESH_MS).toBe(300);
    close(headHeading({ headingDeg: 10 }, { t: NOW - 300, yawDeg: 40 }, 5, NOW), 10);
    close(headHeading({ headingDeg: 10 }, { t: NOW - 299, yawDeg: 40 }, 5, NOW), 45);
    close(headHeading({ headingDeg: 370 }, { t: NOW - 5000, yawDeg: 40 }, 5, NOW), 10);
  });
  it("falls back when there is no head pose, or it is from the future (clock skew)", () => {
    close(headHeading({ headingDeg: 77 }, null, 5, NOW), 77);
    close(headHeading({ headingDeg: 77 }, undefined, 5, NOW), 77);
    close(headHeading({ headingDeg: 77 }, { t: NOW + 1000, yawDeg: 10 }, 0, NOW), 77);
  });
});

describe("arrowAngle with head pose", () => {
  it("matches the chest-only angle when there is no head pose", () => {
    const pose = { x: 0, y: 0, headingDeg: 30 };
    close(arrowAngle({ x: 5, y: 0 }, pose, null, 0, NOW), arrowAngleFromHeading({ x: 5, y: 0 }, origin, 30));
  });
  it("turns with the head, not the chest", () => {
    const pose = { x: 0, y: 0, headingDeg: 0 };
    const east = { x: 5, y: 0 };
    close(arrowAngle(east, pose, null, 0, NOW), 90);
    // looking east (yaw 90) => straight ahead
    close(arrowAngle(east, pose, { t: NOW, yawDeg: 90 }, 0, NOW), 0);
    // looking south => target is 90 degrees to the left
    close(arrowAngle(east, pose, { t: NOW, yawDeg: 180 }, 0, NOW), -90);
  });
  it("wraps at +/-180 with a head pose", () => {
    const pose = { x: 0, y: 0, headingDeg: 0 };
    const south = { x: 0, y: -5 };
    // head 170 -> +10, head 190 -> -10
    close(arrowAngle(south, pose, { t: NOW, yawDeg: 170 }, 0, NOW), 10);
    close(arrowAngle(south, pose, { t: NOW, yawDeg: 190 }, 0, NOW), -10);
    // exactly behind => +180 (range is (-180, 180])
    close(arrowAngle(south, pose, { t: NOW, yawDeg: 0 }, 0, NOW), 180);
  });
  it("applies the head offset", () => {
    const pose = { x: 0, y: 0, headingDeg: 0 };
    close(arrowAngle({ x: 0, y: 5 }, pose, { t: NOW, yawDeg: 350 }, 10, NOW), 0);
  });
  it("uses the chest heading again once the head pose goes stale", () => {
    const pose = { x: 0, y: 0, headingDeg: 0 };
    const east = { x: 5, y: 0 };
    close(arrowAngle(east, pose, { t: NOW - 1000, yawDeg: 90 }, 0, NOW), 90);
  });
});

describe("calibrateHeadOffset", () => {
  it("makes the head heading equal the chest heading at calibration time", () => {
    const pose = { headingDeg: 100 };
    const head = { t: NOW, yawDeg: 30 };
    const off = calibrateHeadOffset(pose, head);
    close(off, 70);
    close(headHeading(pose, head, off, NOW), 100);
  });
  it("handles wraparound", () => {
    const pose = { headingDeg: 5 };
    const head = { t: NOW, yawDeg: 350 };
    const off = calibrateHeadOffset(pose, head);
    close(off, 15);
    close(headHeading(pose, head, off, NOW), 5);
    const off2 = calibrateHeadOffset({ headingDeg: 350 }, { yawDeg: 5 });
    close(off2, -15);
    close(headHeading({ headingDeg: 350 }, { t: NOW, yawDeg: 5 }, off2, NOW), 350);
  });
});

describe("poseAt / movingFraction", () => {
  const slice = [
    { t: 1000, x: 0, y: 0, headingDeg: 350, stationary: true },
    { t: 2000, x: 2, y: 4, headingDeg: 10, stationary: false },
  ];
  it("interpolates position and takes the short way round for heading", () => {
    const p = poseAt(slice, 1500)!;
    close(p.x, 1);
    close(p.y, 2);
    close(p.headingDeg, 0);
  });
  it("clamps outside the slice and handles empty", () => {
    expect(poseAt(slice, 0)).toBe(slice[0]);
    expect(poseAt(slice, 9999)).toBe(slice[1]);
    expect(poseAt([], 1)).toBeNull();
  });
  it("movingFraction", () => {
    expect(movingFraction([])).toBe(0);
    expect(movingFraction([{ stationary: true }, { stationary: false }, { stationary: false }, { stationary: false }])).toBe(0.75);
  });
});
