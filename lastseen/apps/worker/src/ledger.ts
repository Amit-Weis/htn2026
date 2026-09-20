import type { Detection, ObjectRow, Pose, PosSource, Trace } from "@lastseen/shared";

/** Tagged-template SQL, matching the Agents SDK's `this.sql`. Tests plug in node:sqlite. */
export type SqlTag = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

type Box = [number, number, number, number];
export type BoxSource = "detector" | "omni" | "none";
export type ObjectStatus = "placed" | "held" | "moved" | "forgotten";

export interface ObjectRecord {
  id: string;
  label: string;
  description: string;
  features: string[];
  status: ObjectStatus;
  x: number | null;
  y: number | null;
  zone: string | null;
  lastSeenAt: number;
  confidence: number;
  frameId: string | null;
  box: Box | null;
  boxSource: BoxSource;
  /** height relative to the camera at placement (m, + up); null unless measured with stereo depth */
  z?: number | null;
  posSource?: PosSource;
}

export interface CandidateRecord {
  id: string;
  t: number;
  trigger: string;
  status: "queued" | "extracted" | "described" | "done" | "failed";
  meta: Record<string, unknown>;
  result: unknown;
}

export interface FrameRecord {
  id: string;
  candidateId: string;
  idx: number;
  t: number;
  w: number;
  h: number;
  hash: string | null;
  detections: Detection[] | null;
  jpeg: string;
  isStill: boolean;
}

export const POSE_LOG_KEEP_MS = 10 * 60 * 1000;

export const nid = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

const j = (v: unknown) => JSON.stringify(v ?? null);
const p = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== "string") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

interface ObjectSql {
  id: string;
  label: string;
  description: string;
  features: string;
  status: string;
  x: number | null;
  y: number | null;
  zone: string | null;
  last_seen_at: number;
  confidence: number;
  frame_id: string | null;
  box: string | null;
  box_source: string;
  z?: number | null;
  pos_source?: string | null;
}

const toObject = (r: ObjectSql): ObjectRecord => ({
  id: r.id,
  label: r.label,
  description: r.description,
  features: p<string[]>(r.features, []),
  status: r.status as ObjectStatus,
  x: r.x,
  y: r.y,
  zone: r.zone,
  lastSeenAt: r.last_seen_at,
  confidence: r.confidence,
  frameId: r.frame_id,
  box: p<Box | null>(r.box, null),
  boxSource: r.box_source as BoxSource,
  z: r.z ?? null,
  posSource: (r.pos_source as PosSource | null | undefined) ?? "omni",
});

/** All persistent memory of one TrackerAgent: objects, sightings, zones, pose ring buffer, traces, ingest state. */
export class Ledger {
  constructor(private readonly sql: SqlTag) {
    this.init();
  }

  private init() {
    const s = this.sql;
    s`CREATE TABLE IF NOT EXISTS objects (
      id TEXT PRIMARY KEY, label TEXT, description TEXT, features TEXT, status TEXT,
      x REAL, y REAL, zone TEXT, last_seen_at INTEGER, confidence REAL,
      frame_id TEXT, box TEXT, box_source TEXT)`;
    s`CREATE TABLE IF NOT EXISTS sightings (
      id TEXT PRIMARY KEY, object_id TEXT, t INTEGER, kind TEXT, x REAL, y REAL, zone TEXT,
      confidence REAL, frame_id TEXT, box TEXT, box_source TEXT, candidate_id TEXT)`;
    s`CREATE TABLE IF NOT EXISTS zones (name TEXT PRIMARY KEY, x REAL, y REAL, n INTEGER, last_seen_at INTEGER)`;
    s`CREATE TABLE IF NOT EXISTS pose_log (t INTEGER PRIMARY KEY, x REAL, y REAL, heading REAL, steps INTEGER, stationary INTEGER)`;
    s`CREATE TABLE IF NOT EXISTS traces (
      id TEXT PRIMARY KEY, ts INTEGER, turn_id TEXT, step INTEGER, kind TEXT, tool TEXT,
      args TEXT, result TEXT, latency_ms REAL, cost_cad REAL)`;
    s`CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, t INTEGER, trigger TEXT, status TEXT, meta TEXT, result TEXT)`;
    s`CREATE TABLE IF NOT EXISTS frames (
      id TEXT PRIMARY KEY, candidate_id TEXT, idx INTEGER, t INTEGER, w INTEGER, h INTEGER,
      hash TEXT, detections TEXT, jpeg TEXT, is_still INTEGER)`;
    s`CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, mime TEXT, b64 TEXT)`;
    s`CREATE TABLE IF NOT EXISTS vectors (object_id TEXT PRIMARY KEY, vec TEXT)`;
    s`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`;
    // Columns added after the first deploy. SQLite has no ADD COLUMN IF NOT EXISTS: a duplicate column throws, which is fine.
    for (const alter of [() => s`ALTER TABLE objects ADD COLUMN z REAL`, () => s`ALTER TABLE objects ADD COLUMN pos_source TEXT`]) {
      try {
        alter();
      } catch {
        /* already there */
      }
    }
  }

