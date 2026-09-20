import type { Frame, HeadPose, Pose, Target } from "@lastseen/shared";
import { describe, expect, it } from "vitest";
import { CandidateFilter, DEFAULT_FILTER, PoseRing } from "./candidateFilter";
import { ARROW_TAU_MS, computeHud, quantize45 } from "./hudModel";
import { DEFAULT_KEYMAP, KeyGestures } from "./keyGestures";
import { MockDetector, MockPose } from "./native/mock";
import { MotionGate, motionEnergy } from "./native/motionGate";
import { KEYCODE } from "./native/types";
import { DEFAULT_VAD, Vad } from "./voice/vad";
import { base64ToBytes, bytesToBase64, downsample, encodeWav } from "./voice/wav";

const T0 = 1_800_000_000_000;
const pose = (t: number, over: Partial<Pose> = {}): Pose => ({ t, x: 0, y: 0, headingDeg: 0, steps: 0, confidence: 1, stationary: true, ...over });
const frame = (t: number, over: Partial<Frame> = {}): Frame => ({ t, w: 640, h: 480, hash: `h${t}`, jpegBase64: "AAAA", ...over });

function ringWith(poses: Pose[]) {
  const r = new PoseRing();
  poses.forEach((p) => r.push(p));
  return r;
}
const series = (from: number, to: number, step: number, over: (t: number) => Partial<Pose>) => {
  const out: Pose[] = [];
  for (let t = from; t <= to; t += step) out.push(pose(t, over(t)));
  return out;
};

describe("CandidateFilter", () => {
  const raw = (t: number, over = {}) => ({ t, trigger: "detector" as const, frames: [frame(t - 500), frame(t)], ...over });

  it("drops a candidate when the wearer was walking in [t-1.5 s, t+0.5 s]", () => {
    const f = new CandidateFilter(ringWith(series(T0 - 4000, T0 + 500, 100, () => ({ stationary: false }))));
    expect(f.process(raw(T0))).toMatchObject({ ok: false, reason: "walking" });
    expect(f.drops.walking).toBe(1);
  });

  it("only looks at that window: walking earlier than 1.5 s before is fine", () => {
    const poses = series(T0 - 4000, T0 + 500, 100, (t) => ({ stationary: t > T0 - 1500 }));
    const f = new CandidateFilter(ringWith(poses));
    expect(f.process(raw(T0)).ok).toBe(true);
  });

  it("explicit triggers (voice, manual, put_down) ignore walking", () => {
    for (const trigger of ["voice", "manual", "put_down"] as const) {
      const f = new CandidateFilter(ringWith(series(T0 - 2000, T0 + 500, 100, () => ({ stationary: false }))));
      expect(f.process(raw(T0, { trigger })).ok).toBe(true);
    }
  });

  it("applies a 4 s cooldown by candidate time; a dropped candidate does not extend it", () => {
    const f = new CandidateFilter(ringWith(series(T0 - 2000, T0 + 9000, 100, () => ({}))));
    expect(f.process(raw(T0)).ok).toBe(true);
    expect(f.process(raw(T0 + 1000))).toMatchObject({ ok: false, reason: "cooldown" });
    expect(f.process(raw(T0 + 3999))).toMatchObject({ ok: false, reason: "cooldown" });
    expect(f.process(raw(T0 + 4000)).ok).toBe(true);
    expect(f.drops.cooldown).toBe(2);
  });

  it("attaches the pose slice and hfov, and caps at 6 frames keeping detections aligned", () => {
    const f = new CandidateFilter(ringWith(series(T0 - 6000, T0 + 500, 100, (t) => ({ x: (t - T0) / 1000 }))), { ...DEFAULT_FILTER, hfovDeg: 66 });
    const frames = Array.from({ length: 10 }, (_, i) => frame(T0 - 900 + i * 100, { hash: `f${i}` }));
    const detections = frames.map((_, i) => [{ label: `d${i}`, score: 0.9, bbox: [0, 0, 0.1, 0.1] as [number, number, number, number] }]);
    const r = f.process({ t: T0, trigger: "detector", frames, detections });
    if (!r.ok) throw new Error("expected accepted");
    expect(r.candidate.frames).toHaveLength(6);
    expect(r.candidate.hfovDeg).toBe(66);
    expect(r.candidate.detections).toHaveLength(6);
    r.candidate.frames.forEach((fr, i) => expect(r.candidate.detections![i]![0]!.label).toBe(`d${frames.indexOf(fr)}`));
    const ts = r.candidate.poseSlice.map((p) => p.t);
    expect(Math.min(...ts)).toBeGreaterThanOrEqual(T0 - 4000);
    expect(Math.max(...ts)).toBeLessThanOrEqual(T0 + 500);
  });

  it("drops candidates with no frame data", () => {
    const f = new CandidateFilter(new PoseRing());
    expect(f.process({ t: T0, trigger: "manual", frames: [{ t: T0, w: 1, h: 1 }] })).toMatchObject({ ok: false, reason: "no_frames" });
  });

  it("can be limited to a single frame (the newest)", () => {
    const f = new CandidateFilter(new PoseRing(), { ...DEFAULT_FILTER, maxFrames: 1 });
    const r = f.process({ t: T0, trigger: "manual", frames: [frame(T0 - 100), frame(T0)] });
    if (!r.ok) throw new Error("expected accepted");
    expect(r.candidate.frames.map((x) => x.t)).toEqual([T0]);
  });

  it("with no pose history yet it cannot call the wearer walking", () => {
    expect(new CandidateFilter(new PoseRing()).process(raw(T0)).ok).toBe(true);
  });
});

