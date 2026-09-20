import { AgentStepSchema, CropDescriptionSchema, PlacementResultSchema, VerifyResultSchema } from "@lastseen/shared";
import type { AgentStep, CropDescription, PlacementResult, VerifyResult } from "@lastseen/shared";
import type { ZodType } from "zod";
import { BudgetGuard, DEFAULT_PRICING, estimateCad } from "./budget";
import type { Pricing } from "./budget";
import { CROP_SYSTEM, PLACEMENT_SYSTEM, STEP_SYSTEM, VERIFY_SYSTEM, renderHistory } from "./prompts";
import { BudgetExceededError } from "./types";
import type { AudioClip, Frame, OmniCapabilities, OmniClient, OmniResult, PlacementCtx, UtteranceCtx } from "./types";

export interface HttpOmniConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  budget: BudgetGuard;
  pricing?: Pricing;
  /** how audio is embedded in input_audio.data: "datauri" -> data:;base64,... ; "raw" -> plain base64 */
  audioStyle?: "datauri" | "raw";
  voice?: string;
  capabilities?: Partial<OmniCapabilities>;
  /** cap on frames sent per call (credit control) */
  maxFrames?: number;
  fetchImpl?: typeof fetch;
}

type Part =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } };

interface Streamed {
  text: string;
  audio: string[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Pull the first balanced {...} out of a model reply (tolerates code fences and stray prose). */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("no JSON object in reply");
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error("unterminated JSON object in reply");
}

/** 16-bit mono PCM -> WAV. */
export function pcm16ToWav(pcm: Uint8Array, sampleRate = 24000): Uint8Array {
  const h = new DataView(new ArrayBuffer(44));
  const w = (o: number, s: string) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  h.setUint32(4, 36 + pcm.length, true);
  w(8, "WAVEfmt ");
  h.setUint32(16, 16, true);
  h.setUint16(20, 1, true);
  h.setUint16(22, 1, true);
  h.setUint32(24, sampleRate, true);
  h.setUint32(28, sampleRate * 2, true);
  h.setUint16(32, 2, true);
  h.setUint16(34, 16, true);
  w(36, "data");
  h.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(new Uint8Array(h.buffer), 0);
  out.set(pcm, 44);
  return out;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class HttpOmni implements OmniClient {
  readonly capabilities: OmniCapabilities;
  private readonly pricing: Pricing;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: HttpOmniConfig) {
    this.capabilities = { audioInput: true, audioOutput: true, nativeToolCalling: false, streaming: true, ...cfg.capabilities };
    this.pricing = cfg.pricing ?? DEFAULT_PRICING;
    this.fetchImpl = cfg.fetchImpl ?? fetch.bind(globalThis);
  }

  private audioPart(a: AudioClip): Part {
    const format = a.mime.includes("wav") ? "wav" : a.mime.includes("webm") ? "webm" : (a.mime.split("/")[1] ?? "wav");
    const data = this.cfg.audioStyle === "raw" ? a.b64 : `data:;base64,${a.b64}`;
    return { type: "input_audio", input_audio: { data, format } };
  }

  private imagePart(f: Frame): Part {
    return { type: "image_url", image_url: { url: `data:image/jpeg;base64,${f.b64}` } };
  }

  /** One streaming chat call (Qwen-Omni models are stream-only); accumulates text and audio deltas. */
  private async stream(body: Record<string, unknown>): Promise<{ out: Streamed; latencyMs: number; costCad: number }> {
    await this.cfg.budget.assertAvailable();
    const t0 = Date.now();
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.cfg.model, stream: true, stream_options: { include_usage: true }, ...body }),
    });
    if (!res.ok || !res.body) throw new Error(`OMNI HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

    const out: Streamed = { text: "", audio: [] };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        const j = JSON.parse(data) as {
          usage?: Streamed["usage"];
          choices?: Array<{ delta?: { content?: string; audio?: { data?: string } } }>;
        };
        if (j.usage) out.usage = j.usage;
        const d = j.choices?.[0]?.delta;
        if (d?.content) out.text += d.content;
        if (d?.audio?.data) out.audio.push(d.audio.data);
      }
    }
    const costCad = estimateCad(out.usage, this.pricing);
    await this.cfg.budget.charge(costCad);
    return { out, latencyMs: Date.now() - t0, costCad };
  }

  /** Ask for JSON, validate with zod, retry once with a corrective nudge. */
  private async jsonCall<T>(system: string, parts: Part[], schema: ZodType<T>): Promise<OmniResult<T>> {
    let latencyMs = 0;
    let costCad = 0;
    let lastErr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const nudge: Part[] = attempt ? [{ type: "text", text: `Your previous reply was invalid (${lastErr}). Reply with the JSON object only.` }] : [];
      const r = await this.stream({
        messages: [
          { role: "system", content: system },
          { role: "user", content: [...parts, ...nudge] },
        ],
        max_tokens: 400,
      });
      latencyMs += r.latencyMs;
      costCad += r.costCad;
      try {
        const parsed = schema.safeParse(extractJson(r.out.text));
        if (parsed.success) return { value: parsed.data, latencyMs, costCad };
        lastErr = parsed.error.issues[0]?.message ?? "schema mismatch";
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
    throw new Error(`OMNI returned invalid JSON twice: ${lastErr}`);
  }

  extractPlacements(frames: Frame[], ctx: PlacementCtx): Promise<OmniResult<PlacementResult>> {
    const max = this.cfg.maxFrames ?? 6;
    const picked = frames.length > max ? pickEven(frames, max) : frames;
    const parts: Part[] = [
      { type: "text", text: `Known zones: ${ctx.knownZones.join(", ") || "(none yet)"}. ${picked.length} keyframes, oldest first:` },
      ...picked.map((f) => this.imagePart(f)),
    ];
    if (ctx.detections?.length) {
      const list = ctx.detections.map((d, i) => `#${i} ${d.label} ${d.score.toFixed(2)} [${d.bbox.map((n) => n.toFixed(2)).join(",")}]`).join("\n");
      parts.push({ type: "text", text: `DETECTOR BOXES (last frame):\n${list}` });
    }
    if (ctx.narration && this.capabilities.audioInput) parts.push(this.audioPart(ctx.narration));
    return this.jsonCall(PLACEMENT_SYSTEM, parts, PlacementResultSchema);
  }

  describeCrop(crop: Frame, hint: { label: string }): Promise<OmniResult<CropDescription>> {
    return this.jsonCall(CROP_SYSTEM, [{ type: "text", text: `Detector guess: ${hint.label}` }, this.imagePart(crop)], CropDescriptionSchema);
  }

  understandUtterance(audio: AudioClip | null, ctx: UtteranceCtx): Promise<OmniResult<AgentStep>> {
    const parts: Part[] = [
      { type: "text", text: `MEMORY:\n${ctx.memorySummary}\n\nHISTORY:\n${renderHistory(ctx.history)}` },
    ];
    if (ctx.text) parts.push({ type: "text", text: `WEARER SAID (typed): ${ctx.text}` });
    if (audio && this.capabilities.audioInput) parts.push(this.audioPart(audio));
    if (ctx.latestFrame) parts.push(this.imagePart(ctx.latestFrame));
    return this.jsonCall(STEP_SYSTEM, parts, AgentStepSchema);
  }

  verifyVisible(frame: Frame, objectDescription: string, audio?: AudioClip): Promise<OmniResult<VerifyResult>> {
    const parts: Part[] = [{ type: "text", text: `Is this visible now: ${objectDescription}` }, this.imagePart(frame)];
    if (audio && this.capabilities.audioInput) parts.push(this.audioPart(audio));
    return this.jsonCall(VERIFY_SYSTEM, parts, VerifyResultSchema);
  }

  async speak(text: string): Promise<OmniResult<AudioClip | null>> {
    if (!this.capabilities.audioOutput) return { value: null, latencyMs: 0, costCad: 0 };
    try {
      const r = await this.stream({
        messages: [{ role: "user", content: `Say exactly this, naturally and briefly: ${text}` }],
        modalities: ["text", "audio"],
        audio: { voice: this.cfg.voice ?? "Cherry", format: "wav" },
        max_tokens: 200,
      });
      if (!r.out.audio.length) throw new Error("no audio returned");
      // chunks are base64 PCM16 @24 kHz; decode each chunk (base64 boundaries are per-chunk)
      const pcm = concat(r.out.audio.map(b64ToBytes));
      const wav = pcm16ToWav(pcm);
      return { value: { b64: bytesToB64(wav), mime: "audio/wav" }, latencyMs: r.latencyMs, costCad: r.costCad };
    } catch (e) {
      // budget errors must surface; anything else degrades to browser speechSynthesis
      if (e instanceof BudgetExceededError) throw e;
      this.capabilities.audioOutput = false;
      return { value: null, latencyMs: 0, costCad: 0 };
    }
  }
}

function pickEven<T>(xs: T[], n: number): T[] {
  if (n <= 1) return xs.length ? [xs[xs.length - 1]!] : [];
  return Array.from({ length: n }, (_, i) => xs[Math.round((i * (xs.length - 1)) / (n - 1))]!);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
