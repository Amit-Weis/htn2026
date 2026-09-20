import { startApp } from "../app";
import type { AppConfig } from "../config";
import { checkWorkerUrl, resolveSettings } from "../settingsStore";
import { button, h, injectStyle } from "../ui";

/**
 * The wearer app (HUD + native plugin bridge). It is started from a button press because the camera, microphone and
 * sensor permissions need a user gesture.
 * Query: `?host=&device=&token=` (see settingsStore.ts), `&mode=mock|web`, `&dev=1`, `&hfov=`, `&camera=`, and
 * `&autostart=1` (only with mode=mock, for headless smoke tests). Without `host` the page's own origin is used, which is the
 * Worker when the page is served by it.
 */
export function mountHud(root: HTMLElement): void {
  injectStyle();
  const q = new URLSearchParams(location.search);
  const defaults = resolveSettings(q);
  const settings = defaults.workerUrl ? defaults : { ...defaults, workerUrl: location.host };
  const w = checkWorkerUrl(settings.workerUrl);
  const mode = q.get("mode");

  const start = async () => {
    if (!w.ok) return;
    const cfg: AppConfig = {
      host: w.host,
      device: settings.deviceId,
      token: settings.deviceToken,
      hfovDeg: Number(q.get("hfov") ?? 70),
      stepLengthM: 0.7,
      force: mode === "mock" || mode === "web" ? mode : "auto",
      cameraId: q.get("camera") ?? undefined,
      dev: q.get("dev") === "1",
    };
    const hud = h("div", { id: "hud" });
    root.replaceChildren(hud);
    try {
      await startApp(cfg, hud);
    } catch (e) {
      root.replaceChildren(h("div", "page", h("h1", null, "HUD failed to start"), h("pre", null, String(e))));
    }
  };

  root.append(
    h("div", "page",
      h("h1", null, "Lastseen"),
      w.ok ? h("div", "sub", `Worker ${w.host} · device ${settings.deviceId}`) : h("div", "sub", `Worker URL unusable: ${w.error}. Add ?host=<worker>&token=<token> to the URL.`),
      h("div", "row", button("Start HUD", start, "primary")),
      h("div", "sub", "In a desktop browser: Space = talk, N = narrate a placement, hold M = recenter, ←/→ = fake head turn."),
    ),
  );
  if (q.get("autostart") === "1" && mode === "mock") queueMicrotask(() => void start());
}
