/**
 * Where the HUD gets its Worker URL, device id and token. Nothing here is stored on the device and no secret is in source:
 * URL query params win (`?host=...&device=...&token=...`), then BUILD-TIME env (`VITE_WORKER_URL`, `VITE_DEVICE_ID`,
 * `VITE_DEVICE_TOKEN` in an untracked apps/wearable/.env.local).
 */
export interface Settings {
  workerUrl: string;
  deviceId: string;
  deviceToken: string;
}

interface BuildEnv {
  VITE_WORKER_URL?: string;
  VITE_DEVICE_ID?: string;
  VITE_DEVICE_TOKEN?: string;
}

export function buildDefaults(env: BuildEnv = import.meta.env as BuildEnv): Settings {
  return {
    workerUrl: env.VITE_WORKER_URL ?? "",
    deviceId: env.VITE_DEVICE_ID ?? "demo",
    deviceToken: env.VITE_DEVICE_TOKEN ?? "",
  };
}

/** Query params over build defaults. `host` may be a bare host or a full URL (see [checkWorkerUrl]). */
export function resolveSettings(query: URLSearchParams, defaults: Settings = buildDefaults()): Settings {
  return {
    workerUrl: query.get("host") ?? defaults.workerUrl,
    deviceId: query.get("device") ?? defaults.deviceId,
    deviceToken: query.get("token") ?? defaults.deviceToken,
  };
}

export type UrlCheck = { ok: true; origin: string; host: string } | { ok: false; error: string };

/**
 * Accepts "worker.example.dev", "https://worker.example.dev/", "wss://worker.example.dev/anything".
 * Cleartext is refused except for localhost/127.0.0.1 so a desktop dev server still works.
 */
export function checkWorkerUrl(input: string): UrlCheck {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "enter the Worker URL" };
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:"));
  } catch {
    return { ok: false, error: "not a valid URL" };
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol === "http:" && !local) return { ok: false, error: "cleartext http is not allowed; use https" };
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: "use an https URL" };
  return { ok: true, origin: u.origin, host: u.host };
}

/** wss://host/agents/tracker-agent/<device>?token=...  (the token goes in the query: browsers cannot set WebSocket headers). */
export function agentSocketUrl(s: Settings): string {
  const c = checkWorkerUrl(s.workerUrl);
  if (!c.ok) throw new Error(c.error);
  const scheme = c.origin.startsWith("https:") ? "wss:" : "ws:";
  return `${scheme}//${c.host}/agents/tracker-agent/${encodeURIComponent(s.deviceId || "demo")}?token=${encodeURIComponent(s.deviceToken)}`;
}

/** The token must never appear in logs or on screen. */
export function redactUrl(url: string): string {
  return url.replace(/token=[^&]*/i, "token=***");
}
