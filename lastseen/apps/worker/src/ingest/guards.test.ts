import { describe, expect, it } from "vitest";
import { T0, candidate, hx, pose, stillPoses } from "../testing/fixtures";
import { DEFAULT_GUARDS, EMPTY_GUARD, candidateHash, evaluateCandidate, hashesMatch, omniCallsLeft, recordOmniCall } from "./guards";

const cfg = DEFAULT_GUARDS;
const NOW = T0 + 10_000;
const walking = (t: number) => Array.from({ length: 10 }, (_, i) => pose(t - i * 100, { stationary: i < 2 })); // 80% moving

describe("guard defaults", () => {
  it("cooldown 4 s, 6 OMNI calls/min, last 10 hashes", () => {
    expect(cfg.cooldownMs).toBe(4000);
    expect(cfg.maxOmniPerMin).toBe(6);
    expect(cfg.hashWindow).toBe(10);
  });
});

describe("walking guard", () => {
  it("drops a detector candidate captured while walking", () => {
    const r = evaluateCandidate(candidate({ poseSlice: walking(T0) }), EMPTY_GUARD, cfg, NOW);
    expect(r).toMatchObject({ ok: false, reason: "walking" });
  });
  it("keeps a mostly stationary slice, and an empty slice", () => {
    expect(evaluateCandidate(candidate({ poseSlice: stillPoses(T0) }), EMPTY_GUARD, cfg, NOW).ok).toBe(true);
    expect(evaluateCandidate(candidate({ poseSlice: [] }), EMPTY_GUARD, cfg, NOW).ok).toBe(true);
  });
  it("does not drop voice, manual or put_down triggers for walking", () => {
    for (const trigger of ["voice", "manual", "put_down"] as const) {
      expect(evaluateCandidate(candidate({ trigger, poseSlice: walking(T0) }), EMPTY_GUARD, cfg, NOW).ok).toBe(true);
    }
  });
  it("50% moving is kept, just over 50% is dropped", () => {
    const half = Array.from({ length: 10 }, (_, i) => pose(T0 + i, { stationary: i % 2 === 0 }));
    expect(evaluateCandidate(candidate({ poseSlice: half }), EMPTY_GUARD, cfg, NOW).ok).toBe(true);
    const more = Array.from({ length: 10 }, (_, i) => pose(T0 + i, { stationary: i < 4 }));
    expect(evaluateCandidate(candidate({ poseSlice: more }), EMPTY_GUARD, cfg, NOW)).toMatchObject({ reason: "walking" });
  });
});

describe("dedupe by frame hash", () => {
  it("drops a repeat of the same hash, and remembers only the last 10", () => {
    let s = EMPTY_GUARD;
    const first = evaluateCandidate(candidate({ hash: "aaaa5555", t: T0 }), s, cfg, NOW);
    expect(first.ok).toBe(true);
    if (first.ok) s = first.next;
    // 5 s later (past cooldown) but identical frame
    expect(evaluateCandidate(candidate({ hash: "aaaa5555", t: T0 + 5000 }), s, cfg, NOW)).toMatchObject({ ok: false, reason: "duplicate" });

    // push 10 different hashes through; the first falls out of the window
    for (let i = 0; i < 10; i++) {
      const r = evaluateCandidate(candidate({ hash: hx(i), t: T0 + 10_000 * (i + 1) }), s, { ...cfg, maxOmniPerMin: 99 }, NOW);
      expect(r.ok).toBe(true);
      if (r.ok) s = r.next;
    }
    expect(s.hashes).toHaveLength(10);
    expect(evaluateCandidate(candidate({ hash: "aaaa5555", t: T0 + 200_000 }), s, { ...cfg, maxOmniPerMin: 99 }, NOW).ok).toBe(true);
  });
  it("treats near-identical perceptual hashes (<= 4 bits) as duplicates", () => {
    expect(hashesMatch("ffff0000ffff0000", "ffff0000ffff0001")).toBe(true);
    expect(hashesMatch("ffff0000ffff0000", "ffff0000ffff00ff")).toBe(false);
    expect(hashesMatch("c:1234abcd", "c:1234abce")).toBe(false); // not hex: exact match only
    expect(hashesMatch("abc", "abd")).toBe(true); // 1 bit apart
  });
  it("falls back to a content hash when the phone sent none", () => {
    const c = candidate();
    const noHash = { ...c, frames: c.frames.map((f) => ({ ...f, hash: undefined })) };
    expect(candidateHash(noHash)).toMatch(/^c:[0-9a-f]{8}$/);
    expect(candidateHash(noHash)).toBe(candidateHash(noHash));
  });
});

describe("cooldown", () => {
  it("drops a candidate within 4 s of the last accepted one (by candidate time), accepts after", () => {
    const a = evaluateCandidate(candidate({ t: T0 }), EMPTY_GUARD, cfg, NOW);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(evaluateCandidate(candidate({ t: T0 + 3999 }), a.next, cfg, NOW)).toMatchObject({ ok: false, reason: "cooldown" });
    expect(evaluateCandidate(candidate({ t: T0 + 4000 }), a.next, cfg, NOW).ok).toBe(true);
  });
  it("a dropped candidate does not extend the cooldown", () => {
    const a = evaluateCandidate(candidate({ t: T0 }), EMPTY_GUARD, cfg, NOW);
    if (!a.ok) throw new Error("setup");
    evaluateCandidate(candidate({ t: T0 + 3000 }), a.next, cfg, NOW); // dropped
    expect(evaluateCandidate(candidate({ t: T0 + 4000 }), a.next, cfg, NOW).ok).toBe(true);
  });
});

describe("OMNI rate limit", () => {
  it("allows 6 calls in a rolling minute, then drops, then recovers", () => {
    let s = EMPTY_GUARD;
    for (let i = 0; i < 6; i++) s = recordOmniCall(s, NOW + i * 1000);
    expect(omniCallsLeft(s, NOW + 10_000, cfg)).toBe(0);
    expect(evaluateCandidate(candidate({ t: T0 + 60_000 }), s, cfg, NOW + 10_000)).toMatchObject({ ok: false, reason: "rate_limit" });
    expect(omniCallsLeft(s, NOW + 61_000, cfg)).toBe(2); // the calls at +0 s and +1 s aged out (>= 60 s old)
    expect(evaluateCandidate(candidate({ t: T0 + 60_000 }), s, cfg, NOW + 61_000).ok).toBe(true);
  });
  it("recordOmniCall prunes calls older than a minute", () => {
    let s = recordOmniCall(EMPTY_GUARD, NOW);
    s = recordOmniCall(s, NOW + 90_000);
    expect(s.omniCalls).toEqual([NOW + 90_000]);
  });
});

describe("misc", () => {
  it("drops candidates with no image bytes", () => {
    const c = candidate();
    const bare = { ...c, frames: c.frames.map((f) => ({ ...f, jpegBase64: undefined, uri: "file:///x.jpg" })) };
    expect(evaluateCandidate(bare, EMPTY_GUARD, cfg, NOW)).toMatchObject({ ok: false, reason: "no_image" });
  });
  it("checks cheapest guards first: walking wins over duplicate", () => {
    const s = { ...EMPTY_GUARD, hashes: ["h-dup"] };
    const r = evaluateCandidate(candidate({ hash: "h-dup", poseSlice: walking(T0) }), s, cfg, NOW);
    expect(r).toMatchObject({ reason: "walking" });
  });
});
