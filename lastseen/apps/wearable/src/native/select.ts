import { mockPlugins } from "./mock";
import type { NativeProbeResult } from "./capacitor";
import type { DetectorPlugin, HardwareKeys, HeadPosePlugin, PluginKind, PluginMode, Plugins, PosePlugin } from "./types";
import { WebDetector, WebHeadPose, WebKeys, WebPose, isNativeWebView } from "./web";
import type { WebDetectorOptions } from "./web";

export type Force = "auto" | "mock" | "web";

interface Probeable<T> {
  plugin: T;
  probe(): Promise<NativeProbeResult>;
}

/** What the Capacitor layer offers; injected so selection can be tested without a device. */
export interface NativeBundle {
  detector: Probeable<DetectorPlugin>;
  pose: Probeable<PosePlugin>;
  head: Probeable<HeadPosePlugin>;
  keys: Probeable<HardwareKeys>;
}

export interface SelectOptions {
  /** default: detect the Capacitor native shell */
  isNative?: boolean;
  /** `?mode=mock|web` in the URL, for desktop development */
  force?: Force;
  web?: WebDetectorOptions;
  loadNative?: () => Promise<NativeBundle>;
}

export interface SelectionReport {
  kind: PluginKind;
  mode: PluginMode;
  note: string;
}

export interface Selection {
  plugins: Plugins;
  report: SelectionReport[];
}

async function defaultLoadNative(): Promise<NativeBundle> {
  const c = await import("./capacitor");
  const [d, p, h, k] = [new c.NativeDetectorPlugin(), new c.NativePosePlugin(), new c.NativeHeadPosePlugin(), new c.NativeKeysPlugin()];
  return {
    detector: { plugin: d, probe: () => c.probeNative(d.api) },
    pose: { plugin: p, probe: () => c.probeNative(p.api) },
    head: { plugin: h, probe: () => c.probeNative(h.api) },
    keys: { plugin: k, probe: () => c.probeNative(k.api) },
  };
}

/**
 * Per plugin: native when running in the Capacitor shell AND the Kotlin plugin answers ping();
 * otherwise a fallback. The detector's fallback is the (silent) mock, NEVER the web detector inside the
 * native WebView, because the WebView must not open the camera. Pose/head/keys may fall back to the web
 * versions (sensors and keyboards are harmless there).
 */
export async function selectPlugins(opts: SelectOptions = {}): Promise<Selection> {
  const isNative = opts.isNative ?? isNativeWebView();
  const force = opts.force ?? "auto";
  const mocks = mockPlugins();
  const report: SelectionReport[] = [];
  const note = (kind: PluginKind, mode: PluginMode, n: string) => report.push({ kind, mode, note: n });

  if (force === "mock") {
    (["Detector", "Pose", "HeadPose", "Keys"] as const).forEach((k) => note(k, "mock", "forced by ?mode=mock"));
    return { plugins: mocks, report };
  }

  const web = {
    detector: new WebDetector(opts.web),
    pose: new WebPose(),
    head: new WebHeadPose(),
    keys: new WebKeys(),
  };

  if (!isNative || force === "web") {
    note("Detector", "web", "browser frame-diff fallback (no object detector)");
    note("Pose", "web", "DeviceOrientation + accelerometer");
    note("HeadPose", "web", "arrow keys simulate head yaw");
    note("Keys", "web", "keyboard: Space = PTT, N = narrate, hold M = recenter");
    return { plugins: web, report };
  }

  const native = await (opts.loadNative ?? defaultLoadNative)();
  const pick = async <T>(kind: PluginKind, n: Probeable<T>, fallback: T, fallbackMode: PluginMode, fallbackWhy: string): Promise<T> => {
    const r = await n.probe();
    if (r.ok) {
      note(kind, "native", `native plugin v${r.version}`);
      return n.plugin;
    }
    note(kind, fallbackMode, `${r.note}; ${fallbackWhy}`);
    return fallback;
  };

  return {
    plugins: {
      detector: await pick("Detector", native.detector, mocks.detector, "mock", "no detector running (the WebView never opens the camera)"),
      pose: await pick("Pose", native.pose, web.pose, "web", "using WebView DeviceOrientation"),
      head: await pick("HeadPose", native.head, mocks.head, "mock", "chest heading only"),
      keys: await pick("Keys", native.keys, web.keys, "web", "keyboard events only"),
    },
    report,
  };
}
