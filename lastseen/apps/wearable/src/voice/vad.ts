/**
 * Energy-based voice activity detection with a hangover, pre-roll and a hard length cap.
 * Pure (no Web Audio): feed it Float32 PCM at `sampleRate`; it emits utterances as PCM.
 */

export interface VadConfig {
  sampleRate: number;
  frameMs: number;
  /** RMS above this starts speech */
  startRms: number;
  /** RMS above this keeps speech alive (hysteresis: lower than startRms) */
  keepRms: number;
  /** silence after speech that ends the utterance */
  hangoverMs: number;
  /** shorter than this is noise, not an utterance */
  minSpeechMs: number;
  /** audio kept from before the trigger so the first syllable is not clipped */
  preRollMs: number;
  maxUtteranceMs: number;
}

export const DEFAULT_VAD: VadConfig = {
  sampleRate: 16000,
  frameMs: 20,
  startRms: 0.03,
  keepRms: 0.015,
  hangoverMs: 700,
  minSpeechMs: 250,
  preRollMs: 300,
  maxUtteranceMs: 15000,
};

export type VadEvent =
  | { type: "speech_start" }
  | { type: "speech_end"; pcm: Float32Array; durationMs: number; reason: "silence" | "max" | "manual" }
  | { type: "discard"; reason: "too_short" };

export const rms = (x: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, x.length));
};

export class Vad {
  private readonly frameLen: number;
  private carry = new Float32Array(0);
  private preRoll: Float32Array[] = [];
  private buf: Float32Array[] = [];
  private speaking = false;
  private manual = false;
  private speechMs = 0;
  private silenceMs = 0;
  private totalMs = 0;

  constructor(private readonly cfg: VadConfig = DEFAULT_VAD) {
    this.frameLen = Math.round((cfg.sampleRate * cfg.frameMs) / 1000);
  }

  get isSpeaking() {
    return this.speaking;
  }

  /** Push PCM of any length; returns the events it caused. */
  push(samples: Float32Array): VadEvent[] {
    const all = new Float32Array(this.carry.length + samples.length);
    all.set(this.carry, 0);
    all.set(samples, this.carry.length);
    const events: VadEvent[] = [];
    let o = 0;
    for (; o + this.frameLen <= all.length; o += this.frameLen) events.push(...this.frame(all.subarray(o, o + this.frameLen)));
    this.carry = all.slice(o);
    return events;
  }

  private frame(f: Float32Array): VadEvent[] {
    const out: VadEvent[] = [];
    const e = rms(f);
    const copy = f.slice();
    if (!this.speaking) {
      this.preRoll.push(copy);
      const max = Math.ceil(this.cfg.preRollMs / this.cfg.frameMs);
      while (this.preRoll.length > max) this.preRoll.shift();
      if (e >= this.cfg.startRms) this.begin(out);
      return out;
    }
    this.buf.push(copy);
    this.totalMs += this.cfg.frameMs;
    if (e >= this.cfg.keepRms) {
      this.speechMs += this.cfg.frameMs + this.silenceMs; // silence inside speech counts as speech
      this.silenceMs = 0;
    } else {
      this.silenceMs += this.cfg.frameMs;
    }
    if (!this.manual && this.silenceMs >= this.cfg.hangoverMs) out.push(this.end("silence"));
    else if (this.totalMs >= this.cfg.maxUtteranceMs) out.push(this.end("max"));
    return out;
  }

  private begin(out: VadEvent[]) {
    this.speaking = true;
    this.buf = [...this.preRoll];
    this.preRoll = [];
    this.speechMs = this.cfg.frameMs;
    this.silenceMs = 0;
    this.totalMs = this.buf.length * this.cfg.frameMs;
    out.push({ type: "speech_start" });
  }

  private end(reason: "silence" | "max" | "manual"): VadEvent {
    const speech = this.speechMs;
    // drop the trailing silence but keep a short tail so words do not end abruptly
    const tailFrames = Math.ceil(120 / this.cfg.frameMs);
    // a manual (push-to-talk) recording is exactly what the wearer held the key for: keep all of it
    const dropFrames = reason === "manual" ? 0 : Math.max(0, Math.floor(this.silenceMs / this.cfg.frameMs) - tailFrames);
    const frames = this.buf.slice(0, this.buf.length - dropFrames);
    this.reset();
    if (reason !== "manual" && speech < this.cfg.minSpeechMs) return { type: "discard", reason: "too_short" };
    const pcm = new Float32Array(frames.reduce((n, x) => n + x.length, 0));
    let o = 0;
    for (const x of frames) {
      pcm.set(x, o);
      o += x.length;
    }
    return { type: "speech_end", pcm, durationMs: (pcm.length / this.cfg.sampleRate) * 1000, reason };
  }

  private reset() {
    this.speaking = false;
    this.manual = false;
    this.buf = [];
    this.speechMs = 0;
    this.silenceMs = 0;
    this.totalMs = 0;
  }

  /** Push-to-talk down: record everything until endManual(), regardless of energy. */
  startManual(): VadEvent[] {
    const out: VadEvent[] = [];
    if (this.speaking) return out;
    this.begin(out);
    this.manual = true;
    return out;
  }

  /** Push-to-talk up: returns the recording (or a discard if it was empty). */
  endManual(): VadEvent | null {
    if (!this.speaking || !this.manual) return null;
    // include the partial frame still in `carry`
    if (this.carry.length) {
      this.buf.push(this.carry);
      this.carry = new Float32Array(0);
    }
    return this.end("manual");
  }
}
