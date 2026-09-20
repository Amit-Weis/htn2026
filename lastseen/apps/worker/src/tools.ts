import { azimuthDeg, chooseMode, distanceM, objectPosition } from "@lastseen/shared";
import type { Frame, Pose, Target, ToolName } from "@lastseen/shared";
import { z } from "zod";
import { nid } from "./ledger";
import type { Ledger, ObjectRecord } from "./ledger";
import type { Embedder } from "./memory/embed";
import { fuzzyScore } from "./memory/text";
import type { VectorStore } from "./memory/vectors";
import type { OmniClient } from "./omni/types";

export interface ToolHost {
  ledger: Ledger;
  embedder: Embedder;
  vectors: VectorStore;
  omni: OmniClient;
  device: string;
  /** epoch ms */
  now(): number;
  pose(): Pose;
  target(): Target | null;
  /** sets the HUD target and pushes state IMMEDIATELY (arrow first, voice second) */
  setTarget(t: Target | null): void;
  requestFrame(): Promise<Frame | null>;
  sendRecenter(): void;
  notifyLedger(): void;
  cfg: { maxRangeM: number; minConfidence: number; hfovDeg: number };
  /** records an OMNI call made inside a tool (verify_visible) */
  spent(costCad: number): Promise<void>;
}

export type ToolResult = Record<string, unknown>;

const Id = z.object({ objectId: z.string().min(1) });

const ageSec = (host: ToolHost, o: ObjectRecord) => Math.max(0, (host.now() - o.lastSeenAt) / 1000);

const describe = (o: ObjectRecord) => `${o.label}: ${o.description}${o.features.length ? ` (${o.features.join(", ")})` : ""}`;

/** Top-3 candidates: fuzzy label match blended with semantic (embedding) similarity. */
export async function findObject(host: ToolHost, query: string): Promise<ToolResult> {
  const objs = host.ledger.listObjects();
  const sem = new Map<string, number>();
  try {
    for (const m of await host.vectors.query(await host.embedder.embed(query), 5)) sem.set(m.id, m.score);
  } catch {
    /* semantic index unavailable: fuzzy only */
  }
  const scored = objs
    .map((o) => {
      const fuzzy = fuzzyScore(query, `${o.label} ${o.description} ${o.features.join(" ")}`, o.label);
      const s = sem.get(o.id) ?? 0;
      return { o, score: Math.max(fuzzy, s), fuzzy, semantic: s };
    })
    .filter((c) => c.score >= 0.2)
    .sort((a, b) => b.score - a.score || b.o.lastSeenAt - a.o.lastSeenAt)
    .slice(0, 3);
  return {
    candidates: scored.map(({ o, score, fuzzy, semantic }) => ({
      objectId: o.id,
      label: o.label,
      description: o.description,
      zone: o.zone,
      ageSec: Math.round(ageSec(host, o)),
      confidence: Number(o.confidence.toFixed(2)),
      status: o.status,
      score: Number(score.toFixed(3)),
      match: { fuzzy: Number(fuzzy.toFixed(2)), semantic: Number(semantic.toFixed(2)) },
    })),
  };
}

function targetFor(host: ToolHost, o: ObjectRecord): Target | null {
  if (o.x === null || o.y === null) return null;
  const pose = host.pose();
  const dist = distanceM(pose, { x: o.x, y: o.y });
  const confidence = Math.min(1, o.confidence * pose.confidence);
  return {
    objectId: o.id,
    label: o.label,
    x: o.x,
    y: o.y,
    bearingDeg: azimuthDeg(o.x - pose.x, o.y - pose.y),
    zone: o.zone,
    ageSec: ageSec(host, o),
    confidence,
    thumbUrl: o.frameId ? `/api/frames/${encodeURIComponent(host.device)}/${o.frameId}` : null,
    mode: chooseMode(confidence, dist, host.cfg.minConfidence, host.cfg.maxRangeM),
    setAt: host.now(),
  };
}

export function guideTo(host: ToolHost, objectId: string): ToolResult {
  const o = host.ledger.getObject(objectId);
  if (!o) return { ok: false, error: "unknown objectId" };
  const t = targetFor(host, o);
  if (!t) return { ok: false, error: "no known location for that object" };
  host.setTarget(t);
  return {
    ok: true, label: o.label, zone: o.zone, ageSec: Math.round(t.ageSec), mode: t.mode,
    distanceM: Number(distanceM(host.pose(), t).toFixed(1)), held: o.status === "held",
  };
}

