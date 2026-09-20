import { formatAge } from "@lastseen/shared";
import type { AgentStep, CropDescription, IntentResult, PlacementEvent, PlacementResult, ToolName, VerifyResult } from "@lastseen/shared";
import { keywordIntent } from "../intent";
import { labelsCompatible } from "../memory/text";
import type { AudioClip, Frame, IntentTarget, OmniCapabilities, OmniClient, OmniResult, PlacementCtx, UtteranceCtx } from "./types";

/**
 * MOCK_OMNI=1: canned, schema-valid responses so the whole system runs offline and in CI.
 *
 * Test hooks: a "frame" or "audio" whose base64 decodes to a JSON object is treated as a script.
 *   frame  {"mock":{"events":[...]}}            -> extractPlacements result
 *   frame  {"mock":{"visible":true,"bbox":..}}  -> verifyVisible result
 *   audio  {"mockTranscript":"where are my keys","addressed":true}
 * Anything else falls back to deterministic canned data so a real camera still drives the demo.
 */

const CANNED: PlacementEvent[] = [
  {
    kind: "placed",
    label: "keys",
    description: "A ring of silver keys with a red tag",
    distinguishing_features: ["silver", "red tag"],
    detection_index: null,
    surface: "desk",
    zone_name: "desk",
    bbox: [0.4, 0.5, 0.2, 0.15],
    distance_m: 0.9,
    holder: "wearer",
    confidence: 0.9,
  },
  {
    kind: "placed",
    label: "mug",
    description: "A white ceramic coffee mug",
    distinguishing_features: ["white", "ceramic", "handle"],
    detection_index: null,
    surface: "shelf",
    zone_name: "shelf",
    bbox: [0.55, 0.35, 0.18, 0.2],
    distance_m: 1.2,
    holder: "wearer",
    confidence: 0.85,
  },
  {
    kind: "placed",
    label: "phone charger",
    description: "A white USB-C charger with a braided cable",
    distinguishing_features: ["white", "braided cable"],
    detection_index: null,
    surface: "table",
    zone_name: "kitchen table",
    bbox: [0.3, 0.6, 0.15, 0.1],
    distance_m: 1.0,
    holder: "wearer",
    confidence: 0.8,
  },
];

