import { describe, expect, it } from "vitest";
import { parseSoak, patchDoc, renderAll, soakSection, TODO } from "./probe-report";

// Shaped exactly like the JSON the Kotlin ProbeRunner writes (apps/probe/.../ProbeRunner.kt); values are made up.
const report = {
  schema: 1,
  device: { manufacturer: "XREAL", model: "Beam Pro", androidRelease: "14", sdkInt: 34, webView: "com.google.android.webview 130.0", cores: 8, abis: ["arm64-v8a"], thermalStatus: 0, batteryTempC: 31.2, permissions: { camera: true } },
  permissions: { camera: "granted", microphone: "granted" },
  display: { native: { displayCount: 1, presentationDisplayIds: [], displays: [{ id: 0, name: "Built-in", widthPx: 1080, heightPx: 2400, refreshRateHz: 90, densityDpi: 420, rotation: 0, isPresentationCapable: false }], activityWindow: { widthPx: 1080, heightPx: 2400, orientation: "portrait" } } },
  sensors: {
    sensors: [
      { key: "rotation_vector", present: true, maxRateHzAdvertised: 200 },
      { key: "step_detector", present: true, maxRateHzAdvertised: null },
      { key: "magnetometer", present: false },
    ],
    stream: { rotation_vector: { events: 990, hzWall: 198.4, hzSensorClock: 199.9, maxGapMs: 12 }, step_detector: { events: 0, hzWall: 0, maxGapMs: 0, note: "needs the wearer to WALK" } },
  },
  camera: {
    info: { multipleBackCameras: true, backCameraIds: ["0", "2"], concurrentCameraIdSets: [], cameras: [{ id: "0", facing: "back", focalLengthsMm: [4.5], sensorPhysicalSizeMm: { w: 6.4, h: 4.8 }, fovShortSideDeg: 55.4, fovLongSideDeg: 70.2, logicalMultiCamera: false, has640x480: true, has1280x720: true, has1920x1080: true, yuvSizes: ["4000x3000", "1920x1080"] }] },
    stream: { fps: 29.7, meanFrameIntervalMs: 33.7, p95FrameIntervalMs: 41, maxFrameIntervalMs: 60, analysisWidth: 1280, analysisHeight: 720, rotationDegrees: 90 },
    jpeg640: [{ width: 640, height: 1138, bytes: 61000, totalEncodeMs: 48.2 }, { width: 640, height: 1138, bytes: 60500, totalEncodeMs: 19.1 }, { width: 640, height: 1138, bytes: 60400, totalEncodeMs: 21.3 }],
    concurrent: { attempted: true, pair: ["0", "2"], bothOpenedAtOnce: false, perCamera: { "0": "opened", "2": "error code 1" } },
  },
  exclusivity: {
    nativeFirst: { webAudio: { ok: true, permissionRequested: ["android.webkit.resource.AUDIO_CAPTURE"], permissionDecision: "granted", error: null }, webVideo: { ok: false, permissionRequested: ["android.webkit.resource.VIDEO_CAPTURE"], permissionDecision: "granted", error: { name: "NotReadableError" } } },
    summary: { webAudioWhileNativeCamera: true, webVideoWhileNativeCamera: false, nativeKeepsStreamingWhenWebOpensCamera: true, nativeCanOpenWhileWebHoldsCamera: null, verdict: "WebView is refused the camera while native streams: native owns the camera" },
  },
  foregroundService: { started: { started: true, sdkInt: 34, notificationsEnabled: true, error: null }, statusAfter1500ms: { running: true } },
};

const csv = [
  "time_iso,elapsed_s,fps,frames_in_window,thermal_status,thermal_status_name,thermal_headroom_10s,battery_temp_c,battery_level_pct,battery_current_ua,charging",
  "2026-09-19T20:00:10Z,10,30.00,300,0,NONE,0.60,31.0,80,-900000,false",
  "2026-09-19T20:00:20Z,20,29.00,290,1,LIGHT,0.75,33.5,80,-950000,false",
  "2026-09-19T20:00:30Z,30,21.00,210,2,MODERATE,0.95,36.0,79,-1000000,false",
].join("\n");

describe("renderAll with a real-shaped report", () => {
  const s = renderAll(report, csv);
  it("fills the measured values", () => {
    expect(s.device).toContain("XREAL Beam Pro · Android 14 (API 34)");
    expect(s.sensors).toContain("| rotation_vector | yes | 200 | 198.4 | 199.9 | 990 | 12 |");
    expect(s.sensors).toContain("| magnetometer | no |");
    expect(s.sensors).toContain("| step_detector | yes | n/a (event-driven) | 0.0 | n/a | 0 | 0 | HUMAN: walk");
    expect(s.camera).toContain("| 55.4 |"); // FOV short side, table and headline row
    expect(s.camera).toContain("29.7");
    expect(s.camera).toContain("61000 / 640 x 1138"); // first JPEG
    expect(s.camera).toContain("48.2 / 21.3"); // cold / median of the rest
    expect(s.camera).toContain("no — pair 0+2");
    expect(s.exclusivity).toContain("native owns the camera");
    expect(s.exclusivity).toContain("NotReadableError");
    expect(s.foreground).toContain("yes (API 34)");
    expect(s.display).toContain("Display count: 1");
  });
  it("keeps what was not measured as TODO instead of inventing it", () => {
    expect(s.exclusivity).toMatch(/Native can open the camera while the WebView holds it\? \| TODO/);
  });
  it("summarises the soak CSV", () => {
    expect(s.soak).toContain("drop 30 % over 3 rows");
    expect(s.soak).toContain("first >= 2 (moderate) at 30 s");
  });
});

describe("empty report", () => {
  it("renders every section with TODO and does not throw", () => {
    const s = renderAll(null, null);
    for (const body of Object.values(s)) expect(body).toContain(TODO);
  });
});

describe("parseSoak / soakSection", () => {
  it("reads columns by name and treats empty cells as NaN", () => {
    const rows = parseSoak("a,elapsed_s,fps,thermal_status,thermal_headroom_10s,battery_temp_c,battery_level_pct,battery_current_ua,charging\nx,10,30.5,0,,31.2,80,-1,true\n");
    expect(rows[0]?.fps).toBe(30.5);
    expect(Number.isNaN(rows[0]?.headroom)).toBe(true);
    expect(rows[0]?.charging).toBe(true);
    expect(soakSection("header\n")).toContain(TODO);
  });
});

describe("patchDoc", () => {
  const doc = "before\n<!-- AUTO:device -->\nold\n<!-- /AUTO:device -->\nafter\n<!-- AUTO:other -->keep<!-- /AUTO:other -->";
  it("replaces only the named block and leaves the rest alone", () => {
    const out = patchDoc(doc, { device: "NEW", missing: "x" });
    expect(out).toContain("<!-- AUTO:device -->\nNEW\n<!-- /AUTO:device -->");
    expect(out).toContain("before\n");
    expect(out).toContain("<!-- AUTO:other -->keep<!-- /AUTO:other -->");
    expect(out).not.toContain("old");
  });
  it("is idempotent", () => {
    const once = patchDoc(doc, { device: "NEW" });
    expect(patchDoc(once, { device: "NEW" })).toBe(once);
  });
});
