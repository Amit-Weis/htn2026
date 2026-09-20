import { describe, expect, it } from "vitest";
import {
  CONTRACT_VERSION,
  ClientMessageSchema,
  HeadPoseSchema,
  INITIAL_STATE,
  PlacementCandidateSchema,
  PlacementEventSchema,
  ServerMessageSchema,
  TrackerStateSchema,
  parseClientMessage,
} from "./index";

const NOW = 1_800_000_000_000;
const ctx = { nowMs: NOW, pose: INITIAL_STATE.pose, hfovDeg: 70 };
const pose = { t: NOW, x: 1, y: 2, headingDeg: 90, steps: 3, confidence: 1, stationary: true };
const frame = { t: NOW, w: 640, h: 480, hash: "abc", jpegBase64: "AAAA" };

describe("contract v2", () => {
  it("is version 2", () => expect(CONTRACT_VERSION).toBe(2));

  it("initial state satisfies the state schema", () => {
    expect(TrackerStateSchema.safeParse(INITIAL_STATE).success).toBe(true);
  });

  it("accepts a full placement_candidate", () => {
    const m = {
      type: "placement_candidate",
      t: NOW,
      trigger: "detector",
      frames: [frame, { ...frame, t: NOW + 500 }],
      stillFrame: { t: NOW, w: 4000, h: 3000, jpegBase64: "AAAA" },
      detections: [[{ label: "keys", score: 0.8, bbox: [0.4, 0.5, 0.2, 0.1] }], []],
      poseSlice: [pose],
      hfovDeg: 70,
    };
    expect(PlacementCandidateSchema.safeParse(m).success).toBe(true);
    expect(ClientMessageSchema.safeParse(m).success).toBe(true);
  });

  it("rejects out-of-range values and more than 8 frames", () => {
    const base = { type: "placement_candidate", t: NOW, trigger: "detector", frames: [frame], poseSlice: [], hfovDeg: 70 };
    expect(ClientMessageSchema.safeParse({ ...base, trigger: "motion" }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ ...base, frames: Array(9).fill(frame) }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ ...base, detections: [[{ label: "x", score: 2, bbox: [0, 0, 1, 1] }]] }).success).toBe(false);
  });

  it("utterance carries turnId and poseAtT; cancel exists", () => {
    const u = { type: "utterance", turnId: "t1", t: NOW, audioB64: "AAAA", mime: "audio/wav", poseAtT: pose };
    expect(ClientMessageSchema.safeParse(u).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ ...u, turnId: undefined }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: "cancel", turnId: "t1" }).success).toBe(true);
  });

  it("server messages: speak has turnId, pose_correction and notice exist", () => {
    expect(ServerMessageSchema.safeParse({ type: "speak", turnId: "t1", text: "hi" }).success).toBe(true);
    expect(ServerMessageSchema.safeParse({ type: "speak", text: "hi" }).success).toBe(false);
    expect(ServerMessageSchema.safeParse({ type: "pose_correction", dx: 0.2, dy: -0.1, dHeadingDeg: 3 }).success).toBe(true);
    expect(ServerMessageSchema.safeParse({ type: "notice", level: "warn", message: "x" }).success).toBe(true);
  });

  it("head_pose is a local-only type: the agent rejects it in both contracts", () => {
    const hp = { type: "head_pose", t: NOW, yawDeg: 10, pitchDeg: 0, source: "glasses" };
    expect(HeadPoseSchema.safeParse({ t: NOW, yawDeg: 10, pitchDeg: 0, source: "glasses" }).success).toBe(true);
    expect(ClientMessageSchema.safeParse(hp).success).toBe(false);
    expect(parseClientMessage(hp, ctx).ok).toBe(false);
  });

  it("placement events default detection_index to null (older producers)", () => {
    const e = PlacementEventSchema.parse({
      kind: "placed", label: "keys", description: "d", distinguishing_features: [], surface: "desk",
      zone_name: "desk", bbox: [0, 0, 1, 1], distance_m: null, holder: "wearer", confidence: 0.5,
    });
    expect(e.detection_index).toBeNull();
  });
});

describe("contract v1 compatibility", () => {
  it("v2 messages parse as version 2", () => {
    const r = parseClientMessage({ type: "hello", contractVersion: 2, role: "wearable" }, ctx);
    expect(r).toMatchObject({ ok: true, version: 2 });
  });

  it("a v1 hello parses as version 1 and upgrades to v2", () => {
    const r = parseClientMessage({ type: "hello", role: "dashboard" }, ctx);
    expect(r).toMatchObject({ ok: true, version: 1, msg: { type: "hello", contractVersion: 2, role: "dashboard" } });
  });

  it("v1 pose (ts) becomes a v2 pose with t and stationary", () => {
    const r = parseClientMessage({ type: "pose", x: 1, y: 2, headingDeg: 3, steps: 4, ts: NOW }, ctx);
    expect(r.ok && r.msg).toMatchObject({ type: "pose", t: NOW, stationary: true, confidence: 1 });
  });

  it("v1 placement becomes a placement_candidate (t = last frame ts, mapped trigger)", () => {
    const r = parseClientMessage(
      {
        type: "placement",
        trigger: "narration",
        frames: [{ b64: "AAAA", ts: NOW - 500 }, { b64: "BBBB", ts: NOW }],
        poseLog: [{ ts: NOW, x: 0, y: 0, headingDeg: 0 }],
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(PlacementCandidateSchema.safeParse(r.msg).success).toBe(true);
    expect(r.msg).toMatchObject({ type: "placement_candidate", t: NOW, trigger: "voice", hfovDeg: 70 });
  });

  it("v1 utterance gets a turnId and the agent's current pose", () => {
    const r = parseClientMessage({ type: "utterance", audioB64: "AAAA", mime: "audio/wav", frameB64: "BBBB" }, ctx);
    expect(r.ok && r.msg).toMatchObject({ type: "utterance", poseAtT: INITIAL_STATE.pose, frame: { jpegBase64: "BBBB" } });
    expect(r.ok && r.msg.type === "utterance" && r.msg.turnId.startsWith("v1-")).toBe(true);
  });

  it("v1 frame and stop_speaking map to frame_response and cancel", () => {
    expect(parseClientMessage({ type: "frame", requestId: "r", b64: null }, ctx)).toMatchObject({ ok: true, msg: { type: "frame_response", frame: null } });
    expect(parseClientMessage({ type: "stop_speaking" }, ctx)).toMatchObject({ ok: true, msg: { type: "cancel", turnId: "*" } });
  });

  it("garbage is rejected", () => {
    expect(parseClientMessage({ type: "nope" }, ctx).ok).toBe(false);
    expect(parseClientMessage(42, ctx).ok).toBe(false);
  });
});
