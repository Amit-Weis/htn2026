import { z } from "zod";

/**
 * Lastseen wire contract, version 2.
 *
 * CLOCK RULE: every timestamp in this contract (`t`, `ts`, `setAt`, `lastSeenAt`, ...) is
 * EPOCH MILLISECONDS from the phone's wall clock: `Date.now()` in JS, `System.currentTimeMillis()`
 * in Kotlin. Never monotonic/uptime clocks, never seconds. Durations are named `...Ms` / `...Sec`.
 *
 * Coordinates: local frame in meters, x east, y north. Headings: degrees clockwise from north.
 * Bounding boxes: [x, y, w, h] normalized 0..1 with the origin at the top-left of the frame.
 */
export const CONTRACT_VERSION = 2 as const;

const Ms = z.number().describe("epoch milliseconds");
const Box = z.tuple([z.number(), z.number(), z.number(), z.number()]);

// ---------- Agent state (synced to every connected client via setState) ----------

export const AgentStatusSchema = z.enum(["idle", "listening", "thinking", "speaking"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/** Pose of the wearer's chest-mounted phone (or of the head when it is a HeadPose consumer). */
export const PoseSchema = z.object({
  t: Ms,
  x: z.number(),
  y: z.number(),
  /** azimuth (deg clockwise from north) of camera-forward */
  headingDeg: z.number(),
  steps: z.number().int().nonnegative(),
  /** 0..1, decays with steps/time since last anchor */
  confidence: z.number().min(0).max(1),
  /** true when the wearer is standing still (native step detector) */
  stationary: z.boolean(),
});
export type Pose = z.infer<typeof PoseSchema>;

export const FrameSchema = z.object({
  t: Ms,
  w: z.number().int().nonnegative(),
  h: z.number().int().nonnegative(),
  /** perceptual/content hash computed on the phone; used for de-duplication */
  hash: z.string().optional(),
  jpegBase64: z.string().optional(),
  /** native file URI, only meaningful on the phone */
  uri: z.string().optional(),
});
export type Frame = z.infer<typeof FrameSchema>;

export const DetectionSchema = z.object({
  label: z.string(),
  score: z.number().min(0).max(1),
  bbox: Box,
});
export type Detection = z.infer<typeof DetectionSchema>;

/** Glasses head orientation. LOCAL to the phone: never sent to the agent. */
export const HeadPoseSchema = z.object({
  t: Ms,
  yawDeg: z.number(),
  pitchDeg: z.number(),
  source: z.literal("glasses"),
});
export type HeadPose = z.infer<typeof HeadPoseSchema>;

export const TargetModeSchema = z.enum(["arrow", "zone"]);

export const TargetSchema = z.object({
  objectId: z.string(),
  label: z.string(),
  x: z.number(),
  y: z.number(),
  /** azimuth from the wearer's pose at the time the target was set */
  bearingDeg: z.number(),
  zone: z.string().nullable(),
  /** age of the last sighting at the time the target was set */
  ageSec: z.number(),
  confidence: z.number().min(0).max(1),
  thumbUrl: z.string().nullable(),
  mode: TargetModeSchema,
  /** when the target was set; client adds (now - setAt) to ageSec */
  setAt: Ms,
});
export type Target = z.infer<typeof TargetSchema>;

export const IngestStatsSchema = z.object({
  accepted: z.number().int(),
  dropped: z.number().int(),
  /** drop reason -> count */
  reasons: z.record(z.string(), z.number().int()),
});
export type IngestStats = z.infer<typeof IngestStatsSchema>;

export const TrackerStateSchema = z.object({
  pose: PoseSchema,
  target: TargetSchema.nullable(),
  status: AgentStatusSchema,
  /** last thing the agent said, for the HUD / dashboard */
  lastReply: z.string().nullable(),
  budget: z.object({ spentCad: z.number(), capCad: z.number() }),
  recording: z.boolean(),
  ingest: IngestStatsSchema,
});
export type TrackerState = z.infer<typeof TrackerStateSchema>;

export const INITIAL_STATE: TrackerState = {
  pose: { t: 0, x: 0, y: 0, headingDeg: 0, steps: 0, confidence: 1, stationary: true },
  target: null,
  status: "idle",
  lastReply: null,
  budget: { spentCad: 0, capCad: 30 },
  recording: false,
  ingest: { accepted: 0, dropped: 0, reasons: {} },
};

// ---------- OMNI adapter contract ----------

export const PlacementEventSchema = z.object({
  kind: z.enum(["placed", "picked_up"]),
  label: z.string(),
  description: z.string(),
  distinguishing_features: z.array(z.string()),
  surface: z.string(),
  zone_name: z.string(),
  /** [x, y, w, h] normalized 0..1 in the final frame (OMNI's own box; used when no detection is chosen) */
  bbox: Box,
  /**
   * Index into the detector boxes of the final frame that OMNI identified as the newly placed
   * object, or null when none fits / no detections were provided.
   */
  detection_index: z.number().int().nonnegative().nullable().default(null),
  distance_m: z.number().nullable(),
  holder: z.enum(["wearer", "other", "unknown"]),
  confidence: z.number().min(0).max(1),
});
export type PlacementEvent = z.infer<typeof PlacementEventSchema>;

export const PlacementResultSchema = z.object({ events: z.array(PlacementEventSchema) });
export type PlacementResult = z.infer<typeof PlacementResultSchema>;

export const CropDescriptionSchema = z.object({
  label: z.string(),
  description: z.string(),
  distinguishing_features: z.array(z.string()),
});
export type CropDescription = z.infer<typeof CropDescriptionSchema>;

export const ToolNameSchema = z.enum([
  "find_object",
  "guide_to",
  "verify_visible",
  "list_recent",
  "mark_moved",
  "forget",
  "clarify",
  "recenter",
]);
export type ToolName = z.infer<typeof ToolNameSchema>;

/** Strict JSON step protocol: OMNI returns either a tool call or a final answer. */
export const AgentStepSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool"),
    addressed: z.boolean(),
    transcript: z.string().optional(),
    tool: ToolNameSchema,
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("final"),
    addressed: z.boolean(),
    transcript: z.string().optional(),
    text: z.string(),
  }),
]);
export type AgentStep = z.infer<typeof AgentStepSchema>;

