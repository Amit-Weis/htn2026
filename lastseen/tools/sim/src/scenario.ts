import { z } from "zod";

const Box = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const Det = z.object({ label: z.string(), score: z.number().min(0).max(1).default(0.9), bbox: Box });

/**
 * A scenario is a list of wearer-side operations played through the REAL phone-side code (mock native
 * plugins -> CandidateFilter -> Bridge) and over the real WebSocket to the agent, on a virtual clock.
 */
export const OpSchema = z.discriminatedUnion("op", [
  /** stand at a pose, emitting stationary poses for holdMs (virtual) */
  z.object({ op: z.literal("pose"), x: z.number(), y: z.number(), headingDeg: z.number(), holdMs: z.number().default(1500) }),
  /** rotate on the spot */
  z.object({ op: z.literal("turn"), headingDeg: z.number(), holdMs: z.number().default(1500) }),
  /** walk in a straight line (non-stationary poses), then settle */
  z.object({ op: z.literal("walk"), to: z.tuple([z.number(), z.number()]), headingDeg: z.number().optional(), speedMps: z.number().default(1.4), settleMs: z.number().default(2000) }),
  /** put something down (or pick it up) as the phone-side detector would report it */
  z.object({
    op: z.literal("place"),
    label: z.string(),
    kind: z.enum(["placed", "picked_up"]).default("placed"),
    box: Box.default([0.6, 0.5, 0.2, 0.15]),
    distanceM: z.number().default(1.5),
    zone: z.string().default("desk"),
    description: z.string().optional(),
    features: z.array(z.string()).default([]),
    trigger: z.enum(["detector", "voice", "manual", "put_down"]).default("detector"),
    /** virtual ms to advance before the event (cooldown is by candidate time) */
    advanceMs: z.number().default(5000),
    /** frame hash; default: a fresh random one */
    hash: z.string().optional(),
    /** "auto": one detector box matching the label; "none": detector produced nothing; or explicit boxes */
    detections: z.union([z.literal("auto"), z.literal("none"), z.array(Det)]).default("auto"),
    /** the answer OMNI gives to "which detection is it?"; omit to let the mock choose */
    omniDetectionIndex: z.number().nullable().optional(),
    still: z.boolean().default(false),
    narration: z.string().optional(),
    /** emit non-stationary poses around the event */
    walking: z.boolean().default(false),
    /** send straight to the agent, skipping the phone-side CandidateFilter (to test the server guards) */
    bypassFilter: z.boolean().default(false),
    /** false: the frame carries no mock script, so the mock derives the label from narration/detections */
    scripted: z.boolean().default(true),
  }),
  /** put a scripted camera frame into the native ring buffer (for verify_visible) */
  z.object({ op: z.literal("camera"), mock: z.record(z.string(), z.unknown()) }),
  /** speak (or type) to the agent and check what it did */
  z.object({
    op: z.literal("ask"),
    text: z.string(),
    via: z.enum(["utterance", "query"]).default("utterance"),
    /** background chatter: the agent must stay silent */
    ambient: z.boolean().default(false),
    expect: z
      .object({
        replyIncludes: z.string().optional(),
        target: z.string().nullable().optional(),
        /** literal arrow angle (deg) from the wearer's current pose to the target */
        arrowDeg: z.number().optional(),
        tolDeg: z.number().default(1),
        /** arrow toward where a previous `place` put this label, computed from the placement geometry */
        arrowFromPlacement: z.string().optional(),
        toolCalled: z.string().optional(),
      })
      .default({ tolDeg: 1 }),
  }),
  z.object({
    op: z.literal("expectLedger"),
    count: z.number().optional(),
    has: z.array(z.object({ label: z.string(), zone: z.string().optional(), status: z.string().optional(), boxSource: z.string().optional() })).default([]),
    absent: z.array(z.string()).default([]),
  }),
  z.object({
    op: z.literal("expectIngest"),
    accepted: z.number().optional(),
    dropped: z.number().optional(),
    reasons: z.record(z.string(), z.number()).optional(),
    /** drops made by the phone-side CandidateFilter (never reach the agent) */
    phoneDrops: z.record(z.string(), z.number()).optional(),
  }),
]);
export type Op = z.infer<typeof OpSchema>;

export const ScenarioSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  hfovDeg: z.number().default(70),
  steps: z.array(OpSchema).min(1),
});
export type Scenario = z.infer<typeof ScenarioSchema>;
