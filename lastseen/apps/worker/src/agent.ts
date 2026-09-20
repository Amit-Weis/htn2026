import { Agent } from "agents";
import type { Connection, WSMessage } from "agents";
import { INITIAL_STATE, formatAge, parseClientMessage } from "@lastseen/shared";
import type { ClientMessage, Frame, PlacementCandidate, ServerMessage, Trace, TrackerState } from "@lastseen/shared";
import { ingestConfig } from "./config";
import type { Env } from "./env";
import { num } from "./env";
import { ImagesCropper, NoCropper, PassthroughCropper } from "./ingest/crop";
import type { Cropper } from "./ingest/crop";
import { describeCrop, extract, intake, reconcile } from "./ingest/pipeline";
import type { IngestConfig, IngestDeps, ReconcileSummary, TraceInput } from "./ingest/pipeline";
import { Ledger, nid } from "./ledger";
import type { SqlTag } from "./ledger";
import { LocalEmbedder, WorkersAiEmbedder } from "./memory/embed";
import type { Embedder } from "./memory/embed";
import { SqlVectorStore, VectorizeStore } from "./memory/vectors";
import type { VectorStore } from "./memory/vectors";
import { BudgetExceededError, budgetGuard, createOmni, isMockOmni } from "./omni";
import type { AudioClip, HistoryItem, OmniClient } from "./omni";
import { forget as forgetTool, runTool } from "./tools";
import type { ToolHost } from "./tools";

type Role = "wearable" | "dashboard" | "sim";
interface ConnState {
  role: Role;
  version: 1 | 2;
}

const MAX_STEPS = 4;
const FRAME_REQUEST_TIMEOUT_MS = 4000;
const CLARIFY_TTL_MS = 60_000;

export class TrackerAgent extends Agent<Env, TrackerState> {
  override initialState: TrackerState = INITIAL_STATE;

  private ledger!: Ledger;
  private omni!: OmniClient;
  private embedder!: Embedder;
  private vectors!: VectorStore;
  private cropper!: Cropper;
  private ingestCfg!: IngestConfig;

  private readonly pendingFrames = new Map<string, (f: Frame | null) => void>();
  private readonly cancelled = new Set<string>();
  private activeTurn: string | null = null;

  /** State is server-owned: clients talk to the agent through messages, never setState. */
  override validateStateChange(_next: TrackerState, source: Connection | "server") {
    if (source !== "server") throw new Error("state is server-owned");
  }

  override async onStart() {
    const sql: SqlTag = (s, ...v) => this.sql(s, ...v) as never;
    this.ledger = new Ledger(sql);
    this.ingestCfg = ingestConfig(this.env);
    this.omni = createOmni(this.env);
    const mock = isMockOmni(this.env);
    const vectorize = this.env.USE_VECTORIZE === "1" && !!this.env.VECTORS;
    this.embedder = vectorize ? new WorkersAiEmbedder(this.env.AI) : new LocalEmbedder();
    this.vectors = vectorize ? new VectorizeStore(this.env.VECTORS, this.name) : new SqlVectorStore(this.ledger);
    this.cropper = this.env.IMAGES ? new ImagesCropper(this.env.IMAGES) : mock ? new PassthroughCropper() : new NoCropper();
    // mock mode crops by passthrough so the crop path is exercised offline
    if (mock) this.cropper = new PassthroughCropper();

    const capCad = num(this.env.OMNI_BUDGET_CAP_CAD, 30);
    if (this.state.budget.capCad !== capCad) this.setState({ ...this.state, budget: { ...this.state.budget, capCad } });
    await this.scheduleEvery(600, "purgeExpired"); // retention purge; idempotent across restarts
  }

  // ------------------------------------------------------------------ plumbing

  private now = () => Date.now();

  private connState(c: Connection): ConnState | undefined {
    return (c.state as ConnState | null | undefined) ?? undefined;
  }

  /** Deliver to connections by role (v1 connections get `reply` instead of `speak`). */
  private send(roles: Role[] | "all", msg: ServerMessage) {
    for (const c of this.getConnections()) {
      const cs = this.connState(c);
      if (roles !== "all" && (!cs || !roles.includes(cs.role))) continue;
      this.sendOne(c, msg);
    }
  }

  private sendOne(c: Connection, msg: ServerMessage) {
    const v1 = this.connState(c)?.version === 1;
    const out: ServerMessage = v1 && msg.type === "speak" ? { type: "reply", text: msg.text, audioB64: msg.audioB64, mime: msg.mime } : msg;
    if (v1 && !["reply", "trace", "ledger", "error", "stop_audio", "request_frame", "capture_now"].includes(out.type)) return;
    c.send(JSON.stringify(out));
  }