export const VerifyResultSchema = z.object({
  visible: z.boolean(),
  bbox: Box.optional(),
  distance_m: z.number().nullable().optional(),
  note: z.string(),
});
export type VerifyResult = z.infer<typeof VerifyResultSchema>;

// ---------- Ledger rows (what the dashboard renders) ----------

export const ObjectStatusSchema = z.enum(["placed", "held", "moved", "forgotten"]);

export const ObjectRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  features: z.array(z.string()),
  status: ObjectStatusSchema,
  x: z.number().nullable(),
  y: z.number().nullable(),
  zone: z.string().nullable(),
  lastSeenAt: Ms,
  confidence: z.number(),
  /** path under /api/frames/<device>/<id> (append ?token=...); null if no frame was kept */
  thumbUrl: z.string().nullable(),
  /** box of the object in the thumbnail, normalized; drawn on the dashboard */
  box: Box.nullable(),
  boxSource: z.enum(["detector", "omni", "none"]),
});
export type ObjectRow = z.infer<typeof ObjectRowSchema>;

export const TraceSchema = z.object({
  id: z.string(),
  ts: Ms,
  turnId: z.string(),
  step: z.number().int(),
  kind: z.enum(["omni", "tool", "final", "ingest", "system"]),
  tool: z.string().nullable(),
  args: z.unknown(),
  result: z.unknown(),
  latencyMs: z.number().nullable(),
  costCad: z.number(),
});
export type Trace = z.infer<typeof TraceSchema>;

// ---------- Wire protocol v2 ----------

export const PlacementTriggerSchema = z.enum(["detector", "voice", "manual", "put_down"]);
export type PlacementTrigger = z.infer<typeof PlacementTriggerSchema>;

