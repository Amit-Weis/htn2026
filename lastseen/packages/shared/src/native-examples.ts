import type { NativePlugin } from "./native";

const T = 1_789_800_000_000; // a real epoch-ms timestamp (September 2026)
const JPEG = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsK"; // stand-in for real base64 JPEG bytes

const kf = (dt: number, hash: string) => ({ t: T + dt, w: 640, h: 480, hash, jpegBase64: JPEG });
const det = { label: "cup", score: 0.81, bbox: [0.42, 0.55, 0.12, 0.16] };

/** One valid sample per plugin payload. Used by `pnpm validate:native example ...` and by the tests. */
export const NATIVE_EXAMPLES: { [P in NativePlugin]: Record<string, unknown> } = {
  detector: {
    ping: { ok: true, version: 1 },
    getStatus: { running: true, ready: true, fps: 2, model: "efficientdet_lite0_int8", ringFrames: 12 },
    getFrames: { frames: [kf(-1000, "f0f0f0f0a5a5a5a5"), kf(0, "f0f0f0f0a5a5a5a7")], detections: [[], [det]] },
    captureStill: { frame: { t: T, w: 1920, h: 1080, jpegBase64: JPEG } },
    placementCandidate: {
      t: T,
      trigger: "detector",
      frames: [kf(-1500, "0f0f0f0f5a5a5a5a"), kf(-700, "0f0f0f0f5a5a5a5b"), kf(0, "3c3c3c3cc3c3c3c3")],
      stillFrame: { t: T, w: 1920, h: 1080, hash: "3c3c3c3cc3c3c3c3", jpegBase64: JPEG },
      detections: [[], [], [det]],
    },
    detections: { t: T, detections: [det] },
  },
  pose: {
    ping: { ok: true, version: 1 },
    pose: { t: T, x: 1.4, y: 3.5, headingDeg: 92.5, steps: 12, confidence: 0.93, stationary: false },
    putDown: { t: T },
    getPoseAt: { pose: { t: T, x: 1.4, y: 3.5, headingDeg: 92.5, steps: 12, confidence: 0.93, stationary: true } },
    calibrateStepLength: { stepLengthM: 0.72 },
  },
  headpose: {
    ping: { ok: true, version: 1 },
    headPose: { t: T, yawDeg: 212.4, pitchDeg: -6.1, source: "glasses" },
  },
  keys: {
    ping: { ok: true, version: 1 },
    key: { t: T, keyCode: 24, action: "down" },
  },
};
