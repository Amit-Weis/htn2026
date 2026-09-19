import { z } from "zod";

// ---------- Agent state (synced to every connected client via setState) ----------

export const AgentStatusSchema = z.enum(["idle", "listening", "thinking", "speaking"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const PoseSchema = z.object({
  x: z.number(),
  y: z.number(),
  /** azimuth (deg clockwise from north) of camera-forward */
  headingDeg: z.number(),
  steps: z.number().int().nonnegative(),
  /** 0..1, decays with steps/time since last anchor */
  confidence: z.number().min(0).max(1),
  updatedAt: z.number(),
});
export type Pose = z.infer<typeof PoseSchema>;

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
  /** epoch ms when the target was set; client adds (now - setAt) to ageSec */
  setAt: z.number(),
});
export type Target = z.infer<typeof TargetSchema>;

export const TrackerStateSchema = z.object({
  pose: PoseSchema,
  target: TargetSchema.nullable(),
  status: AgentStatusSchema,
  /** last thing the agent said, for the HUD / dashboard */
  lastReply: z.string().nullable(),
  budget: z.object({ spentCad: z.number(), capCad: z.number() }),
  recording: z.boolean(),
});
export type TrackerState = z.infer<typeof TrackerStateSchema>;

export const INITIAL_STATE: TrackerState = {
  pose: { x: 0, y: 0, headingDeg: 0, steps: 0, confidence: 1, updatedAt: 0 },
  target: null,
  status: "idle",
  lastReply: null,
  budget: { spentCad: 0, capCad: 30 },
  recording: false,
};

// ---------- OMNI adapter contract ----------

export const PlacementEventSchema = z.object({
  kind: z.enum(["placed", "picked_up"]),
  label: z.string(),
  description: z.string(),
  distinguishing_features: z.array(z.string()),
  surface: z.string(),
  zone_name: z.string(),
  /** [x, y, w, h] normalized 0..1 in the final frame */
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  distance_m: z.number().nullable(),
  holder: z.enum(["wearer", "other", "unknown"]),
  confidence: z.number().min(0).max(1),
});
export type PlacementEvent = z.infer<typeof PlacementEventSchema>;

export const PlacementResultSchema = z.object({ events: z.array(PlacementEventSchema) });
export type PlacementResult = z.infer<typeof PlacementResultSchema>;

export const ToolNameSchema = z.enum([
  "find_object",
  "guide_to",
  "verify_visible",
  "list_recent",
  "mark_moved",
  "forget",
  "clarify",
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
  /** [x, y, w, h] normalized */
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
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
  lastSeenAt: z.number(),
  confidence: z.number(),
  thumbUrl: z.string().nullable(),
});
export type ObjectRow = z.infer<typeof ObjectRowSchema>;

export const TraceSchema = z.object({
  id: z.string(),
  ts: z.number(),
  utteranceId: z.string(),
  step: z.number().int(),
  kind: z.enum(["omni", "tool", "final", "ingest", "system"]),
  tool: z.string().nullable(),
  args: z.unknown(),
  result: z.unknown(),
  latencyMs: z.number().nullable(),
  costCad: z.number(),
});
export type Trace = z.infer<typeof TraceSchema>;

// ---------- Wire protocol ----------

const FrameSchema = z.object({ b64: z.string(), ts: z.number() });
const PoseSampleSchema = z.object({ ts: z.number(), x: z.number(), y: z.number(), headingDeg: z.number() });

/** client -> agent */
export const ClientMessageSchema = z.discriminatedUnion("type", [
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
  /** typed query (dashboard) */
  z.object({ type: z.literal("query"), text: z.string().min(1).max(500) }),
  /** spoken query: audio + latest frame */
  z.object({
    type: z.literal("utterance"),
    audioB64: z.string(),
    mime: z.string(),
    frameB64: z.string().optional(),
  }),
  /** placement candidate: keyframes spanning before/during/after + pose log slice */
  z.object({
    type: z.literal("placement"),
    frames: z.array(FrameSchema).min(1).max(8),
    poseLog: z.array(PoseSampleSchema).max(400),
    narrationAudioB64: z.string().optional(),
    narrationMime: z.string().optional(),
    trigger: z.enum(["motion", "narration", "force", "put_down", "sim"]),
  }),
  /** reply to request_frame */
  z.object({ type: z.literal("frame"), requestId: z.string(), b64: z.string().nullable() }),
  z.object({ type: z.literal("force_capture") }),
  z.object({ type: z.literal("forget"), target: z.string() }),
  z.object({ type: z.literal("stop_speaking") }),
  z.object({ type: z.literal("set_recording"), on: z.boolean() }),
  z.object({ type: z.literal("ledger_request") }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/** agent -> client (state itself travels through the SDK's cf_agent_state sync) */
export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("trace"), trace: TraceSchema }),
  z.object({
    type: z.literal("reply"),
    text: z.string(),
    audioB64: z.string().optional(),
    mime: z.string().optional(),
  }),
  z.object({ type: z.literal("request_frame"), requestId: z.string() }),
  z.object({ type: z.literal("capture_now") }),
  z.object({ type: z.literal("ledger"), objects: z.array(ObjectRowSchema) }),
  z.object({ type: z.literal("stop_audio") }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export const AGENT_CLASS_NAME = "tracker-agent";
