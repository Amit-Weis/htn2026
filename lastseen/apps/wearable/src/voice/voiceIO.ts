import { Emitter } from "../native/emitter";
import type { Unsubscribe } from "../native/types";
import { DEFAULT_VAD, Vad, rms } from "./vad";
import { base64ToBytes, bytesToBase64, downsample, encodeWav } from "./wav";

export interface Utterance {
  audioB64: string;
  mime: "audio/wav";
  /** epoch ms when the utterance STARTED */
  t: number;
  durationMs: number;
  /** vad: heard by the voice detector; ptt: a query key; narrate: the narration key (placement narration) */
  source: "vad" | "ptt" | "narrate";
}

/**
 * Voice in the WebView (audio-only getUserMedia; never video). Kept behind this interface so it can move
 * into a native plugin later without touching the app.
 */
export interface VoiceIO {
  start(): Promise<void>;
  stop(): void;
  onUtterance(cb: (u: Utterance) => void): Unsubscribe;
  /** fires when the wearer starts talking (VAD or PTT); `bargeIn` is true when audio was playing */
  onSpeechStart(cb: (e: { bargeIn: boolean }) => void): Unsubscribe;
  onPlaybackEnd(cb: () => void): Unsubscribe;
  pttDown(mode: "query" | "narrate"): void;
  pttUp(): void;
  /** play OMNI audio when present, else browser speechSynthesis */
  play(audioB64: string | undefined, mime: string | undefined, text: string): Promise<void>;
  stopPlayback(): void;
  readonly playing: boolean;
}

/** While our own audio plays, only clearly louder speech counts as a barge-in. */
const BARGE_IN_RMS = 0.08;

export class WebVoiceIO implements VoiceIO {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  private readonly vad = new Vad(DEFAULT_VAD);
  private readonly utterances = new Emitter<Utterance>();
  private readonly starts = new Emitter<{ bargeIn: boolean }>();
  private readonly ends = new Emitter<void>();
  private manualMode: "query" | "narrate" | null = null;
  private startedAt = 0;
  private audio: HTMLAudioElement | null = null;
  private synthActive = false;
  private endPlayback: (() => void) | null = null;

  get playing() {
    return this.audio !== null || this.synthActive;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    const proc = this.ctx.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = (e) => this.onAudio(e.inputBuffer.getChannelData(0), e.inputBuffer.sampleRate);
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    src.connect(proc);
    proc.connect(mute);
    mute.connect(this.ctx.destination);
    this.node = proc;
  }

  stop() {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.stopPlayback();
    this.node = null;
    this.stream = null;
    this.ctx = null;
  }

  private onAudio(chunk: Float32Array, rate: number) {
    let pcm = downsample(chunk, rate, DEFAULT_VAD.sampleRate);
    if (this.playing && !this.manualMode && rms(pcm) < BARGE_IN_RMS) pcm = new Float32Array(pcm.length); // ignore our own speaker
    for (const ev of this.vad.push(pcm)) {
      if (ev.type === "speech_start") {
        this.startedAt = Date.now();
        const bargeIn = this.playing;
        if (bargeIn) this.stopPlayback();
        this.starts.emit({ bargeIn });
      } else if (ev.type === "speech_end") {
        this.emitUtterance(ev.pcm, ev.durationMs, this.manualMode === "narrate" ? "narrate" : this.manualMode === "query" ? "ptt" : "vad");
        this.manualMode = null;
      }
    }
  }

  private emitUtterance(pcm: Float32Array, durationMs: number, source: Utterance["source"]) {
    const wav = encodeWav(pcm, DEFAULT_VAD.sampleRate);
    this.utterances.emit({ audioB64: bytesToBase64(wav), mime: "audio/wav", t: this.startedAt || Date.now() - durationMs, durationMs, source });
  }

  pttDown(mode: "query" | "narrate") {
    const bargeIn = this.playing;
    if (bargeIn) this.stopPlayback();
    this.manualMode = mode;
    this.startedAt = Date.now();
    this.vad.startManual();
    this.starts.emit({ bargeIn });
  }

  pttUp() {
    const ev = this.vad.endManual();
    const mode = this.manualMode;
    this.manualMode = null;
    if (ev?.type === "speech_end" && ev.durationMs > 200) this.emitUtterance(ev.pcm, ev.durationMs, mode === "narrate" ? "narrate" : "ptt");
  }

  onUtterance(cb: (u: Utterance) => void) {
    return this.utterances.on(cb);
  }
  onSpeechStart(cb: (e: { bargeIn: boolean }) => void) {
    return this.starts.on(cb);
  }
  onPlaybackEnd(cb: () => void) {
    return this.ends.on(cb);
  }

  play(audioB64: string | undefined, mime: string | undefined, text: string): Promise<void> {
    this.stopPlayback();
    return new Promise<void>((resolve) => {
      const done = () => {
        this.audio = null;
        this.synthActive = false;
        this.endPlayback = null;
        this.ends.emit();
        resolve();
      };
      this.endPlayback = done;
      if (audioB64) {
        const url = URL.createObjectURL(new Blob([base64ToBytes(audioB64) as BlobPart], { type: mime ?? "audio/wav" }));
        const a = new Audio(url);
        this.audio = a;
        a.onended = () => (URL.revokeObjectURL(url), done());
        a.onerror = () => (URL.revokeObjectURL(url), this.speakText(text, done));
        a.play().catch(() => this.speakText(text, done));
      } else {
        this.speakText(text, done);
      }
    });
  }

  private speakText(text: string, done: () => void) {
    this.audio = null;
    if (!("speechSynthesis" in window) || !text) return done();
    this.synthActive = true;
    const u = new SpeechSynthesisUtterance(text);
    u.onend = done;
    u.onerror = done;
    window.speechSynthesis.speak(u);
  }

  stopPlayback() {
    const wasPlaying = this.playing;
    this.audio?.pause();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    if (wasPlaying) this.endPlayback?.();
    this.audio = null;
    this.synthActive = false;
  }
}
