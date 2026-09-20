import { z } from "zod";
import { DetectionSchema, FrameSchema, PoseSchema } from "./schemas";

/**
 * Payload schemas for the native (Kotlin) Capacitor plugins. STRICTER than the wire contract: they also
 * enforce the clock rule and the frame-size limits, so a plugin that returns uptime-millis timestamps or
 * 4000 px keyframes fails validation here instead of silently misbehaving downstream.
 * Spec: docs/NATIVE_CONTRACT.md. Validate a plugin's JSON with `pnpm validate:native`.
 */

/** Epoch milliseconds between 2020 and 2100. `SystemClock.uptimeMillis()` (small numbers) and seconds fail. */
export const EpochMs = z.number().int().min(1_577_836_800_000, "not epoch ms (looks like uptime or seconds)").max(4_102_444_800_000, "not epoch ms (looks like microseconds)");

export const MAX_KEYFRAMES = 6;
export const KEYFRAME_MAX_WIDTH_PX = 640;
export const STILL_MAX_LONG_EDGE_PX = 1920;

/** A keyframe from the native ring buffer: image bytes are mandatory, width <= 640. */
export const KeyframeSchema = FrameSchema.extend({
  t: EpochMs,
  w: z.number().int().positive().max(KEYFRAME_MAX_WIDTH_PX, "keyframes are at most 640 px wide"),
  h: z.number().int().positive(),
  jpegBase64: z.string().min(16, "keyframes must carry jpegBase64").refine((s) => !s.startsWith("data:"), "base64 only, no data: prefix"),
});

export const StillSchema = FrameSchema.extend({
  t: EpochMs,
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  jpegBase64: z.string().min(16).max(1_400_000, "still must stay under ~1 MB (downscale to <= 1920 px)"),
}).refine((f) => Math.max(f.w, f.h) <= STILL_MAX_LONG_EDGE_PX, "still long edge must be <= 1920 px");

const AlignedDetections = (frames: unknown[] | undefined, dets: unknown[][] | undefined) => !dets || !frames || dets.length === frames.length;

export const PingResultSchema = z.object({ ok: z.literal(true), version: z.number().int().min(1) });

export const DetectorStatusSchema = z.object({
  running: z.boolean(),
  ready: z.boolean(),
  fps: z.number().nonnegative(),
  model: z.string().nullable(),
  ringFrames: z.number().int().nonnegative(),
  note: z.string().optional(),
});

export const GetFramesResultSchema = z
  .object({ frames: z.array(KeyframeSchema).max(MAX_KEYFRAMES), detections: z.array(z.array(DetectionSchema)).optional() })
  .refine((r) => AlignedDetections(r.frames, r.detections), "detections must align index-for-index with frames");

export const CaptureStillResultSchema = z.object({ frame: StillSchema.nullable() });

/** Event `placementCandidate` (native -> JS). */
export const NativePlacementCandidateSchema = z
  .object({
    t: EpochMs,
    trigger: z.literal("detector"),
    frames: z.array(KeyframeSchema).min(1).max(MAX_KEYFRAMES),
    stillFrame: StillSchema.optional(),
    detections: z.array(z.array(DetectionSchema)).optional(),
  })
  .refine((r) => AlignedDetections(r.frames, r.detections), "detections must align index-for-index with frames");

/** Event `detections` (debug only, never uploaded). */
export const NativeDetectionsEventSchema = z.object({ t: EpochMs, detections: z.array(DetectionSchema) });

/** Event `pose`. */
export const NativePoseSchema = PoseSchema.extend({ t: EpochMs });
export const GetPoseAtResultSchema = z.object({ pose: NativePoseSchema.nullable() });
export const StepLengthResultSchema = z.object({ stepLengthM: z.number().min(0.3).max(1.5) });
/** Event `putDown`. */
export const NativePutDownSchema = z.object({ t: EpochMs });

/** Event `headPose`. */
export const NativeHeadPoseSchema = z.object({
  t: EpochMs,
  yawDeg: z.number().min(0).lt(360),
  pitchDeg: z.number().min(-90).max(90),
  source: z.literal("glasses"),
});

/** Event `key`. */
export const NativeKeyEventSchema = z.object({ t: EpochMs, keyCode: z.number().int().nonnegative(), action: z.enum(["down", "up"]) });

/** What `pnpm validate:native <plugin> <target> <file>` understands. */
export const NATIVE_SCHEMAS = {
  detector: {
    ping: PingResultSchema,
    getStatus: DetectorStatusSchema,
    getFrames: GetFramesResultSchema,
    captureStill: CaptureStillResultSchema,
    placementCandidate: NativePlacementCandidateSchema,
    detections: NativeDetectionsEventSchema,
  },
  pose: {
    ping: PingResultSchema,
    pose: NativePoseSchema,
    putDown: NativePutDownSchema,
    getPoseAt: GetPoseAtResultSchema,
    calibrateStepLength: StepLengthResultSchema,
  },
  headpose: { ping: PingResultSchema, headPose: NativeHeadPoseSchema },
  keys: { ping: PingResultSchema, key: NativeKeyEventSchema },
} as const;

export type NativePlugin = keyof typeof NATIVE_SCHEMAS;