function decodeJson(b64: string): Record<string, unknown> | null {
  try {
    const text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    if (!text.trimStart().startsWith("{")) return null;
    const j = JSON.parse(text);
    return typeof j === "object" && j ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

interface ToolRecord {
  tool: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

/** History items with role "tool" carry JSON {tool,args,result}; parse the last one. */
function lastTool(ctx: UtteranceCtx): ToolRecord | null {
  for (let i = ctx.history.length - 1; i >= 0; i--) {
    const h = ctx.history[i]!;
    if (h.role !== "tool") continue;
    try {
      return JSON.parse(h.content) as ToolRecord;
    } catch {
      return null;
    }
  }
  return null;
}

const clean = (s: string) => s.trim().replace(/[?.!,]+$/g, "").replace(/^(my|the|a|an)\s+/i, "").trim();

export class MockOmni implements OmniClient {
  readonly capabilities: OmniCapabilities = { audioInput: true, audioOutput: false, nativeToolCalling: false, streaming: false };

  private done<T>(value: T): Promise<OmniResult<T>> {
    return Promise.resolve({ value, latencyMs: 5, costCad: 0 });
  }

  /**
   * Answers the detection-index question like the real model would: a scripted event that omits
   * `detection_index` gets the best label-compatible detector box; an explicit `null` stays null
   * (so tests can exercise the "OMNI rejects every box" fallback).
   */
  extractPlacements(frames: Frame[], ctx: PlacementCtx): Promise<OmniResult<PlacementResult>> {
    const last = frames[frames.length - 1];
    const dets = ctx.detections ?? [];
    const scripted = last ? decodeJson(last.b64)?.mock : undefined;
    const narrated = ctx.narration ? decodeJson(ctx.narration.b64)?.mockTranscript : undefined;
    let events: PlacementEvent[];
    if (scripted && typeof scripted === "object" && "events" in scripted) {
      events = ((scripted as { events: Array<Partial<PlacementEvent>> }).events).map((e) => {
        const ev = { ...CANNED[0]!, ...e } as PlacementEvent;
        if (!("detection_index" in e)) {
          const i = dets.findIndex((d) => labelsCompatible(d.label, ev.label));
          ev.detection_index = i >= 0 ? i : null;
        }
        return ev;
      });
    } else {
      const pick = { ...CANNED[hash(last?.b64 ?? "") % CANNED.length]! };
      if (typeof narrated === "string") {
        const m = /putting (?:down |away )?(?:my |the |a |an )?(.+?)(?: here| down| there|$)/i.exec(narrated);
        if (m) pick.label = m[1]!.trim();
      }
      if (dets.length) {
        let best = dets.findIndex((d) => labelsCompatible(d.label, pick.label));
        if (best < 0) {
          best = dets.reduce((bi, d, i) => (d.score > dets[bi]!.score ? i : bi), 0);
          if (typeof narrated !== "string") pick.label = dets[best]!.label;
        }
        pick.detection_index = best;
      }
      events = [pick];
    }
    return this.done({ events });
  }

  describeCrop(_crop: Frame, hint: { label: string }): Promise<OmniResult<CropDescription>> {
    return this.done({ label: hint.label, description: `${hint.label} (close-up)`, distinguishing_features: ["mock-crop"] });
  }

  /** The mock "understands" with the keyword rule (a name plus a "find" word), so a demo without OMNI still points at the target. */
  understandIntent(audio: AudioClip | null, text: string | undefined, targets: IntentTarget[]): Promise<OmniResult<IntentResult>> {
    const scripted = audio ? decodeJson(audio.b64) : null;
    const heard = text ?? (typeof scripted?.mockTranscript === "string" ? scripted.mockTranscript : "");
    const id = keywordIntent(heard);
    const target = targets.find((t) => t.id === id);
    return this.done({ heard, wants: target ? target.id : null, say: target ? `Pointing you to your ${target.names[0]}.` : "" });
  }

  understandUtterance(audio: AudioClip | null, ctx: UtteranceCtx): Promise<OmniResult<AgentStep>> {
    const scripted = audio ? decodeJson(audio.b64) : null;
    const said =
      ctx.text ??
      (typeof scripted?.mockTranscript === "string" ? scripted.mockTranscript : undefined) ??
      [...ctx.history].reverse().find((h) => h.role === "user")?.content ??
      "";
    const addressed = scripted?.addressed !== false;
    const t = said.toLowerCase().trim();
    const base = { addressed, transcript: said };
    const final = (text: string): Promise<OmniResult<AgentStep>> =>
      this.done({ type: "final", ...base, text: addressed ? text : "" });
    const tool = (name: ToolName, args: Record<string, unknown>) =>
      this.done<AgentStep>({ type: "tool", ...base, tool: name, args } as AgentStep);

    if (!addressed) return final("");

    const prev = lastTool(ctx);
    const target = /target=(\S+)/.exec(ctx.memorySummary)?.[1];

    // ---- continue an in-flight plan from the last tool result ----
    if (prev) {
      const r = prev.result ?? {};
      const cands = (r.candidates as Array<Record<string, unknown>> | undefined) ?? [];
      switch (prev.tool) {
        case "find_object": {
          const [a, b] = cands;
          if (!a) return final(`I haven't seen anything like ${clean(String(prev.args?.query ?? "that"))}.`);
          const wantsForget = /\bforget\b/.test(t);
          if (b && !wantsForget && Number(a.score) - Number(b.score) < 0.08 && a.label !== b.label) {
            return tool("clarify", { question: `Do you mean the ${String(a.label)} or the ${String(b.label)}?` });
          }
          return wantsForget ? tool("forget", { objectId: a.objectId }) : tool("guide_to", { objectId: a.objectId });
        }
        case "guide_to":
          return final(
            r.ok
              ? `Your ${String(r.label)} is ${r.zone ? `near the ${String(r.zone)}` : "over there"}, last seen ${formatAge(Number(r.ageSec ?? 0))}.`
              : "I couldn't find a location for that.",
          );
        case "list_recent": {
          const it = (r.items as Array<Record<string, unknown>> | undefined) ?? [];
          const first = it[0];
          return final(
            first
              ? `The last thing you put down was your ${String(first.label)}${first.zone ? ` on the ${String(first.zone)}` : ""}, ${formatAge(Number(first.ageSec ?? 0))}.`
              : "I haven't seen you put anything down yet.",
          );
        }
        case "verify_visible":
          return final(r.visible ? `Yes, your ${String(r.label ?? "object")} is right there.` : `No, I don't see it there anymore. ${String(r.note ?? "")}`.trim());
        case "forget":
          return final(prev.args?.objectId === "all" ? "Okay, I've forgotten everything." : "Okay, forgotten.");
        case "recenter":
          return final("Okay, view re-centered.");
        case "mark_moved":
          return final("Got it, I'll treat it as moved.");
        case "clarify":
          return final(String(prev.args?.question ?? "Which one do you mean?"));
        default:
          return final("Done.");
      }
    }

    // ---- first step: read intent ----
    if (/\bforget\b.*\b(everything|all)\b/.test(t)) return tool("forget", { objectId: "all" });
    let m = /\bforget\b\s+(.+)/.exec(t);
    if (m) return tool("find_object", { query: clean(m[1]!) });
    if (/(re-?center|straight ahead|reset (my )?view)/.test(t)) return tool("recenter", {});
    if (/(what|which).*(put down|last|recent)/.test(t)) return tool("list_recent", { limit: 1 });
    if (/(still there|still here|is it there|check (it|again))/.test(t) && target) return tool("verify_visible", { objectId: target });
    m = /\bwhere(?:'s|s| is| are)?\s+(?:is\s+|are\s+)?(.+)/.exec(t) ?? /\b(?:find|locate)\s+(.+)/.exec(t);
    if (m) return tool("find_object", { query: clean(m[1]!) });
    return final("Sorry, I didn't catch that.");
  }

  verifyVisible(frame: Frame, _objectDescription: string, _audio?: AudioClip): Promise<OmniResult<VerifyResult>> {
    const scripted = decodeJson(frame.b64)?.mock;
    if (scripted && typeof scripted === "object" && "visible" in scripted) {
      const s = scripted as Partial<VerifyResult>;
      return this.done({ visible: Boolean(s.visible), bbox: s.bbox, distance_m: s.distance_m ?? null, note: s.note ?? "mock verification" });
    }
    return this.done({ visible: false, note: "mock: object not in view" });
  }

  speak(_text: string): Promise<OmniResult<AudioClip | null>> {
    return this.done(null); // phone falls back to browser speechSynthesis
  }
}