describe("HUD model", () => {
  const target = (over: Partial<Target> = {}): Target => ({
    objectId: "o1", label: "keys", x: 5, y: 0, bearingDeg: 90, zone: "desk", ageSec: 720, confidence: 0.9, thumbUrl: null, mode: "arrow", setAt: T0, ...over,
  });
  const input = (over: Record<string, unknown> = {}) => ({
    state: { target: target(), status: "idle" as const, lastReply: null },
    pose: pose(T0),
    headPose: null as HeadPose | null,
    headOffsetDeg: 0,
    nowMs: T0,
    prevAngleDeg: 0,
    dtMs: 1e9, // effectively no smoothing
    ...over,
  });

  it("points at the target using the chest heading", () => {
    const v = computeHud(input());
    expect(v).toMatchObject({ hasTarget: true, mode: "arrow", label: "keys", zone: "desk", usingHead: false });
    expect(v.angleDeg).toBeCloseTo(90, 5);
    expect(v.distance).toBe("5.0 m");
  });

  it("uses a fresh head pose, and falls back to the chest when it goes stale (>= 300 ms)", () => {
    const head = (t: number): HeadPose => ({ t, yawDeg: 90, pitchDeg: 0, source: "glasses" });
    expect(computeHud(input({ headPose: head(T0 - 100) })).angleDeg).toBeCloseTo(0, 5); // looking east at an east target
    expect(computeHud(input({ headPose: head(T0 - 100) })).usingHead).toBe(true);
    expect(computeHud(input({ headPose: head(T0 - 300) })).angleDeg).toBeCloseTo(90, 5);
    expect(computeHud(input({ headPose: head(T0 - 300) })).usingHead).toBe(false);
  });

  it("applies the head offset (recenter)", () => {
    const v = computeHud(input({ headPose: { t: T0, yawDeg: 80, pitchDeg: 0, source: "glasses" }, headOffsetDeg: 10 }));
    expect(v.angleDeg).toBeCloseTo(0, 5);
  });

  it("low-pass filters the arrow and converges", () => {
    let a = 0;
    const first = computeHud(input({ prevAngleDeg: a, dtMs: 50 }));
    expect(first.angleDeg).toBeGreaterThan(0);
    expect(first.angleDeg).toBeLessThan(90);
    a = first.angleDeg;
    for (let i = 0; i < 60; i++) a = computeHud(input({ prevAngleDeg: a, dtMs: 100 })).angleDeg;
    expect(a).toBeCloseTo(90, 0);
    expect(ARROW_TAU_MS).toBeLessThanOrEqual(150);
  });

  it("smooths through +/-180 the short way round", () => {
    // target directly behind (angle 180); previous displayed angle -175 must move toward -180, not through 0
    const behind = { target: target({ x: 0, y: -5 }), status: "idle" as const, lastReply: null };
    const v = computeHud(input({ state: behind, prevAngleDeg: -175, dtMs: 100 }));
    expect(Math.abs(v.angleDeg)).toBeGreaterThan(175);
  });

  it("zone mode snaps to 45-degree sectors", () => {
    expect(quantize45(30)).toBe(45);
    expect(quantize45(20)).toBe(0);
    expect(quantize45(-22)).toBe(0);
    expect(quantize45(-30)).toBe(-45);
    expect(quantize45(170)).toBe(180);
    const v = computeHud(input({ state: { target: target({ mode: "zone", x: 5, y: 1 }), status: "idle", lastReply: null } }));
    expect(v.mode).toBe("zone");
    expect(v.angleDeg % 45).toBeCloseTo(0, 5);
  });

  it("age keeps counting after the target was set", () => {
    expect(computeHud(input({ nowMs: T0 })).age).toBe("12 min ago");
    expect(computeHud(input({ nowMs: T0 + 30 * 60_000 })).age).toBe("42 min ago");
  });

  it("no target -> nothing to draw", () => {
    const v = computeHud(input({ state: { target: null, status: "listening", lastReply: null } }));
    expect(v).toMatchObject({ hasTarget: false, mode: "none", status: "listening" });
  });
});

