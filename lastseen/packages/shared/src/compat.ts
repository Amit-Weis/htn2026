import { z } from "zod";
import { AgentStatusSchema, ClientMessageSchema } from "./schemas";
import type { ClientMessage, PlacementTrigger, Pose } from "./schemas";

/**
 * Contract v1 (M0-era) client messages, still accepted and upgraded to v2 on arrival.
 * v1 timestamps were also epoch ms, but under the names `ts`.
 */
const V1Frame = z.object({ b64: z.string(), ts: z.number() });
const V1Pose = z.object({ ts: z.number(), x: z.number(), y: z.number(), headingDeg: z.number() });

export const ClientMessageV1Schema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), role: z.enum(["wearable", "dashboard", "sim"]) }),
  z.object({
    type: z.literal("pose"),
    x: z.number(),
    y: z.number(),
    headingDeg: z.number(),
    steps: z.number().int().nonnegative(),
    confidence: z.number().min(0).max(1).optional(),
    ts: z.number(),
  }),
  z.object({ type: z.literal("status"), status: AgentStatusSchema }),
  z.object({ type: z.literal("query"), text: z.string().min(1).max(500) }),
  z.object({ type: z.literal("utterance"), audioB64: z.string(), mime: z.string(), frameB64: z.string().optional() }),
  z.object({
    type: z.literal("placement"),
    frames: z.array(V1Frame).min(1).max(8),
    poseLog: z.array(V1Pose).max(400),
    narrationAudioB64: z.string().optional(),
    narrationMime: z.string().optional(),
    trigger: z.enum(["motion", "narration", "force", "put_down", "sim"]),
  }),
  z.object({ type: z.literal("frame"), requestId: z.string(), b64: z.string().nullable() }),
  z.object({ type: z.literal("force_capture") }),
  z.object({ type: z.literal("forget"), target: z.string() }),
  z.object({ type: z.literal("stop_speaking") }),
  z.object({ type: z.literal("set_recording"), on: z.boolean() }),
  z.object({ type: z.literal("ledger_request") }),
]);
export type ClientMessageV1 = z.infer<typeof ClientMessageV1Schema>;

export interface UpgradeCtx {
  nowMs: number;
  /** the agent's current pose, used where v1 had no pose (utterances) */
  pose: Pose;
  hfovDeg: number;
}

const TRIGGER_V1: Record<string, PlacementTrigger> = {
  motion: "detector",
  narration: "voice",
  force: "manual",
  put_down: "put_down",
  sim: "manual",
};

/** v1 -> v2. Unknown values default to the permissive side (stationary: true = do not drop). */
export function upgradeV1(m: ClientMessageV1, ctx: UpgradeCtx): ClientMessage {
  switch (m.type) {
    case "hello":
      return { type: "hello", contractVersion: 2, role: m.role };
    case "pose":
      return {
        type: "pose",
        t: m.ts,
        x: m.x,
        y: m.y,
        headingDeg: m.headingDeg,
        steps: m.steps,
        confidence: m.confidence ?? 1,
        stationary: true,
      };
    case "utterance":
      return {
        type: "utterance",
        turnId: `v1-${ctx.nowMs}`,
        t: ctx.nowMs,
        audioB64: m.audioB64,
        mime: m.mime,
        frame: m.frameB64 ? { t: ctx.nowMs, w: 0, h: 0, jpegBase64: m.frameB64 } : undefined,
        poseAtT: ctx.pose,
      };
    case "placement": {
      const last = m.frames[m.frames.length - 1]!;
      return {
        type: "placement_candidate",
        t: last.ts,
        trigger: TRIGGER_V1[m.trigger] ?? "manual",
        frames: m.frames.map((f) => ({ t: f.ts, w: 0, h: 0, jpegBase64: f.b64 })),
        poseSlice: m.poseLog.map((p) => ({ t: p.ts, x: p.x, y: p.y, headingDeg: p.headingDeg, steps: 0, confidence: 1, stationary: true })),
        hfovDeg: ctx.hfovDeg,
        narrationAudioB64: m.narrationAudioB64,
        narrationMime: m.narrationMime,
      };
    }
    case "frame":
      return {
        type: "frame_response",
        requestId: m.requestId,
        frame: m.b64 ? { t: ctx.nowMs, w: 0, h: 0, jpegBase64: m.b64 } : null,
      };
    case "stop_speaking":
      return { type: "cancel", turnId: "*" };
    default:
      return m;
  }
}

export type ParsedClientMessage =
  | { ok: true; version: 1 | 2; msg: ClientMessage }
  | { ok: false; error: string };

/** Accept v2 first, then v1 (upgraded). */
export function parseClientMessage(raw: unknown, ctx: UpgradeCtx): ParsedClientMessage {
  const v2 = ClientMessageSchema.safeParse(raw);
  if (v2.success) return { ok: true, version: 2, msg: v2.data };
  const v1 = ClientMessageV1Schema.safeParse(raw);
  if (v1.success) return { ok: true, version: 1, msg: upgradeV1(v1.data, ctx) };
  return { ok: false, error: v2.error.issues[0]?.message ?? "invalid message" };
}
