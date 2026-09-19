import type { AgentStep, PlacementResult, VerifyResult } from "@lastseen/shared";

/** JPEG frame, base64 (no data: prefix). */
export interface Frame {
  b64: string;
}

/** Audio clip, base64. mime is audio/wav (16 kHz mono PCM) or audio/webm. */
export interface AudioClip {
  b64: string;
  mime: string;
}

export interface OmniCapabilities {
  audioInput: boolean;
  /** false -> speak() returns null and the phone uses browser speechSynthesis */
  audioOutput: boolean;
  /** false -> strict JSON step protocol (the default; deterministic across proxies) */
  nativeToolCalling: boolean;
  streaming: boolean;
}

export interface PlacementCtx {
  /** zone names we already know (helps consistent naming) */
  knownZones: string[];
  /** wearer narration during the placement ("putting my keys here"), fused with vision */
  narration?: AudioClip;
}

export interface HistoryItem {
  role: "user" | "assistant" | "tool";
  content: string;
}

export interface UtteranceCtx {
  latestFrame?: Frame;
  /** compact text: current zone + recent objects */
  memorySummary: string;
  /** prior steps of this utterance (tool calls and results) + short multi-turn state */
  history: HistoryItem[];
  /** typed query (dashboard); used instead of audio */
  text?: string;
}

/** Every call reports latency and estimated cost so the agent can trace and budget it. */
export interface OmniResult<T> {
  value: T;
  latencyMs: number;
  costCad: number;
}

export interface OmniClient {
  readonly capabilities: OmniCapabilities;
  extractPlacements(frames: Frame[], ctx: PlacementCtx): Promise<OmniResult<PlacementResult>>;
  /** audio is sent on the first step only; later steps rely on the transcript in history */
  understandUtterance(audio: AudioClip | null, ctx: UtteranceCtx): Promise<OmniResult<AgentStep>>;
  verifyVisible(frame: Frame, objectDescription: string, audio?: AudioClip): Promise<OmniResult<VerifyResult>>;
  speak(text: string): Promise<OmniResult<AudioClip | null>>;
}

export class BudgetExceededError extends Error {
  constructor(
    readonly spentCad: number,
    readonly capCad: number,
  ) {
    super(`OMNI budget cap reached (${spentCad.toFixed(2)} / ${capCad.toFixed(2)} CAD)`);
  }
}
