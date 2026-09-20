import { describe, expect, it } from "vitest";
import { MockDetector, MockHeadPose, MockKeys, MockPose } from "./mock";
import { probeNative } from "./capacitor";
import { selectPlugins } from "./select";
import type { NativeBundle } from "./select";
import { WebDetector, averageHash, isNativeWebView } from "./web";
import { DEFAULT_DETECTOR_CONFIG } from "./types";

const ok = () => Promise.resolve({ ok: true as const, version: 1 });
const missing = () => Promise.resolve({ ok: false as const, note: "not implemented natively" });

function bundle(present: { detector?: boolean; pose?: boolean; head?: boolean; keys?: boolean }): NativeBundle {
  return {
    detector: { plugin: new MockDetector(), probe: present.detector ? ok : missing },
    pose: { plugin: new MockPose(), probe: present.pose ? ok : missing },
    head: { plugin: new MockHeadPose(), probe: present.head ? ok : missing },
    keys: { plugin: new MockKeys(), probe: present.keys ? ok : missing },
  };
}
const modes = (s: Awaited<ReturnType<typeof selectPlugins>>) => Object.fromEntries(s.report.map((r) => [r.kind, r.mode]));

describe("plugin auto-selection", () => {
  it("desktop browser: web fallbacks", async () => {
    const s = await selectPlugins({ isNative: false });
    expect(modes(s)).toEqual({ Detector: "web", Pose: "web", HeadPose: "web", Keys: "web" });
    expect(s.plugins.detector.mode).toBe("web");
  });

  it("?mode=mock: everything is a deterministic mock", async () => {
    const s = await selectPlugins({ force: "mock" });
    expect(modes(s)).toEqual({ Detector: "mock", Pose: "mock", HeadPose: "mock", Keys: "mock" });
    expect(s.plugins.detector).toBeInstanceOf(MockDetector);
  });

  it("native shell with every plugin answering ping: all native", async () => {
    const b = bundle({ detector: true, pose: true, head: true, keys: true });
    const s = await selectPlugins({ isNative: true, loadNative: async () => b });
    expect(modes(s)).toEqual({ Detector: "native", Pose: "native", HeadPose: "native", Keys: "native" });
    expect(s.plugins.detector).toBe(b.detector.plugin);
  });

  it("native shell before the Kotlin lands: detector NEVER falls back to the web camera", async () => {
    const s = await selectPlugins({ isNative: true, loadNative: async () => bundle({}) });
    expect(modes(s)).toEqual({ Detector: "mock", Pose: "web", HeadPose: "mock", Keys: "web" });
    expect(s.plugins.detector).toBeInstanceOf(MockDetector);
    expect(s.report.find((r) => r.kind === "Detector")!.note).toContain("not implemented natively");
    expect(s.report.find((r) => r.kind === "Detector")!.note).toContain("never opens the camera");
  });

  it("selects per plugin: only the ones that answer are native", async () => {
    const s = await selectPlugins({ isNative: true, loadNative: async () => bundle({ detector: true, keys: true }) });
    expect(modes(s)).toEqual({ Detector: "native", Pose: "web", HeadPose: "mock", Keys: "native" });
  });
});

describe("the WebView must never open the camera", () => {
  it("WebDetector refuses to start inside the native shell, before touching getUserMedia", async () => {
    (globalThis as Record<string, unknown>).Capacitor = { isNativePlatform: () => true };
    try {
      expect(isNativeWebView()).toBe(true);
      await expect(new WebDetector().start(DEFAULT_DETECTOR_CONFIG)).rejects.toThrow(/must not run inside the native WebView/);
    } finally {
      delete (globalThis as Record<string, unknown>).Capacitor;
    }
    expect(isNativeWebView()).toBe(false);
  });
});

describe("probeNative", () => {
  it("ok when ping answers", async () => expect(await probeNative({ ping: ok })).toEqual({ ok: true, version: 1 }));
  it("reports 'not implemented natively' for Capacitor UNIMPLEMENTED errors", async () => {
    const r = await probeNative({ ping: () => Promise.reject(Object.assign(new Error("x"), { code: "UNIMPLEMENTED" })) });
    expect(r).toEqual({ ok: false, note: "not implemented natively" });
    expect(await probeNative({ ping: () => Promise.reject(new Error('"LastseenPose" plugin is not implemented on android')) })).toMatchObject({ ok: false, note: "not implemented natively" });
  });
  it("times out a plugin that never answers", async () => {
    const r = await probeNative({ ping: () => new Promise(() => undefined) }, 20);
    expect(r).toMatchObject({ ok: false });
  });
});

describe("averageHash", () => {
  it("is 16 hex chars and stable for similar images", () => {
    const a = Uint8Array.from({ length: 64 }, (_, i) => (i % 8) * 30);
    const b = Uint8Array.from(a, (v, i) => v + (i === 3 ? 3 : 0));
    expect(averageHash(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(averageHash(a)).toBe(averageHash(b));
    expect(averageHash(Uint8Array.from(a, (v) => 255 - v))).not.toBe(averageHash(a));
  });
});