describe("KeyGestures (hardware keys, not taps)", () => {
  it("volume up = query push-to-talk down/up; volume down = narration", () => {
    const g = new KeyGestures();
    expect(g.handle({ t: 0, keyCode: KEYCODE.VOLUME_UP, action: "down" })).toEqual([{ type: "ptt", action: "down", mode: "query" }]);
    expect(g.handle({ t: 500, keyCode: KEYCODE.VOLUME_UP, action: "up" })).toEqual([{ type: "ptt", action: "up", mode: "query" }]);
    expect(g.handle({ t: 900, keyCode: KEYCODE.VOLUME_DOWN, action: "down" })).toEqual([{ type: "ptt", action: "down", mode: "narrate" }]);
    expect(g.handle({ t: 1200, keyCode: KEYCODE.VOLUME_DOWN, action: "up" })).toEqual([{ type: "ptt", action: "up", mode: "narrate" }]);
  });
  it("Bluetooth clicker keys work too", () => {
    const g = new KeyGestures();
    for (const keyCode of [KEYCODE.HEADSETHOOK, KEYCODE.MEDIA_PLAY_PAUSE]) {
      expect(g.handle({ t: 0, keyCode, action: "down" })[0]).toMatchObject({ type: "ptt", mode: "query" });
      g.handle({ t: 10, keyCode, action: "up" });
    }
  });
  it("long-press on a recenter key recenters; a short press does nothing", () => {
    const g = new KeyGestures();
    g.handle({ t: 0, keyCode: KEYCODE.MEDIA_NEXT, action: "down" });
    expect(g.handle({ t: DEFAULT_KEYMAP.longPressMs + 1, keyCode: KEYCODE.MEDIA_NEXT, action: "up" })).toEqual([{ type: "recenter" }]);
    g.handle({ t: 5000, keyCode: KEYCODE.MEDIA_NEXT, action: "down" });
    expect(g.handle({ t: 5300, keyCode: KEYCODE.MEDIA_NEXT, action: "up" })).toEqual([]);
  });
  it("ignores auto-repeat, stray ups and unknown keys", () => {
    const g = new KeyGestures();
    expect(g.handle({ t: 0, keyCode: KEYCODE.VOLUME_UP, action: "down" })).toHaveLength(1);
    expect(g.handle({ t: 50, keyCode: KEYCODE.VOLUME_UP, action: "down" })).toEqual([]);
    expect(g.handle({ t: 0, keyCode: 999, action: "up" })).toEqual([]);
    expect(g.handle({ t: 0, keyCode: 999, action: "down" })).toEqual([]);
  });
});