  private hasRole(role: Role): boolean {
    for (const c of this.getConnections()) if (this.connState(c)?.role === role) return true;
    return false;
  }

  private patch(p: Partial<TrackerState>) {
    this.setState({ ...this.state, ...p });
  }

  private emitTrace = (t: TraceInput) => {
    const tr: Trace = { id: nid("t"), ts: this.now(), ...t };
    this.ledger.addTrace(tr);
    this.send(["dashboard", "sim"], { type: "trace", trace: tr });
  };

  private notifyLedger = () => {
    this.send(["dashboard", "sim"], { type: "ledger", objects: this.ledger.listObjects().map((o) => this.ledger.toRow(o, this.name)) });
  };

  private bumpStats(accepted: boolean, reason?: string) {
    const s = this.state.ingest;
    this.patch({
      ingest: {
        accepted: s.accepted + (accepted ? 1 : 0),
        dropped: s.dropped + (accepted ? 0 : 1),
        reasons: accepted || !reason ? s.reasons : { ...s.reasons, [reason]: (s.reasons[reason] ?? 0) + 1 },
      },
    });
  }

  private ingestDeps(): IngestDeps {
    return {
      ledger: this.ledger,
      omni: this.omni,
      embedder: this.embedder,
      vectors: this.vectors,
      cropper: this.cropper,
      cfg: this.ingestCfg,
      now: this.now,
      currentPose: () => this.state.pose,
      emitTrace: this.emitTrace,
    };
  }

  /** Mirror the KV spend estimate into synced state so the dashboard shows the running budget. */
  private async refreshBudget() {
    if (isMockOmni(this.env)) return;
    const s = await budgetGuard(this.env).read();
    this.patch({ budget: { spentCad: s.cad, capCad: this.state.budget.capCad } });
  }

  // ------------------------------------------------------------------ connection + messages

