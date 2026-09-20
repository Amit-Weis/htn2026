import { getAgentByName, routeAgentRequest } from "agents";
import type { Env } from "./env";
import { isMockOmni } from "./omni";

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, service: "lastseen", mockOmni: isMockOmni(env) });
    }

    if (url.pathname.startsWith("/api/") && !authorized(request, env)) return deny();

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
