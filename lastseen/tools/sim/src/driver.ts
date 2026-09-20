import { arrowAngle, arrowAngleFromHeading, objectPosition } from "@lastseen/shared";
import type { ClientMessage, Detection, ObjectRow, PlacementCandidate, Pose, ServerMessage } from "@lastseen/shared";
import { Bridge } from "@lastseen/wearable/bridge";
import { CandidateFilter, DEFAULT_FILTER, PoseRing } from "@lastseen/wearable/filter";
import { mockPlugins } from "@lastseen/wearable/native/mock";
import { PoseCorrector } from "@lastseen/wearable/pose-corrector";
import { SimClient } from "./client";
import type { Op, Scenario } from "./scenario";

const b64 = (o: unknown) => btoa(JSON.stringify(o));

export interface StepResult {
  index: number;
  op: string;
  ok: boolean;
  detail: string;
}
export interface ScenarioResult {
  name: string;
  device: string;
  ok: boolean;
  steps: StepResult[];
}

class AssertionFailed extends Error {}
function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new AssertionFailed(msg);
}

/** Plays a scenario against a running worker. Time is virtual: candidate timestamps are scripted, nothing sleeps. */
export async function runScenario(sc: Scenario, opts: { url: string; token: string; log?: (s: string) => void }): Promise<ScenarioResult> {
  const log = opts.log ?? (() => undefined);
  const device = `sim-${sc.name}-${Date.now().toString(36)}`;
  const client = new SimClient(opts.url, device, opts.token);
  await client.connect("sim");

  const clock = { t: Date.now() };
  const plugins = mockPlugins();
  const ring = new PoseRing(120_000);
  const filter = new CandidateFilter(ring, { ...DEFAULT_FILTER, hfovDeg: sc.hfovDeg });
  const notes: string[] = [];
  const bridge = new Bridge({
    plugins,
    send: (m: ClientMessage) => client.send(m),
    filter,
    ring,
    corrector: new PoseCorrector(),
    now: () => clock.t,
    sleep: async (ms) => void (clock.t += ms),
    note: (s) => notes.push(s),
  });
  client.onMessage((m: ServerMessage) => { if (process.env.SIM_DEBUG && m.type === "request_frame") log("    [debug] request_frame received"); void bridge.onServer(m); }); // request_frame / capture_now / pose_correction

  let cur: Pose = { t: clock.t, x: 0, y: 0, headingDeg: 0, steps: 0, confidence: 1, stationary: true };
  const placed = new Map<string, { x: number; y: number }>();
  let seq = 0;
  let hashSeed = 12345;
  const randHash = () => {
    let h = "";
    for (let i = 0; i < 16; i++) {
      hashSeed = (Math.imul(hashSeed, 1103515245) + 12345) >>> 0;
      h += ((hashSeed >>> 16) & 15).toString(16);
    }
    return h;
  };

  let lastPoseT = 0;
  const emitPose = (over: Partial<Pose>) => {
    cur = { ...cur, ...over, t: clock.t };
    lastPoseT = clock.t;
    plugins.pose.emitPose(cur);
  };
  /** stationary (or walking-in-place) poses at 5 Hz over [from, to] virtual ms */
  const burst = (from: number, to: number, stationary: boolean) => {
    for (let t = Math.max(from, lastPoseT + 200); t <= to; t += 200) { // poses never go backwards in time
      clock.t = t;
      if (!stationary) cur = { ...cur, steps: cur.steps + 1 };
      emitPose({ stationary });
    }
  };

  const ledger = async (): Promise<ObjectRow[]> => {
    const before = client.messages.length;
    client.send({ type: "ledger_request" });
    const msg = await client.waitFor((c) => c.messages.slice(before).find((m) => m.type === "ledger"), 15000, "ledger reply");
    return (msg as Extract<ServerMessage, { type: "ledger" }>).objects;
  };

  async function place(op: Extract<Op, { op: "place" }>) {
    clock.t += op.advanceMs;
    const t = clock.t;
    // pose context around the event
    burst(t - 2000, t + 500, !op.walking);
    clock.t = t;

    const dets: Detection[] =
      op.detections === "none" ? [] : op.detections === "auto" ? [{ label: op.label, score: 0.9, bbox: op.box }] : op.detections.map((d) => ({ label: d.label, score: d.score, bbox: d.bbox }));
    const event = {
      kind: op.kind, label: op.label, description: op.description ?? `A ${op.label} on the ${op.zone}`, distinguishing_features: op.features,
      surface: op.zone, zone_name: op.zone, bbox: op.box, distance_m: op.distanceM, holder: "wearer", confidence: 0.9,
      ...(op.omniDetectionIndex !== undefined ? { detection_index: op.omniDetectionIndex } : {}),
    };
    const hash = op.hash ?? randHash();
    const frame = (dt: number, last: boolean) => ({
      t: t + dt, w: 640, h: 480, hash: last ? hash : randHash(),
      jpegBase64: b64(last && op.scripted ? { mock: { events: [event] } } : { note: last ? "plain frame" : "early frame" }),
    });
    const frames = [frame(-1000, false), frame(-500, false), frame(0, true)];
    frames.forEach((f, i) => plugins.detector.pushFrame(f, i === 2 ? dets : []));
    plugins.detector.setStill(op.still ? { t, w: 4000, h: 3000, jpegBase64: b64({ mock: { events: [event] } }) } : null);

    // remember where the geometry says this object ends up (for arrowFromPlacement)
    if (op.kind === "placed") {
      const pose = cur;
      placed.set(op.label, objectPosition(pose, pose.headingDeg, op.box[0] + op.box[2] / 2, op.distanceM, sc.hfovDeg));
    }

    const drops = () => Object.values(filter.drops).reduce((a, b) => a + b, 0);
    const dropsBefore = drops();
    const mark = client.messages.length;
    const narration = op.narration ? { audioB64: b64({ mockTranscript: op.narration }), mime: "audio/wav" } : undefined;

    if (op.bypassFilter) {
      const cand: PlacementCandidate = {
        type: "placement_candidate", t, trigger: op.trigger, frames, detections: [[], [], dets], hfovDeg: sc.hfovDeg,
        poseSlice: ring.slice(t - 4000, t + 500),
        stillFrame: op.still ? { t, w: 4000, h: 3000, jpegBase64: b64({ mock: { events: [event] } }) } : undefined,
        narrationAudioB64: narration?.audioB64, narrationMime: narration?.mime,
      };
      client.send(cand);
    } else if (op.trigger === "detector") {
      plugins.detector.emitCandidate({ t, trigger: "detector", frames, stillFrame: op.still ? { t, w: 4000, h: 3000, jpegBase64: b64({ mock: { events: [event] } }) } : undefined, detections: [[], [], dets] });
    } else if (op.trigger === "put_down") {
      plugins.pose.emitPutDown(t);
    } else {
      await bridge.backupCapture(op.trigger, t, narration);
    }
    await settle(300);

    if (drops() > dropsBefore) return `phone-side filter dropped it (${notes.at(-1) ?? ""})`;
    // wait for the agent to finish with it: an ingest `notify` trace (accepted) or a guard drop trace
    const done = await client.waitFor(
      (c) => c.messages.slice(mark).find((m) => m.type === "trace" && (m.trace.tool === "notify" || (m.trace.result as { dropped?: boolean } | null)?.dropped)),
      30000,
      `agent to finish ingesting ${op.label}`,
    );
    const tr = (done as Extract<ServerMessage, { type: "trace" }>).trace;
    return tr.tool === "notify" ? "accepted and ingested" : `dropped by the agent: ${(tr.result as { reason: string }).reason}`;
  }

  /** let in-flight async work (bridge sleeps are virtual, WebSocket delivery is real) settle briefly */
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function ask(op: Extract<Op, { op: "ask" }>) {
    clock.t += 300;
    const turnId = `sim-${++seq}`;
    const mark = client.messages.length;
    const frame = await bridge.latestFrame();
    if (op.via === "query") client.send({ type: "query", turnId, text: op.text });
    else client.send({ type: "utterance", turnId, t: clock.t, audioB64: b64({ mockTranscript: op.text, addressed: !op.ambient }), mime: "audio/wav", frame: frame ?? undefined, poseAtT: cur });

    if (op.ambient) {
      await settle(1500);
      check(!client.messages.slice(mark).some((m) => m.type === "speak"), "the agent answered background chatter");
      const omni = client.messages.slice(mark).find((m) => m.type === "trace" && m.trace.kind === "omni");
      check(omni, "no OMNI trace for the ambient utterance");
      return "ignored ambient chatter";
    }

    const speak = (await client.waitFor((c) => c.messages.slice(mark).find((m) => m.type === "speak" && m.turnId === turnId), 30000, `a spoken reply to "${op.text}"`)) as Extract<ServerMessage, { type: "speak" }>;
    const e = op.expect;
    if (e.replyIncludes) check(speak.text.toLowerCase().includes(e.replyIncludes.toLowerCase()), `reply "${speak.text}" does not include "${e.replyIncludes}"`);
    if (e.toolCalled) check(client.messages.slice(mark).some((m) => m.type === "trace" && m.trace.kind === "tool" && m.trace.tool === e.toolCalled), `tool ${e.toolCalled} was not called`);

    const target = client.state?.target ?? null;
    if (e.target !== undefined) {
      if (e.target === null) check(!target, `expected no target, got ${target?.label}`);
      else check(target?.label === e.target, `expected target "${e.target}", got ${target ? `"${target.label}"` : "none"}`);
    }
    const angle = target ? arrowAngle(target, cur, null, 0, clock.t) : null;
    if (e.arrowDeg !== undefined) {
      check(angle !== null, "no target, so no arrow");
      check(Math.abs(angle - e.arrowDeg) <= e.tolDeg, `arrow ${angle.toFixed(2)}° differs from expected ${e.arrowDeg}° by more than ${e.tolDeg}°`);
    }
    if (e.arrowFromPlacement) {
      const p = placed.get(e.arrowFromPlacement);
      check(p, `no placement recorded for ${e.arrowFromPlacement}`);
      const want = arrowAngleFromHeading(p, cur, cur.headingDeg);
      check(angle !== null, "no target, so no arrow");
      check(Math.abs(angle - want) <= e.tolDeg, `arrow ${angle.toFixed(2)}° differs from the placement geometry (${want.toFixed(2)}°) by more than ${e.tolDeg}°`);
    }
    return `"${speak.text}"${target ? ` · target ${target.label} ${target.mode} arrow ${angle?.toFixed(1)}°` : ""}`;
  }

  async function step(op: Op): Promise<string> {
    switch (op.op) {
      case "pose":
        cur = { ...cur, x: op.x, y: op.y, headingDeg: op.headingDeg };
        burst(clock.t, clock.t + op.holdMs, true);
        return `at (${op.x}, ${op.y}) facing ${op.headingDeg}°`;
      case "turn":
        cur = { ...cur, headingDeg: op.headingDeg };
        burst(clock.t, clock.t + op.holdMs, true);
        return `facing ${op.headingDeg}°`;
      case "walk": {
        const dx = op.to[0] - cur.x;
        const dy = op.to[1] - cur.y;
        const dist = Math.hypot(dx, dy);
        const heading = op.headingDeg ?? (Math.atan2(dx, dy) * 180) / Math.PI;
        const n = Math.max(1, Math.ceil((dist / op.speedMps) / 0.2));
        const start = { x: cur.x, y: cur.y };
        for (let i = 1; i <= n; i++) {
          clock.t += 200;
          cur = { ...cur, x: start.x + (dx * i) / n, y: start.y + (dy * i) / n, headingDeg: (heading + 360) % 360, steps: cur.steps + 1 };
          emitPose({ stationary: false });
        }
        burst(clock.t + 200, clock.t + op.settleMs, true);
        return `walked ${dist.toFixed(1)} m to (${op.to[0]}, ${op.to[1]})`;
      }
      case "place":
        return place(op);
      case "camera":
        plugins.detector.pushFrame({ t: clock.t, w: 640, h: 480, hash: randHash(), jpegBase64: b64({ mock: op.mock }) });
        return "camera frame scripted";
      case "ask":
        return ask(op);
      case "expectLedger": {
        const rows = await ledger();
        if (op.count !== undefined) check(rows.length === op.count, `ledger has ${rows.length} objects, expected ${op.count}: ${rows.map((r) => r.label).join(", ")}`);
        for (const want of op.has) {
          const r = rows.find((x) => x.label.toLowerCase() === want.label.toLowerCase());
          check(r, `ledger has no "${want.label}" (has: ${rows.map((x) => x.label).join(", ") || "nothing"})`);
          if (want.zone) check(r.zone === want.zone, `${want.label} zone is "${r.zone}", expected "${want.zone}"`);
          if (want.status) check(r.status === want.status, `${want.label} status is "${r.status}", expected "${want.status}"`);
          if (want.boxSource) check(r.boxSource === want.boxSource, `${want.label} boxSource is "${r.boxSource}", expected "${want.boxSource}"`);
        }
        for (const a of op.absent) check(!rows.some((x) => x.label.toLowerCase() === a.toLowerCase()), `ledger unexpectedly has "${a}"`);
        return `ledger: ${rows.map((r) => `${r.label}@${r.zone}[${r.status}/${r.boxSource}]`).join(", ") || "empty"}`;
      }
      case "expectIngest": {
        // state syncs asynchronously; wait until it matches or time out
        const ok = () => {
          const s = client.state?.ingest;
          if (!s) return false;
          if (op.accepted !== undefined && s.accepted !== op.accepted) return false;
          if (op.dropped !== undefined && s.dropped !== op.dropped) return false;
          for (const [k, v] of Object.entries(op.reasons ?? {})) if ((s.reasons[k] ?? 0) !== v) return false;
          return true;
        };
        await client.waitFor(ok, 8000, `ingest counters ${JSON.stringify({ accepted: op.accepted, dropped: op.dropped, reasons: op.reasons })}`).catch(() => {
          throw new AssertionFailed(`ingest counters are ${JSON.stringify(client.state?.ingest)}, expected ${JSON.stringify({ accepted: op.accepted, dropped: op.dropped, reasons: op.reasons })}`);
        });
        for (const [k, v] of Object.entries(op.phoneDrops ?? {})) check((filter.drops[k] ?? 0) === v, `phone-side drops "${k}" = ${filter.drops[k] ?? 0}, expected ${v}`);
        return `ingest ${JSON.stringify(client.state?.ingest)} phoneDrops ${JSON.stringify(filter.drops)}`;
      }
    }
  }

  const steps: StepResult[] = [];
  let ok = true;
  for (const [i, op] of sc.steps.entries()) {
    try {
      const detail = await step(op);
      steps.push({ index: i, op: op.op, ok: true, detail });
      log(`  ✓ ${i + 1}. ${op.op}: ${detail}`);
    } catch (e) {
      ok = false;
      const detail = e instanceof Error ? e.message : String(e);
      steps.push({ index: i, op: op.op, ok: false, detail });
      log(`  ✗ ${i + 1}. ${op.op}: ${detail}`);
      break; // later steps depend on earlier ones
    }
  }
  bridge.dispose();
  client.close();
  return { name: sc.name, device, ok, steps };
}