/** Ask the phone for a live frame; if the object is there, retarget to the live bearing and record a fresh sighting. */
export async function verifyVisible(host: ToolHost, objectId: string): Promise<ToolResult> {
  const o = host.ledger.getObject(objectId);
  if (!o) return { visible: false, note: "unknown objectId" };
  const frame = await host.requestFrame();
  if (!frame?.jpegBase64) return { visible: false, label: o.label, note: "no camera frame available right now", inconclusive: true };
  const r = await host.omni.verifyVisible({ b64: frame.jpegBase64 }, describe(o));
  await host.spent(r.costCad);
  const t = host.now();

  if (r.value.visible) {
    const box = r.value.bbox;
    const pose = host.pose();
    const cx = box ? box[0] + box[2] / 2 : 0.5;
    const pos = objectPosition(pose, pose.headingDeg, cx, r.value.distance_m, host.cfg.hfovDeg);
    host.ledger.updateObject(o.id, { status: "placed", x: pos.x, y: pos.y, lastSeenAt: t, confidence: Math.min(1, 0.9 * pose.confidence), box: box ?? null, boxSource: box ? "omni" : "none" });
    host.ledger.addSighting({ id: nid("s"), objectId: o.id, t, kind: "verified", x: pos.x, y: pos.y, zone: o.zone, confidence: 0.9, frameId: null, box: box ?? null, boxSource: box ? "omni" : "none", candidateId: null });
    const fresh = host.ledger.getObject(o.id);
    const tgt = fresh ? targetFor(host, fresh) : null;
    if (tgt) host.setTarget(tgt);
    host.notifyLedger();
    return { visible: true, label: o.label, note: r.value.note };
  }

  // Mismatch: the ledger said it was here and it is not. Mark it moved (last known spot is kept for guidance).
  host.ledger.updateObject(o.id, { status: "moved", confidence: o.confidence * 0.5 });
  host.ledger.addSighting({ id: nid("s"), objectId: o.id, t, kind: "not_seen", x: o.x, y: o.y, zone: o.zone, confidence: 0.8, frameId: null, box: null, boxSource: "none", candidateId: null });
  host.notifyLedger();
  return { visible: false, label: o.label, note: r.value.note, ledgerUpdated: "marked moved" };
}

export function listRecent(host: ToolHost, limit: number, zone?: string): ToolResult {
  return {
    items: host.ledger.recent(limit, zone).map((o) => ({
      objectId: o.id, label: o.label, zone: o.zone, ageSec: Math.round(ageSec(host, o)), status: o.status,
    })),
  };
}

export function markMoved(host: ToolHost, objectId: string): ToolResult {
  const o = host.ledger.getObject(objectId);
  if (!o) return { ok: false, error: "unknown objectId" };
  host.ledger.updateObject(objectId, { status: "moved", confidence: o.confidence * 0.5 });
  host.notifyLedger();
  return { ok: true, label: o.label };
}

export async function forget(host: ToolHost, target: string): Promise<ToolResult> {
  const ids = host.ledger.forget(target);
  try {
    await host.vectors.remove(ids);
  } catch {
    /* ledger is authoritative; a stale vector only affects recall ranking */
  }
  if (target === "all" || host.target()?.objectId === target) host.setTarget(null);
  host.notifyLedger();
  return { forgotten: ids.length };
}

/** Dispatch a validated tool call. Bad arguments come back as an error result the model can react to. */
export async function runTool(host: ToolHost, tool: ToolName, args: Record<string, unknown>): Promise<ToolResult> {
  switch (tool) {
    case "find_object": {
      const a = z.object({ query: z.string().min(1) }).safeParse(args);
      return a.success ? findObject(host, a.data.query) : { error: "find_object needs {query}" };
    }
    case "guide_to": {
      const a = Id.safeParse(args);
      return a.success ? guideTo(host, a.data.objectId) : { error: "guide_to needs {objectId}" };
    }
    case "verify_visible": {
      const a = Id.safeParse(args);
      return a.success ? verifyVisible(host, a.data.objectId) : { error: "verify_visible needs {objectId}" };
    }
    case "list_recent": {
      const a = z.object({ limit: z.number().int().min(1).max(10).default(3), zone: z.string().optional() }).safeParse(args);
      return a.success ? listRecent(host, a.data.limit, a.data.zone) : listRecent(host, 3);
    }
    case "mark_moved": {
      const a = Id.safeParse(args);
      return a.success ? markMoved(host, a.data.objectId) : { error: "mark_moved needs {objectId}" };
    }
    case "forget": {
      const a = z.object({ objectId: z.string().min(1) }).safeParse(args);
      return a.success ? forget(host, a.data.objectId) : { error: 'forget needs {objectId | "all"}' };
    }
    case "clarify": {
      const a = z.object({ question: z.string().min(1) }).safeParse(args);
      return a.success ? { question: a.data.question } : { error: "clarify needs {question}" };
    }
    case "recenter":
      host.sendRecenter();
      return { ok: true };
  }
}