describe("Vad", () => {
  const SR = DEFAULT_VAD.sampleRate;
  const tone = (ms: number, amp: number) => Float32Array.from({ length: Math.round((SR * ms) / 1000) }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / SR));
  const quiet = (ms: number) => new Float32Array(Math.round((SR * ms) / 1000));
  const cat = (...xs: Float32Array[]) => {
    const o = new Float32Array(xs.reduce((n, x) => n + x.length, 0));
    let p = 0;
    for (const x of xs) {
      o.set(x, p);
      p += x.length;
    }
    return o;
  };
  const run = (vad: Vad, pcm: Float32Array, chunk = 320) => {
    const ev: ReturnType<Vad["push"]> = [];
    for (let i = 0; i < pcm.length; i += chunk) ev.push(...vad.push(pcm.subarray(i, i + chunk)));
    return ev;
  };

  it("emits one utterance for speech followed by the hangover of silence", () => {
    const ev = run(new Vad(), cat(quiet(500), tone(800, 0.2), quiet(1200)));
    expect(ev.map((e) => e.type)).toEqual(["speech_start", "speech_end"]);
    const end = ev[1]!;
    if (end.type !== "speech_end") throw new Error("x");
    expect(end.reason).toBe("silence");
    // 800 ms speech + <=300 ms pre-roll + ~120 ms tail
    expect(end.durationMs).toBeGreaterThan(850);
    expect(end.durationMs).toBeLessThan(1400);
  });
  it("does not split on a short pause inside speech (hangover)", () => {
    const ev = run(new Vad(), cat(tone(500, 0.2), quiet(400), tone(500, 0.2), quiet(1200)));
    expect(ev.filter((e) => e.type === "speech_end")).toHaveLength(1);
  });
  it("discards a blip shorter than the minimum speech length", () => {
    const ev = run(new Vad(), cat(quiet(300), tone(100, 0.2), quiet(1200)));
    expect(ev.some((e) => e.type === "discard")).toBe(true);
    expect(ev.some((e) => e.type === "speech_end")).toBe(false);
  });
  it("ignores low-level noise", () => {
    expect(run(new Vad(), tone(3000, 0.005))).toEqual([]);
  });
  it("caps very long utterances", () => {
    const ev = run(new Vad({ ...DEFAULT_VAD, maxUtteranceMs: 2000 }), tone(5000, 0.2));
    const end = ev.find((e) => e.type === "speech_end");
    expect(end).toMatchObject({ type: "speech_end", reason: "max" });
  });
  it("gives the same result regardless of chunk size", () => {
    const pcm = cat(quiet(400), tone(700, 0.2), quiet(1200));
    const a = run(new Vad(), pcm, 100).map((e) => e.type);
    const b = run(new Vad(), pcm, 1600).map((e) => e.type);
    expect(a).toEqual(b);
  });
  it("push-to-talk records regardless of energy, and ends on release", () => {
    const vad = new Vad();
    expect(vad.startManual()).toEqual([{ type: "speech_start" }]);
    run(vad, quiet(1000));
    const end = vad.endManual();
    expect(end).toMatchObject({ type: "speech_end", reason: "manual" });
    if (end?.type === "speech_end") expect(end.durationMs).toBeGreaterThan(900);
    expect(vad.endManual()).toBeNull();
  });
});

