import { HttpIngestSchema, HttpQuerySchema, PlacementCandidateSchema } from "@lastseen/shared";
import type { HttpQuery, PlacementCandidate } from "@lastseen/shared";

/** Largest request body accepted by the HTTP API (a candidate is up to 6 keyframes + a still + a stereo pair, all base64). */
export const MAX_BODY_BYTES = 12 * 1024 * 1024;
export const DEFAULT_DEVICE = "default";
const DEVICE_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Longest an /api/ingest?wait= request is held open. */
export const MAX_WAIT_MS = 25_000;

export type Parsed<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

/** Device id from `?device=` or the `X-Device-Id` header; falls back to "default" so a single-phone demo needs no config. */
export function deviceOf(url: URL, headers: Headers): Parsed<string> {
  const d = url.searchParams.get("device") ?? headers.get("X-Device-Id") ?? DEFAULT_DEVICE;
  return DEVICE_RE.test(d) ? { ok: true, value: d } : { ok: false, status: 400, error: "device must match [A-Za-z0-9_-]{1,64}" };
}

/** `?wait=1` holds an ingest open up to MAX_WAIT_MS; `?wait=<ms>` up to that many ms; anything else is 0. */
export function waitOf(url: URL): number {
  const w = url.searchParams.get("wait");
  if (w === null) return 0;
  if (w === "1" || w === "true") return MAX_WAIT_MS;
  const n = Number(w);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_WAIT_MS) : 0;
}

export async function readJson(request: Request): Promise<Parsed<unknown>> {
  const len = Number(request.headers.get("Content-Length") ?? 0);
  if (len > MAX_BODY_BYTES) return { ok: false, status: 413, error: `body larger than ${MAX_BODY_BYTES} bytes` };
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, status: 400, error: "could not read the body" };
  }
  if (text.length > MAX_BODY_BYTES) return { ok: false, status: 413, error: `body larger than ${MAX_BODY_BYTES} bytes` };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: "body is not valid JSON" };
  }
}

const issues = (e: { issues: Array<{ path: PropertyKey[]; message: string }> }) =>
  e.issues.slice(0, 5).map((i) => `${i.path.map(String).join(".") || "(body)"}: ${i.message}`).join("; ");

/** A placement candidate as sent over HTTP: the WebSocket message minus its `type` tag (a `type` is tolerated and ignored). */
export function parseIngest(json: unknown): Parsed<PlacementCandidate> {
  const body = json && typeof json === "object" ? { ...(json as Record<string, unknown>) } : json;
  if (body && typeof body === "object") delete (body as Record<string, unknown>).type;
  const r = HttpIngestSchema.safeParse(body);
  if (!r.success) return { ok: false, status: 400, error: `invalid candidate: ${issues(r.error)}` };
  return { ok: true, value: PlacementCandidateSchema.parse({ type: "placement_candidate", ...r.data }) };
}

export function parseQuery(json: unknown): Parsed<HttpQuery> {
  const r = HttpQuerySchema.safeParse(json);
  return r.success ? { ok: true, value: r.data } : { ok: false, status: 400, error: `invalid query: ${issues(r.error)}` };
}
