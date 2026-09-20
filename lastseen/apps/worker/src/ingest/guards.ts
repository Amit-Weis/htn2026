import { WALK_EXEMPT_TRIGGERS, movingFraction } from "@lastseen/shared";
import type { PlacementCandidate } from "@lastseen/shared";

export interface GuardConfig {
  /** minimum gap between accepted candidates, by candidate timestamp (epoch ms) */
  cooldownMs: number;
  /** OMNI vision calls per rolling minute, by server wall clock */
  maxOmniPerMin: number;
  /** how many recent frame hashes to compare against */
  hashWindow: number;
  /** drop when more than this fraction of the pose slice is non-stationary */
  walkFraction: number;
}

export const DEFAULT_GUARDS: GuardConfig = { cooldownMs: 4000, maxOmniPerMin: 6, hashWindow: 10, walkFraction: 0.5 };

export interface GuardState {
  lastAcceptedT: number | null;
  hashes: string[];
  /** server epoch-ms timestamps of recent OMNI vision calls */
  omniCalls: number[];
}

export const EMPTY_GUARD: GuardState = { lastAcceptedT: null, hashes: [], omniCalls: [] };

export type DropReason = "no_image" | "walking" | "duplicate" | "cooldown" | "rate_limit";

export type GuardResult =
  | { ok: true; next: GuardState; hash: string | null }
  | { ok: false; reason: DropReason; detail: string };

function fnv(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 97) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Phone-supplied hash of the still/last frame, else a cheap content hash. */
export function candidateHash(c: Pick<PlacementCandidate, "frames" | "stillFrame">): string | null {
  const f = c.stillFrame ?? c.frames[c.frames.length - 1];
  if (!f) return null;
  if (f.hash) return f.hash;
  return f.jpegBase64 ? `c:${fnv(f.jpegBase64)}` : null;
}

const HEX = /^[0-9a-f]+$/i;

/** Exact match, or (for same-length hex perceptual hashes) Hamming distance <= 4 bits. */
export function hashesMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length !== b.length || a.length > 32 || !HEX.test(a) || !HEX.test(b)) return false;
  let bits = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (x) {
      bits += x & 1;
      x >>= 1;
    }
  }
  return bits <= 4;
}

const recentCalls = (s: GuardState, nowMs: number) => s.omniCalls.filter((t) => nowMs - t < 60_000);

/** Records one OMNI vision call (also prunes anything older than a minute). */
export function recordOmniCall(s: GuardState, nowMs: number): GuardState {
  return { ...s, omniCalls: [...recentCalls(s, nowMs), nowMs] };
}

export function omniCallsLeft(s: GuardState, nowMs: number, cfg: GuardConfig): number {
  return Math.max(0, cfg.maxOmniPerMin - recentCalls(s, nowMs).length);
}

/** Guards run cheapest first. Nothing here calls OMNI. */
export function evaluateCandidate(c: PlacementCandidate, s: GuardState, cfg: GuardConfig, nowMs: number): GuardResult {
  if (!c.frames.some((f) => f.jpegBase64)) return { ok: false, reason: "no_image", detail: "no frame carries jpegBase64" };

  if (!WALK_EXEMPT_TRIGGERS.includes(c.trigger)) {
    const moving = movingFraction(c.poseSlice);
    if (moving > cfg.walkFraction) {
      return { ok: false, reason: "walking", detail: `${Math.round(moving * 100)}% of the pose slice was non-stationary` };
    }
  }

  const hash = candidateHash(c);
  if (hash && s.hashes.some((h) => hashesMatch(h, hash))) return { ok: false, reason: "duplicate", detail: `frame hash ${hash} seen in the last ${cfg.hashWindow}` };

  if (s.lastAcceptedT !== null && Math.abs(c.t - s.lastAcceptedT) < cfg.cooldownMs) {
    return { ok: false, reason: "cooldown", detail: `${Math.abs(c.t - s.lastAcceptedT)} ms since the last accepted candidate (< ${cfg.cooldownMs})` };
  }

  if (omniCallsLeft(s, nowMs, cfg) < 1) return { ok: false, reason: "rate_limit", detail: `${cfg.maxOmniPerMin} OMNI vision calls already used this minute` };

  return {
    ok: true,
    hash,
    next: { ...s, lastAcceptedT: c.t, hashes: hash ? [...s.hashes, hash].slice(-cfg.hashWindow) : s.hashes },
  };
}