/** Explicit wearer intent: these triggers are never dropped for "walking" (phone filter and backend guard agree). */
export const WALK_EXEMPT_TRIGGERS: readonly PlacementTrigger[] = ["voice", "manual", "put_down"];

/** phone -> agent: something may have been put down. At most 6 keyframes (640 px wide JPEG). */
export const PlacementCandidateSchema = z.object({
  type: z.literal("placement_candidate"),
  t: Ms,
  trigger: PlacementTriggerSchema,
  frames: z.array(FrameSchema).min(1).max(8),
  /** optional full-resolution still, used for cropping the chosen object */
  stillFrame: FrameSchema.optional(),
  /** detector output aligned index-for-index with `frames` */
  detections: z.array(z.array(DetectionSchema)).optional(),
  poseSlice: z.array(PoseSchema).max(600),
  hfovDeg: z.number().min(10).max(180),
  /** wearer narration for voice triggers ("putting my keys here") */
  narrationAudioB64: z.string().optional(),
  narrationMime: z.string().optional(),
});
export type PlacementCandidate = z.infer<typeof PlacementCandidateSchema>;

/** client -> agent (v2) */
export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    contractVersion: z.literal(2),
    role: z.enum(["wearable", "dashboard", "sim"]),
  }),
  z.object({ type: z.literal("pose") }).extend(PoseSchema.shape),
  z.object({ type: z.literal("status"), status: AgentStatusSchema }),
  /** typed query (dashboard / sim) */
  z.object({ type: z.literal("query"), turnId: z.string().optional(), text: z.string().min(1).max(500) }),
  /** spoken query: audio + latest frame + the pose when speech started */
  z.object({
    type: z.literal("utterance"),
    turnId: z.string().min(1),
    t: Ms,
    audioB64: z.string(),
    mime: z.string(),
    frame: FrameSchema.optional(),
    poseAtT: PoseSchema,
  }),
  /** barge-in / abort: stop working on this turn (`"*"` = every turn) */
  z.object({ type: z.literal("cancel"), turnId: z.string() }),
  PlacementCandidateSchema,
  /** reply to request_frame */
  z.object({ type: z.literal("frame_response"), requestId: z.string(), frame: FrameSchema.nullable() }),
  z.object({ type: z.literal("force_capture") }),
  /** dashboard remote push-to-talk: relayed to the wearable as remote_ptt */
  z.object({ type: z.literal("remote_ptt"), action: z.enum(["down", "up"]) }),
  z.object({ type: z.literal("forget"), target: z.string() }),
  z.object({ type: z.literal("set_recording"), on: z.boolean() }),
  z.object({ type: z.literal("ledger_request") }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/** agent -> client (v2). State itself travels through the SDK's cf_agent_state sync. */
export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("trace"), trace: TraceSchema }),
  z.object({
    type: z.literal("speak"),
    turnId: z.string(),
    text: z.string(),
    audioB64: z.string().optional(),
    mime: z.string().optional(),
  }),
  z.object({ type: z.literal("notice"), level: z.enum(["info", "warn", "error"]), message: z.string() }),
  z.object({ type: z.literal("request_frame"), requestId: z.string() }),
  z.object({ type: z.literal("capture_now") }),
  z.object({ type: z.literal("remote_ptt"), action: z.enum(["down", "up"]) }),
  /** zone anchor snap: shift the phone's dead-reckoned pose */
  z.object({ type: z.literal("pose_correction"), dx: z.number(), dy: z.number(), dHeadingDeg: z.number() }),
  /** agent tool `recenter`: recompute the head offset from the current chest heading */
  z.object({ type: z.literal("recenter") }),
  z.object({ type: z.literal("ledger"), objects: z.array(ObjectRowSchema) }),
  z.object({ type: z.literal("stop_audio") }),
  /** v1 only (deprecated): sent instead of `speak` to v1 connections */
  z.object({ type: z.literal("reply"), text: z.string(), audioB64: z.string().optional(), mime: z.string().optional() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export const AGENT_CLASS_NAME = "tracker-agent";