  override async onMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== "string") return;
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      return this.sendOne(connection, { type: "error", message: "invalid json" });
    }
    const parsed = parseClientMessage(raw, { nowMs: this.now(), pose: this.state.pose, hfovDeg: this.ingestCfg.defaultHfovDeg });
    if (!parsed.ok) return this.sendOne(connection, { type: "error", message: `invalid message: ${parsed.error}` });
    const m = parsed.msg;

    if (m.type === "hello") {
      connection.setState({ role: m.role, version: parsed.version } satisfies ConnState);
      this.sendOne(connection, parsed.version === 1
        ? { type: "reply", text: `hello ${m.role} from TrackerAgent ${this.name}` }
        : { type: "notice", level: "info", message: `hello ${m.role} from TrackerAgent ${this.name} (contract v2)` });
      if (m.role !== "wearable") {
        this.sendOne(connection, { type: "ledger", objects: this.ledger.listObjects().map((o) => this.ledger.toRow(o, this.name)) });
        for (const t of this.ledger.recentTraces(60).reverse()) this.sendOne(connection, { type: "trace", trace: t });
      }
      return;
    }
    await this.handle(m);
  }

  private async handle(m: ClientMessage): Promise<void> {
    switch (m.type) {
      case "pose": {
        const { type: _t, ...pose } = m;
        this.ledger.logPose(pose);
        this.patch({ pose });
        return;
      }
      case "status":
        return this.patch({ status: m.status });
      case "set_recording":
        return this.patch({ recording: m.on });
      case "ledger_request":
        return this.notifyLedger();
      case "force_capture":
        return this.send(["wearable"], { type: "capture_now" });
      case "remote_ptt":
        return this.send(["wearable"], { type: "remote_ptt", action: m.action });
      case "frame_response": {
        this.pendingFrames.get(m.requestId)?.(m.frame);
        return;
      }
      case "cancel":
        return this.cancelTurn(m.turnId);
      case "forget": {
        const r = await forgetTool(this.toolHost(), m.target);
        return this.send(["dashboard", "sim"], { type: "notice", level: "info", message: `forgot ${String(r.forgotten)} object(s)` });
      }
      case "placement_candidate":
        return this.onCandidate(m);
      case "utterance":
        return this.startTurn({ turnId: m.turnId, audio: { b64: m.audioB64, mime: m.mime }, frame: m.frame, poseT: m.poseAtT });
      case "query":
        return this.startTurn({ turnId: m.turnId ?? nid("q"), text: m.text });
      case "hello":
        return;
    }
  }

  // ------------------------------------------------------------------ ingest

  private async onCandidate(c: PlacementCandidate) {
    const r = intake(this.ingestDeps(), c);
    this.bumpStats(r.accepted, r.accepted ? undefined : r.reason);
    if (!r.accepted) return;
    try {
      await this.runWorkflow("INGEST_WORKFLOW", { candidateId: r.candidateId });
    } catch (e) {
      // Workflows unavailable (e.g. a local runtime without them): run the same steps inline.
      this.emitTrace({ turnId: r.candidateId, step: 0, kind: "system", tool: "workflow_fallback", args: {}, result: { error: e instanceof Error ? e.message : String(e) }, latencyMs: null, costCad: 0 });
      const ex = await this.ingestExtract(r.candidateId);
      await this.ingestDescribeCrop(r.candidateId);
      const sum = await this.ingestReconcile(r.candidateId);
      await this.ingestNotify(r.candidateId, ex.skipped, sum);
    }
  }

  // RPC entry points called by IngestPlacementWorkflow (each idempotent, small JSON in/out)
  async ingestExtract(candidateId: string) {
    const r = await extract(this.ingestDeps(), candidateId);
    await this.refreshBudget();
    return r;
  }
  async ingestDescribeCrop(candidateId: string) {
    return describeCrop(this.ingestDeps(), candidateId);
  }
  async ingestReconcile(candidateId: string) {
    return reconcile(this.ingestDeps(), candidateId);
  }
  async ingestNotify(candidateId: string, skipped?: string, summary?: ReconcileSummary) {
    if (skipped && skipped !== "missing") this.bumpStats(false, skipped);
    this.notifyLedger();
    this.emitTrace({ turnId: candidateId, step: 0, kind: "ingest", tool: "notify", args: {}, result: { skipped: skipped ?? null, objects: summary?.objectIds ?? [] }, latencyMs: null, costCad: 0 });
    return { ok: true };
  }

  /** Serves thumbnails through the gateway (`/api/frames/<device>/<id>`). */
  async getFrameJpeg(frameId: string): Promise<string | null> {
    return this.ledger.getFrameJpeg(frameId);
  }

  /** Scheduled: delete anything older than RETENTION_HOURS (ledger rows, thumbnails, vectors). */
  async purgeExpired() {
    const cutoff = this.now() - num(this.env.RETENTION_HOURS, 24) * 3_600_000;
    const r = this.ledger.purge(cutoff);
    await this.vectors.remove(r.objects).catch(() => undefined);
    if (r.objects.length) this.notifyLedger();
  }

  // ------------------------------------------------------------------ turns (the agent loop)

  private toolHost(): ToolHost {
    return {
      ledger: this.ledger,
      embedder: this.embedder,
      vectors: this.vectors,
      omni: this.omni,
      device: this.name,
      now: this.now,
      pose: () => this.state.pose,
      target: () => this.state.target,
      setTarget: (target) => this.patch({ target }),
      requestFrame: () => this.requestFrame(),
      sendRecenter: () => this.send(["wearable"], { type: "recenter" }),
      notifyLedger: this.notifyLedger,
      cfg: { maxRangeM: num(this.env.MAX_RANGE_M, 15), minConfidence: num(this.env.MIN_CONFIDENCE, 0.35), hfovDeg: num(this.env.CAMERA_HFOV_DEG, 70) },
      spent: () => this.refreshBudget(),
    };
  }

  private requestFrame(): Promise<Frame | null> {
    if (!this.hasRole("wearable") && !this.hasRole("sim")) return Promise.resolve(null);
    const requestId = nid("rf");
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingFrames.delete(requestId);
        resolve(null);
      }, FRAME_REQUEST_TIMEOUT_MS);
      this.pendingFrames.set(requestId, (f) => {
        clearTimeout(timer);
        this.pendingFrames.delete(requestId);
        resolve(f);
      });
      this.send(["wearable", "sim"], { type: "request_frame", requestId });
    });
  }

  private cancelTurn(turnId: string) {
    const id = turnId === "*" ? this.activeTurn : turnId;
    if (id) this.cancelled.add(id);
    this.patch({ status: "idle" });
    this.send(["wearable"], { type: "stop_audio" });
  }

  private memorySummary(poseAtT?: TrackerState["pose"]): string {
    const pose = poseAtT ?? this.state.pose;
    const zone = this.ledger.nearestZone(pose.x, pose.y) ?? "unknown";
    const recent = this.ledger.recent(5).map((o) => `- ${o.label}${o.zone ? ` @${o.zone}` : ""}, ${formatAge((this.now() - o.lastSeenAt) / 1000)} [${o.status}]`);
    const tgt = this.state.target ? ` target=${this.state.target.objectId}` : "";
    return `Current zone: ${zone}.${tgt}\nRecent objects:\n${recent.join("\n") || "(none yet)"}`;
  }

  private async startTurn(t: { turnId: string; audio?: AudioClip; text?: string; frame?: Frame; poseT?: TrackerState["pose"] }) {
    if (this.activeTurn && this.activeTurn !== t.turnId) this.cancelled.add(this.activeTurn); // barge-in
    this.activeTurn = t.turnId;
    this.cancelled.delete(t.turnId);
    this.patch({ status: "thinking" });
    try {
      await this.runTurn(t);
    } catch (e) {
      this.emitTrace({ turnId: t.turnId, step: 0, kind: "system", tool: "turn_failed", args: {}, result: { error: e instanceof Error ? e.message : String(e) }, latencyMs: null, costCad: 0 });
      this.send(["wearable", "dashboard", "sim"], { type: "notice", level: "error", message: "The assistant hit an error; please try again." });
      if (!this.cancelled.has(t.turnId)) this.patch({ status: "idle" });
    } finally {
      if (this.activeTurn === t.turnId) this.activeTurn = null;
      this.cancelled.delete(t.turnId);
    }
  }

  private async runTurn(t: { turnId: string; audio?: AudioClip; text?: string; frame?: Frame; poseT?: TrackerState["pose"] }) {
    const history: HistoryItem[] = [];
    const pend = this.ledger.getKv<{ question: string; transcript: string; t: number }>("clarify");
    if (pend && this.now() - pend.t < CLARIFY_TTL_MS) {
      history.push({ role: "user", content: pend.transcript }, { role: "assistant", content: pend.question });
    }
    this.ledger.setKv("clarify", null);

    const host = this.toolHost();
    const latestFrame = t.frame?.jpegBase64 ? { b64: t.frame.jpegBase64 } : undefined;

    for (let step = 0; step < MAX_STEPS; step++) {
      if (this.cancelled.has(t.turnId)) return;
      let res;
      try {
        res = await this.omni.understandUtterance(step === 0 ? (t.audio ?? null) : null, { latestFrame, memorySummary: this.memorySummary(t.poseT), history, text: t.text });
      } catch (e) {
        if (e instanceof BudgetExceededError) return this.say(t.turnId, "My OMNI budget is used up, so I can't answer right now.");
        throw e;
      }
      await this.refreshBudget();
      const s = res.value;
      this.emitTrace({ turnId: t.turnId, step, kind: "omni", tool: "understandUtterance", args: { audio: step === 0 && Boolean(t.audio), text: t.text ?? null }, result: s.type === "tool" ? { addressed: s.addressed, transcript: s.transcript, tool: s.tool, args: s.args } : { addressed: s.addressed, transcript: s.transcript, final: s.text }, latencyMs: res.latencyMs, costCad: res.costCad });
      if (this.cancelled.has(t.turnId)) return;

      if (!s.addressed) {
        this.patch({ status: "idle" }); // ambient chatter: ignored
        return;
      }
      if (step === 0) history.push({ role: "user", content: s.transcript ?? t.text ?? "" });

      if (s.type === "final") return this.say(t.turnId, s.text);

      const t0 = this.now();
      const result = await runTool(host, s.tool, s.args);
      this.emitTrace({ turnId: t.turnId, step, kind: "tool", tool: s.tool, args: s.args, result, latencyMs: this.now() - t0, costCad: 0 });
      history.push({ role: "tool", content: JSON.stringify({ tool: s.tool, args: s.args, result }) });

      if (s.tool === "clarify") {
        const question = String((result as { question?: string }).question ?? "Which one do you mean?");
        this.ledger.setKv("clarify", { question, transcript: s.transcript ?? t.text ?? "", t: this.now() });
        return this.say(t.turnId, question);
      }
    }
    return this.say(t.turnId, "Sorry, I couldn't work that out.");
  }

  /** Voice second: the HUD target (if any) has already been pushed by the tool. */
  private async say(turnId: string, text: string) {
    if (this.cancelled.has(turnId)) return;
    this.patch({ status: "speaking", lastReply: text });
    let audio: AudioClip | null = null;
    if (text) {
      try {
        const r = await this.omni.speak(text);
        audio = r.value;
        await this.refreshBudget();
      } catch (e) {
        if (!(e instanceof BudgetExceededError)) throw e;
      }
    }
    if (this.cancelled.has(turnId)) return;
    this.emitTrace({ turnId, step: 99, kind: "final", tool: null, args: {}, result: { text, audio: Boolean(audio) }, latencyMs: null, costCad: 0 });
    this.send(["wearable", "sim"], { type: "speak", turnId, text, audioB64: audio?.b64, mime: audio?.mime });
    if (!this.hasRole("wearable")) this.patch({ status: "idle" }); // no phone to report playback end
  }
}
