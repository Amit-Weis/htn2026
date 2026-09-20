import { INITIAL_STATE, calibrateHeadOffset } from "@lastseen/shared";
import type { ClientMessage, Frame, HeadPose, ServerMessage, TrackerState } from "@lastseen/shared";
import { connectTracker } from "@lastseen/shared/connect";
import { Bridge } from "./bridge";
import { CandidateFilter, DEFAULT_FILTER, PoseRing } from "./candidateFilter";
import type { FilterResult } from "./candidateFilter";
import type { AppConfig } from "./config";
import { Hud } from "./hud";
import { computeHud } from "./hudModel";
import { KeyGestures } from "./keyGestures";
import { MockDetector, MockPose } from "./native/mock";
import { selectPlugins } from "./native/select";
import { DEFAULT_DETECTOR_CONFIG, DEFAULT_POSE_CONFIG } from "./native/types";
import { PoseCorrector } from "./poseCorrector";
import { WebVoiceIO } from "./voice/voiceIO";
import type { VoiceIO } from "./voice/voiceIO";

/** Wires native plugins (or their fallbacks) + voice + HUD to the TrackerAgent. Started from a user gesture. */
export async function startApp(cfg: AppConfig, root: HTMLElement) {
  const hud = new Hud(root);
  const { plugins, report } = await selectPlugins({ force: cfg.force, web: { cameraId: cfg.cameraId } });
  const ring = new PoseRing();
  const filter = new CandidateFilter(ring, { ...DEFAULT_FILTER, hfovDeg: cfg.hfovDeg });
  const corrector = new PoseCorrector();
  const gestures = new KeyGestures();
  const voice: VoiceIO = new WebVoiceIO();

  let state: TrackerState = INITIAL_STATE;
  let headPose: HeadPose | null = null;
  let headOffsetDeg = 0;
  let activeTurn: string | null = null;
  let connected = false;
  let detectorRunning = false;
  let shownAngle = 0;
  let lastTick = Date.now();
  const log: string[] = [];
  const note = (s: string) => {
    log.push(`${new Date().toISOString().slice(11, 19)} ${s}`);
    if (log.length > 8) log.shift();
  };

  const conn = connectTracker({
    host: cfg.host,
    device: cfg.device,
    token: cfg.token,
    onState: (s) => (state = s),
    onOpen: () => {
      connected = true;
      conn.send({ type: "hello", contractVersion: 2, role: "wearable" });
    },
    onClose: () => (connected = false),
    onMessage: (m) => void onServer(m),
  });
  const send = (m: ClientMessage) => conn.send(m);

  const bridge = new Bridge({ plugins, send, filter, ring, corrector, note });
  const upload = (r: FilterResult) => bridge.upload(r);

  function recenter() {
    if (bridge.pose && headPose) headOffsetDeg = calibrateHeadOffset(bridge.pose, headPose);
    void plugins.head.zeroView().catch(() => undefined);
    hud.showToast("view re-centered");
    note(`recenter offset=${headOffsetDeg.toFixed(0)}`);
  }

  async function onServer(m: ServerMessage) {
    if (await bridge.onServer(m)) return; // capture_now, request_frame, pose_correction
    switch (m.type) {
      case "speak":
        if (activeTurn === m.turnId) activeTurn = null;
        await voice.play(m.audioB64, m.mime, m.text);
        send({ type: "status", status: "idle" });
        break;
      case "stop_audio":
        voice.stopPlayback();
        break;
      case "recenter":
        recenter();
        break;
      case "remote_ptt":
        if (m.action === "down") voice.pttDown("query");
        else voice.pttUp();
        break;
      case "notice":
        hud.showToast(m.message);
        break;
      default:
        break;
    }
  }

  // ---- native plugin events ----
  plugins.head.onHeadPose((h) => (headPose = h)); // LOCAL only: never sent to the agent
  plugins.keys.onKey((e) => {
    for (const a of gestures.handle(e)) {
      if (a.type === "recenter") recenter();
      else if (a.action === "down") voice.pttDown(a.mode);
      else voice.pttUp();
    }
  });

  // ---- voice ----
  voice.onSpeechStart(({ bargeIn }) => {
    send({ type: "status", status: "listening" });
    if (bargeIn && activeTurn) {
      send({ type: "cancel", turnId: activeTurn }); // barge-in: playback already stopped locally
      activeTurn = null;
    }
  });
  voice.onUtterance(async (u) => {
    if (u.source === "narrate") return void bridge.backupCapture("voice", u.t + u.durationMs, u); // "putting my keys here"
    if (activeTurn) send({ type: "cancel", turnId: activeTurn });
    const turnId = `t${u.t}`;
    activeTurn = turnId;
    const frame = await bridge.latestFrame();
    send({ type: "utterance", turnId, t: u.t, audioB64: u.audioB64, mime: u.mime, frame: frame ?? undefined, poseAtT: ring.at(u.t) ?? bridge.pose ?? INITIAL_STATE.pose });
    note(`utterance ${u.source} ${Math.round(u.durationMs)} ms`);
  });

  // ---- HUD loop: 20 Hz, arrow computed locally from the latest target ----
  setInterval(() => {
    const now = Date.now();
    const view = computeHud({ state, pose: bridge.pose ?? state.pose, headPose, headOffsetDeg, nowMs: now, prevAngleDeg: shownAngle, dtMs: now - lastTick });
    lastTick = now;
    shownAngle = view.angleDeg;
    hud.render(view, detectorRunning || state.recording);
    const p = bridge.pose ?? state.pose;
    hud.setDebug([
      `${connected ? "online" : "OFFLINE"} device=${cfg.device} status=${state.status}`,
      ...report.map((r) => `${r.kind}: ${r.mode} - ${r.note}`),
      `heading ${view.headingDeg.toFixed(0)}° (${view.usingHead ? "head" : "chest"}) steps ${p.steps} x ${p.x.toFixed(1)} y ${p.y.toFixed(1)} conf ${p.confidence.toFixed(2)}`,
      `ingest ok ${state.ingest.accepted} drop ${state.ingest.dropped} ${JSON.stringify(state.ingest.reasons)} phone-drops ${JSON.stringify(filter.drops)}`,
      ...log,
    ]);
  }, 50);

  if (cfg.dev && plugins.detector instanceof MockDetector && plugins.pose instanceof MockPose) devPanel(plugins.detector, plugins.pose, voice, (t) => upload(t));
  // ---- start everything (this runs from the Start button: a user gesture) ----
  // Concurrent, each with a timeout: a pending permission prompt (mic, camera) must never freeze the HUD or the other plugins.
  const withTimeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms / 1000} s (permission prompt pending?)`)), ms))]);
  const starts: Array<[string, () => Promise<void>]> = [
    ["detector", () => plugins.detector.start(DEFAULT_DETECTOR_CONFIG).then(() => void (detectorRunning = true))],
    ["pose", () => plugins.pose.start({ ...DEFAULT_POSE_CONFIG, stepLengthM: cfg.stepLengthM })],
    ["head", () => plugins.head.start()],
    ["keys", () => plugins.keys.start()],
    ["voice", () => voice.start()],
  ];
  for (const [name, fn] of starts) {
    withTimeout(fn(), 20000).catch((e: unknown) => {
      note(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
      hud.showToast(`${name} unavailable`);
    });
  }
  (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<unknown> } }).wakeLock?.request("screen").catch(() => undefined); // not granted: the screen may sleep

  return { plugins, report, conn };
}

/** Desktop dev helpers for the mocks: fake walking, fake "keys placed", hold-to-talk. Never shown on the phone. */
function devPanel(det: MockDetector, poseMock: MockPose, voice: VoiceIO, _up: (r: FilterResult) => void) {
  const bar = document.createElement("div");
  bar.style.cssText = "position:fixed;bottom:60px;left:0;right:0;display:flex;gap:8px;justify-content:center;z-index:5";
  const mk = (label: string, fn: () => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = "font-size:20px;padding:8px 14px";
    b.onclick = fn;
    bar.appendChild(b);
    return b;
  };
  const x = 0;
  let y = 0;
  let steps = 0;
  const emit = (stationary: boolean) => poseMock.emitPose({ t: Date.now(), x, y, headingDeg: 0, steps, confidence: 1, stationary });
  mk("walk 3 m", () => {
    const iv = setInterval(() => {
      y += 0.7;
      steps++;
      emit(false);
      if (y >= 3) {
        clearInterval(iv);
        emit(true);
      }
    }, 300);
  });
  mk("stand still", () => emit(true));
  mk("place keys", () => {
    const t = Date.now();
    const ev = { kind: "placed", label: "keys", description: "A ring of silver keys", distinguishing_features: ["silver", "red tag"], surface: "desk", zone_name: "desk", bbox: [0.6, 0.5, 0.2, 0.15], distance_m: 1.2, holder: "wearer", confidence: 0.9 };
    const f = (dt: number, last: boolean): Frame => ({ t: t + dt, w: 640, h: 480, hash: last ? `dev${t}` : `dev${t}${dt}`, jpegBase64: btoa(JSON.stringify(last ? { mock: { events: [ev] } } : { note: "early" })) });
    det.emitCandidate({ t, trigger: "detector", frames: [f(-1000, false), f(-500, false), f(0, true)], detections: [[], [], [{ label: "keys", score: 0.9, bbox: [0.6, 0.5, 0.2, 0.15] }]] });
  });
  mk("hold to talk", () => undefined).onpointerdown = () => voice.pttDown("query");
  bar.lastElementChild!.addEventListener("pointerup", () => voice.pttUp());
  document.body.appendChild(bar);
}
