import { getAgentByName, routeAgentRequest } from "agents";
import type { Env } from "./env";
import { deviceOf, parseIngest, parseIntent, parseQuery, readJson, waitOf } from "./httpParse";
import { resolveIntent } from "./intent";
import { createOmni, isMockOmni } from "./omni";

export { TrackerAgent } from "./agent";
export { IngestPlacementWorkflow } from "./workflows/ingest";

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Bearer token from the Authorization header, or ?token= (browsers cannot set WS headers). */
export function authorized(request: Request, env: Env): boolean {
  if (!env.DEVICE_TOKEN) return false; // fail closed
  const header = request.headers.get("Authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
  const token = bearer ?? new URL(request.url).searchParams.get("token");
  return token !== null && timingSafeEqual(token, env.DEVICE_TOKEN);
}

const deny = () => new Response("unauthorized", { status: 401 });
const fail = (status: number, error: string) => Response.json({ error }, { status });

/**
 * HTTP API for clients that do not hold a WebSocket (the Unity app). Same agent, same guards, same memory as the socket:
 *   POST /api/ingest[?wait=1]   a placement candidate (JSON, see HttpIngestSchema) -> {accepted, candidateId, objects?}
 *   POST /api/query             {text | audioB64, poseAtT?, frame?} -> {addressed, text, audioB64?, target}
 *   GET  /api/memory            what the agent remembers (objects, pose, target, ingest stats, recent traces)
 *   POST /api/intent            {text | audioB64} -> {heard, wants, say, source}; stateless: does the wearer ask to be pointed to a
 *                               known object (e.g. "hacker_card")? No device, no memory; the client already knows where it is
 * All take `?device=<id>` (default "default") and the usual bearer token.
 */
async function handleHttpApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  const route = /^\/api\/(ingest|query|memory|intent)$/.exec(url.pathname)?.[1];
  if (!route) return null;
  const want = route === "memory" ? "GET" : "POST";
  if (request.method !== want) return new Response("method not allowed", { status: 405, headers: { Allow: want } });

  if (route === "intent") {
    // stateless: no device, no memory, no agent; one OMNI call (or the keyword rule if OMNI cannot answer)
    const b = await readJson(request);
    if (!b.ok) return fail(b.status, b.error);
    const i = parseIntent(b.value);
    if (!i.ok) return fail(i.status, i.error);
    const audio = i.value.audioB64 ? { b64: i.value.audioB64, mime: i.value.mime ?? "audio/wav" } : null;
    return Response.json(await resolveIntent(createOmni(env), i.value.text, audio));
  }

  const device = deviceOf(url, request.headers);
  if (!device.ok) return fail(device.status, device.error);
  const agent = await getAgentByName(env.TrackerAgent, device.value);

  if (route === "memory") return Response.json(await agent.getMemory());

  const body = await readJson(request);
  if (!body.ok) return fail(body.status, body.error);
  if (route === "ingest") {
    const c = parseIngest(body.value);
    if (!c.ok) return fail(c.status, c.error);
    const r = await agent.httpIngest(c.value, waitOf(url));
    return Response.json(r, { status: r.accepted && r.status !== "done" ? 202 : 200 });
  }
  const q = parseQuery(body.value);
  if (!q.ok) return fail(q.status, q.error);
  return Response.json(await agent.httpQuery(q.value));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, service: "lastseen", mockOmni: isMockOmni(env) });
    }

    if (url.pathname.startsWith("/api/") && !authorized(request, env)) return deny();

    const api = await handleHttpApi(request, env, url);
    if (api) return api;

    // Thumbnails: /api/frames/<device>/<frameId>?token=... (token in the query so <img> works)
    const fm = /^\/api\/frames\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (fm) {
      const agent = await getAgentByName(env.TrackerAgent, decodeURIComponent(fm[1]!));
      const b64 = await agent.getFrameJpeg(fm[2]!);
      if (!b64) return new Response("not found", { status: 404 });
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return new Response(bytes, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" } });
    }

    const routed = await routeAgentRequest(request, env, {
      cors: true,
      onBeforeConnect: (req) => (authorized(req, env) ? undefined : deny()),
      onBeforeRequest: (req) => (authorized(req, env) ? undefined : deny()),
    });
    if (routed) return routed;

    if (url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