describe("wav", () => {
  it("encodes a 16 kHz mono 16-bit WAV", () => {
    const pcm = Float32Array.from([0, 0.5, -0.5, 1, -1]);
    const wav = encodeWav(pcm, 16000);
    const dv = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
    expect(dv.getUint32(24, true)).toBe(16000);
    expect(dv.getUint16(22, true)).toBe(1);
    expect(dv.getUint16(34, true)).toBe(16);
    expect(dv.getUint32(40, true)).toBe(10);
    expect(dv.getInt16(44 + 6, true)).toBe(32767);
    expect(dv.getInt16(44 + 8, true)).toBe(-32768);
  });
  it("downsamples and round-trips base64", () => {
    expect(downsample(new Float32Array(48000), 48000, 16000)).toHaveLength(16000);
    const bytes = Uint8Array.from([0, 1, 2, 250, 255]);
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([0, 1, 2, 250, 255]);
  });
});

describe("MotionGate (browser fallback)", () => {
  it("fires once after activity then a settled scene", () => {
    const g = new MotionGate();
    const fired: number[] = [];
    const feed = (t: number, e: number) => g.push(e, t) && fired.push(t);
    for (let t = 0; t < 1500; t += 500) feed(t, 1);
    for (let t = 1500; t < 3000; t += 500) feed(t, 12); // hand puts the object down
    for (let t = 3000; t < 6000; t += 500) feed(t, 0.5); // settled
    expect(fired).toHaveLength(1);
    expect(fired[0]!).toBeGreaterThanOrEqual(3000 + 800);
  });
  it("does not fire without activity, or when activity never settles", () => {
    const g = new MotionGate();
    for (let t = 0; t < 10000; t += 500) expect(g.push(1, t)).toBe(false);
    for (let t = 0; t < 10000; t += 500) expect(g.push(12, t)).toBe(false);
  });
  it("ignores long continuous motion (camera swung around)", () => {
    const g = new MotionGate();
    for (let t = 0; t < 8000; t += 500) g.push(12, t);
    let fired = false;
    for (let t = 8000; t < 10000; t += 500) fired ||= g.push(0.5, t);
    expect(fired).toBe(false);
  });
  it("motionEnergy is the mean absolute difference", () => {
    expect(motionEnergy(Uint8Array.from([0, 10, 20]), Uint8Array.from([0, 10, 20]))).toBe(0);
    expect(motionEnergy(Uint8Array.from([0, 0]), Uint8Array.from([10, 30]))).toBe(20);
  });
});

describe("mock plugins", () => {
  it("MockDetector.getFrames returns at most 6 frames inside the time range, evenly spread", async () => {
    const d = new MockDetector();
    for (let i = 0; i < 20; i++) d.pushFrame(frame(T0 + i * 100), [{ label: `l${i}`, score: 1, bbox: [0, 0, 1, 1] }]);
    const r = await d.getFrames({ fromT: T0 + 500, toT: T0 + 1900, maxFrames: 6 });
    expect(r.frames).toHaveLength(6);
    expect(r.frames[0]!.t).toBe(T0 + 500);
    expect(r.frames.at(-1)!.t).toBe(T0 + 1900);
    expect(r.detections).toHaveLength(6);
    expect((await d.getFrames({ fromT: 0, toT: 1, maxFrames: 6 })).frames).toEqual([]);
    expect((await d.getFrames({ fromT: T0, toT: T0 + 5000, maxFrames: 99 })).frames.length).toBeLessThanOrEqual(6);
    // regression: maxFrames = 1 (request_frame, utterances) must return the NEWEST frame, not NaN-index nothing
    const one = await d.getFrames({ fromT: T0, toT: T0 + 5000, maxFrames: 1 });
    expect(one.frames).toHaveLength(1);
    expect(one.frames[0]!.t).toBe(T0 + 1900);
    expect(one.detections).toHaveLength(1);
  });
  it("MockPose answers getPoseAt by interpolation", async () => {
    const p = new MockPose();
    p.emitPose(pose(T0, { x: 0 }));
    p.emitPose(pose(T0 + 1000, { x: 2 }));
    expect((await p.getPoseAt({ t: T0 + 500 }))!.x).toBeCloseTo(1);
    expect(await new MockPose().getPoseAt({ t: 1 })).toBeNull();
  });
});
