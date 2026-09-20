import { describe, expect, it } from "vitest";
import { NATIVE_EXAMPLES, NATIVE_SCHEMAS } from "./index";

interface Validator {
  safeParse(v: unknown): { success: boolean; error?: { issues: Array<{ message: string }> } };
}
const schemas = NATIVE_SCHEMAS as unknown as Record<string, Record<string, Validator>>;
const check = (plugin: string, target: string, v: unknown) => schemas[plugin]![target]!.safeParse(v);
const msgs = (r: ReturnType<typeof check>) => (r.error?.issues ?? []).map((i) => i.message).join(" | ");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("native plugin payload schemas", () => {
  it("every built-in example is valid", () => {
    for (const [p, targets] of Object.entries(NATIVE_EXAMPLES)) for (const [t, v] of Object.entries(targets)) expect(check(p, t, v).success, `${p}.${t}`).toBe(true);
  });

  it("every schema has an example", () => {
    for (const [p, targets] of Object.entries(NATIVE_SCHEMAS)) expect(Object.keys(NATIVE_EXAMPLES[p as keyof typeof NATIVE_EXAMPLES]).sort()).toEqual(Object.keys(targets).sort());
  });

  it("rejects non-epoch clocks (uptime millis, seconds, microseconds)", () => {
    const c = clone(NATIVE_EXAMPLES.detector.placementCandidate) as { t: number };
    for (const bad of [123_456_789, 1_789_800_000, 1_789_800_000_000_000]) {
      const r = check("detector", "placementCandidate", { ...c, t: bad });
      expect(r.success).toBe(false);
      expect(msgs(r)).toMatch(/epoch/);
    }
    expect(check("pose", "pose", { ...(NATIVE_EXAMPLES.pose.pose as object), t: 5000 }).success).toBe(false);
    expect(check("keys", "key", { t: 5000, keyCode: 24, action: "down" }).success).toBe(false);
  });

  it("keyframes: at most 6, at most 640 px wide, JPEG bytes present, no data: prefix", () => {
    const c = clone(NATIVE_EXAMPLES.detector.placementCandidate) as { frames: Array<Record<string, unknown>> };
    expect(check("detector", "placementCandidate", { ...c, frames: Array(7).fill(c.frames[0]) }).success).toBe(false);
    expect(msgs(check("detector", "placementCandidate", { ...c, frames: [{ ...c.frames[0]!, w: 1280, h: 720 }] }))).toMatch(/640/);
    expect(check("detector", "placementCandidate", { ...c, frames: [{ ...c.frames[0]!, jpegBase64: undefined }] }).success).toBe(false);
    expect(msgs(check("detector", "placementCandidate", { ...c, frames: [{ ...c.frames[0]!, jpegBase64: "data:image/jpeg;base64,AAAAAAAAAAAAAAAAAAAA" }] }))).toMatch(/data:/);
  });

  it("stills: <= 1920 px long edge and < ~1 MB", () => {
    const c = clone(NATIVE_EXAMPLES.detector.placementCandidate) as { stillFrame: Record<string, unknown> };
    expect(msgs(check("detector", "placementCandidate", { ...c, stillFrame: { ...c.stillFrame, w: 4000, h: 3000 } }))).toMatch(/1920/);
    expect(msgs(check("detector", "captureStill", { frame: { ...c.stillFrame, jpegBase64: "A".repeat(1_500_000) } }))).toMatch(/1 MB/);
    expect(check("detector", "captureStill", { frame: null }).success).toBe(true);
  });

  it("detections must align with the frames and be normalized", () => {
    const c = clone(NATIVE_EXAMPLES.detector.placementCandidate) as { detections: unknown[][] };
    expect(msgs(check("detector", "placementCandidate", { ...c, detections: [[]] }))).toMatch(/align/);
    expect(check("detector", "placementCandidate", { ...c, detections: [[], [], [{ label: "cup", score: 1.5, bbox: [0, 0, 1, 1] }]] }).success).toBe(false);
    expect(check("detector", "getFrames", { frames: [], detections: [[]] }).success).toBe(false);
  });

  it("only the detector trigger may come from native", () => {
    const c = clone(NATIVE_EXAMPLES.detector.placementCandidate) as object;
    expect(check("detector", "placementCandidate", { ...c, trigger: "voice" }).success).toBe(false);
  });

  it("head pose: yaw in [0, 360), pitch in [-90, 90]", () => {
    const h = NATIVE_EXAMPLES.headpose.headPose as Record<string, unknown>;
    expect(check("headpose", "headPose", { ...h, yawDeg: 360 }).success).toBe(false);
    expect(check("headpose", "headPose", { ...h, yawDeg: -5 }).success).toBe(false);
    expect(check("headpose", "headPose", { ...h, pitchDeg: 120 }).success).toBe(false);
    expect(check("headpose", "headPose", { ...h, source: "phone" }).success).toBe(false);
  });

  it("pose: confidence 0..1, stationary boolean required", () => {
    const p = NATIVE_EXAMPLES.pose.pose as Record<string, unknown>;
    expect(check("pose", "pose", { ...p, confidence: 1.2 }).success).toBe(false);
    expect(check("pose", "pose", { ...p, stationary: undefined }).success).toBe(false);
    expect(check("pose", "calibrateStepLength", { stepLengthM: 7 }).success).toBe(false);
  });

  it("key events", () => {
    expect(check("keys", "key", { t: 1_789_800_000_000, keyCode: 24, action: "held" }).success).toBe(false);
  });
});