  // ---- kv ----
  getKv<T>(k: string): T | null {
    const r = this.sql<{ v: string }>`SELECT v FROM kv WHERE k = ${k}`[0];
    return r ? p<T | null>(r.v, null) : null;
  }
  setKv(k: string, v: unknown) {
    this.sql`INSERT INTO kv (k, v) VALUES (${k}, ${j(v)}) ON CONFLICT(k) DO UPDATE SET v = excluded.v`;
  }

  // ---- pose ring buffer ----
  logPose(pose: Pose) {
    this.sql`INSERT OR REPLACE INTO pose_log (t, x, y, heading, steps, stationary)
      VALUES (${pose.t}, ${pose.x}, ${pose.y}, ${pose.headingDeg}, ${pose.steps}, ${pose.stationary ? 1 : 0})`;
    this.sql`DELETE FROM pose_log WHERE t < ${pose.t - POSE_LOG_KEEP_MS}`;
  }
  poseCount(): number {
    return this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM pose_log`[0]?.n ?? 0;
  }

  // ---- candidates + frames ----
  createCandidate(id: string, t: number, trigger: string, meta: Record<string, unknown>) {
    this.sql`INSERT INTO candidates (id, t, trigger, status, meta, result) VALUES (${id}, ${t}, ${trigger}, 'queued', ${j(meta)}, NULL)`;
  }
  getCandidate(id: string): CandidateRecord | null {
    const r = this.sql<{ id: string; t: number; trigger: string; status: string; meta: string; result: string | null }>`
      SELECT * FROM candidates WHERE id = ${id}`[0];
    return r ? { id: r.id, t: r.t, trigger: r.trigger, status: r.status as CandidateRecord["status"], meta: p(r.meta, {}), result: p(r.result, null) } : null;
  }
  updateCandidate(id: string, patch: { status?: CandidateRecord["status"]; result?: unknown; meta?: Record<string, unknown> }) {
    if (patch.status !== undefined) this.sql`UPDATE candidates SET status = ${patch.status} WHERE id = ${id}`;
    if (patch.result !== undefined) this.sql`UPDATE candidates SET result = ${j(patch.result)} WHERE id = ${id}`;
    if (patch.meta !== undefined) this.sql`UPDATE candidates SET meta = ${j(patch.meta)} WHERE id = ${id}`;
  }

  putFrame(f: FrameRecord) {
    this.sql`INSERT OR REPLACE INTO frames (id, candidate_id, idx, t, w, h, hash, detections, jpeg, is_still)
      VALUES (${f.id}, ${f.candidateId}, ${f.idx}, ${f.t}, ${f.w}, ${f.h}, ${f.hash}, ${f.detections ? j(f.detections) : null}, ${f.jpeg}, ${f.isStill ? 1 : 0})`;
  }
  framesOf(candidateId: string): FrameRecord[] {
    return this.sql<{
      id: string; candidate_id: string; idx: number; t: number; w: number; h: number;
      hash: string | null; detections: string | null; jpeg: string; is_still: number;
    }>`SELECT * FROM frames WHERE candidate_id = ${candidateId} ORDER BY is_still, idx`.map((r) => ({
      id: r.id, candidateId: r.candidate_id, idx: r.idx, t: r.t, w: r.w, h: r.h, hash: r.hash,
      detections: p<Detection[] | null>(r.detections, null), jpeg: r.jpeg, isStill: r.is_still === 1,
    }));
  }
  getFrameJpeg(id: string): string | null {
    return this.sql<{ jpeg: string }>`SELECT jpeg FROM frames WHERE id = ${id}`[0]?.jpeg ?? null;
  }
  /** Privacy: once a candidate is processed only the frame that became a sighting thumbnail is kept. */
  dropFramesExcept(candidateId: string, keepIds: string[]) {
    for (const f of this.framesOf(candidateId)) if (!keepIds.includes(f.id)) this.sql`DELETE FROM frames WHERE id = ${f.id}`;
    this.sql`DELETE FROM blobs WHERE id = ${"narration:" + candidateId}`;
    this.sql`DELETE FROM blobs WHERE id = ${"stereo:" + candidateId}`;
  }
  deleteFrame(id: string) {
    this.sql`DELETE FROM frames WHERE id = ${id}`;
  }
  putBlob(id: string, mime: string, b64: string) {
    this.sql`INSERT OR REPLACE INTO blobs (id, mime, b64) VALUES (${id}, ${mime}, ${b64})`;
  }
  getBlob(id: string): { mime: string; b64: string } | null {
    return this.sql<{ mime: string; b64: string }>`SELECT mime, b64 FROM blobs WHERE id = ${id}`[0] ?? null;
  }

  // ---- objects + sightings ----
  createObject(o: ObjectRecord) {
    this.sql`INSERT INTO objects (id, label, description, features, status, x, y, zone, last_seen_at, confidence, frame_id, box, box_source, z, pos_source)
      VALUES (${o.id}, ${o.label}, ${o.description}, ${j(o.features)}, ${o.status}, ${o.x}, ${o.y}, ${o.zone}, ${o.lastSeenAt}, ${o.confidence}, ${o.frameId}, ${o.box ? j(o.box) : null}, ${o.boxSource}, ${o.z ?? null}, ${o.posSource ?? "omni"})`;
  }
  updateObject(id: string, o: Partial<Omit<ObjectRecord, "id">>) {
    const cur = this.getObject(id);
    if (!cur) return;
    const n = { ...cur, ...o };
    this.sql`UPDATE objects SET label = ${n.label}, description = ${n.description}, features = ${j(n.features)}, status = ${n.status},
      x = ${n.x}, y = ${n.y}, zone = ${n.zone}, last_seen_at = ${n.lastSeenAt}, confidence = ${n.confidence},
      frame_id = ${n.frameId}, box = ${n.box ? j(n.box) : null}, box_source = ${n.boxSource},
      z = ${n.z ?? null}, pos_source = ${n.posSource ?? "omni"} WHERE id = ${id}`;
  }
  getObject(id: string): ObjectRecord | null {
    const r = this.sql<ObjectSql>`SELECT * FROM objects WHERE id = ${id}`[0];
    return r ? toObject(r) : null;
  }
  /** Non-forgotten objects, most recently seen first. */
  listObjects(): ObjectRecord[] {
    return this.sql<ObjectSql>`SELECT * FROM objects WHERE status != 'forgotten' ORDER BY last_seen_at DESC`.map(toObject);
  }
  recent(limit: number, zone?: string): ObjectRecord[] {
    const all = this.listObjects().filter((o) => !zone || o.zone?.toLowerCase() === zone.toLowerCase());
    return all.slice(0, Math.max(1, limit));
  }
  addSighting(s: { id: string; objectId: string; t: number; kind: string; x: number | null; y: number | null; zone: string | null; confidence: number; frameId: string | null; box: Box | null; boxSource: BoxSource; candidateId: string | null }) {
    this.sql`INSERT INTO sightings (id, object_id, t, kind, x, y, zone, confidence, frame_id, box, box_source, candidate_id)
      VALUES (${s.id}, ${s.objectId}, ${s.t}, ${s.kind}, ${s.x}, ${s.y}, ${s.zone}, ${s.confidence}, ${s.frameId}, ${s.box ? j(s.box) : null}, ${s.boxSource}, ${s.candidateId})`;
  }
  sightingCount(objectId?: string): number {
    const r = objectId
      ? this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM sightings WHERE object_id = ${objectId}`
      : this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM sightings`;
    return r[0]?.n ?? 0;
  }
  /** Returns the ids that were forgotten. */
  forget(target: string): string[] {
    const ids = target === "all" ? this.sql<{ id: string }>`SELECT id FROM objects`.map((r) => r.id) : this.getObject(target) ? [target] : [];
    for (const id of ids) {
      this.sql`DELETE FROM sightings WHERE object_id = ${id}`;
      this.sql`DELETE FROM vectors WHERE object_id = ${id}`;
      this.sql`DELETE FROM frames WHERE id IN (SELECT frame_id FROM objects WHERE id = ${id})`;
      this.sql`DELETE FROM objects WHERE id = ${id}`;
    }
    if (target === "all") {
      this.sql`DELETE FROM zones`;
      this.sql`DELETE FROM frames`;
      this.sql`DELETE FROM blobs`;
      this.sql`DELETE FROM candidates`;
      this.sql`DELETE FROM pose_log`;
    }
    return ids;
  }

  // ---- zones (running centroid of sightings) ----
  touchZone(name: string, x: number, y: number, t: number) {
    const key = name.trim().toLowerCase();
    if (!key) return;
    const z = this.sql<{ x: number; y: number; n: number }>`SELECT x, y, n FROM zones WHERE name = ${key}`[0];
    if (!z) this.sql`INSERT INTO zones (name, x, y, n, last_seen_at) VALUES (${key}, ${x}, ${y}, 1, ${t})`;
    else {
      const n = z.n + 1;
      this.sql`UPDATE zones SET x = ${z.x + (x - z.x) / n}, y = ${z.y + (y - z.y) / n}, n = ${n}, last_seen_at = ${t} WHERE name = ${key}`;
    }
  }
  zoneNames(): string[] {
    return this.sql<{ name: string }>`SELECT name FROM zones ORDER BY last_seen_at DESC`.map((r) => r.name);
  }
  nearestZone(x: number, y: number, maxM = 2.5): string | null {
    let best: { name: string; d: number } | null = null;
    for (const z of this.sql<{ name: string; x: number; y: number }>`SELECT name, x, y FROM zones`) {
      const d = Math.hypot(z.x - x, z.y - y);
      if (d <= maxM && (!best || d < best.d)) best = { name: z.name, d };
    }
    return best?.name ?? null;
  }

  // ---- traces ----
  addTrace(t: Trace) {
    this.sql`INSERT INTO traces (id, ts, turn_id, step, kind, tool, args, result, latency_ms, cost_cad)
      VALUES (${t.id}, ${t.ts}, ${t.turnId}, ${t.step}, ${t.kind}, ${t.tool}, ${j(t.args)}, ${j(t.result)}, ${t.latencyMs}, ${t.costCad})`;
    this.sql`DELETE FROM traces WHERE id IN (SELECT id FROM traces ORDER BY ts DESC LIMIT -1 OFFSET 500)`;
  }
  recentTraces(limit = 100): Trace[] {
    return this.sql<{
      id: string; ts: number; turn_id: string; step: number; kind: string; tool: string | null;
      args: string; result: string; latency_ms: number | null; cost_cad: number;
    }>`SELECT * FROM traces ORDER BY ts DESC LIMIT ${limit}`.map((r) => ({
      id: r.id, ts: r.ts, turnId: r.turn_id, step: r.step, kind: r.kind as Trace["kind"], tool: r.tool,
      args: p(r.args, null), result: p(r.result, null), latencyMs: r.latency_ms, costCad: r.cost_cad,
    }));
  }

  // ---- local vectors (used when Vectorize is off) ----
  putVector(objectId: string, vec: number[]) {
    this.sql`INSERT OR REPLACE INTO vectors (object_id, vec) VALUES (${objectId}, ${j(vec)})`;
  }
  allVectors(): Array<{ id: string; vec: number[] }> {
    return this.sql<{ object_id: string; vec: string }>`SELECT * FROM vectors`.map((r) => ({ id: r.object_id, vec: p<number[]>(r.vec, []) }));
  }
  deleteVector(objectId: string) {
    this.sql`DELETE FROM vectors WHERE object_id = ${objectId}`;
  }

  // ---- retention ----
  /** Delete everything older than `cutoffMs` (epoch ms). Returns counts. */
  purge(cutoffMs: number): { objects: string[]; frames: number } {
    const old = this.sql<{ id: string }>`SELECT id FROM objects WHERE last_seen_at < ${cutoffMs}`.map((r) => r.id);
    for (const id of old) this.forget(id);
    this.sql`DELETE FROM sightings WHERE t < ${cutoffMs}`;
    this.sql`DELETE FROM traces WHERE ts < ${cutoffMs}`;
    this.sql`DELETE FROM candidates WHERE t < ${cutoffMs}`;
    const before = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM frames`[0]?.n ?? 0;
    this.sql`DELETE FROM frames WHERE t < ${cutoffMs}`;
    this.sql`DELETE FROM blobs WHERE id LIKE 'narration:%' AND id NOT IN (SELECT 'narration:' || id FROM candidates)`;
    this.sql`DELETE FROM blobs WHERE id LIKE 'stereo:%' AND id NOT IN (SELECT 'stereo:' || id FROM candidates)`;
    const after = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM frames`[0]?.n ?? 0;
    return { objects: old, frames: before - after };
  }

  toRow(o: ObjectRecord, device: string): ObjectRow {
    return {
      id: o.id,
      label: o.label,
      description: o.description,
      features: o.features,
      status: o.status,
      x: o.x,
      y: o.y,
      zone: o.zone,
      lastSeenAt: o.lastSeenAt,
      confidence: o.confidence,
      thumbUrl: o.frameId ? `/api/frames/${encodeURIComponent(device)}/${o.frameId}` : null,
      box: o.box,
      boxSource: o.boxSource,
      heightM: o.z ?? null,
      posSource: o.posSource ?? "omni",
    };
  }
}
