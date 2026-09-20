// Turns the files pulled from the device by `pnpm android:probe` into markdown tables.
//   pnpm android:report [dir|report.json] [--no-doc]   render <dir>/summary.md and fill the AUTO blocks in docs/probe-results.md
//   pnpm android:report --empty                        reset the AUTO blocks to TODO (no device data)
// Only fields the app measured are filled; anything missing stays `TODO`. Nothing here is guessed.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Json = Record<string, unknown>;
export const TODO = "TODO";

const at = (o: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((a, k) => (a && typeof a === "object" ? (a as Json)[k] : undefined), o);
const has = (x: unknown) => x !== undefined && x !== null && x !== "";
const num = (x: unknown, d = 1) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(d) : TODO);
const str = (x: unknown) => (has(x) ? String(x).replace(/\|/g, "\\|") : TODO);
/** like `str` but an empty note stays empty instead of TODO */
const cell = (x: unknown) => (has(x) ? str(x) : "");
const yn = (x: unknown) => (x === true ? "yes" : x === false ? "no" : TODO);
const list = (x: unknown): Json[] => (Array.isArray(x) ? (x as Json[]) : []);
const table = (head: string[], rows: string[][]) =>
  [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

export function deviceSection(r: Json | null): string {
  const d = at(r, "device");
  return table(["Field", "Value"], [
    ["Model / Android / API", has(at(d, "model")) ? `${str(at(d, "manufacturer"))} ${str(at(d, "model"))} · Android ${str(at(d, "androidRelease"))} (API ${str(at(d, "sdkInt"))})` : TODO],
    ["WebView package + version", str(at(d, "webView"))],
    ["CPU cores / ABIs", has(at(d, "cores")) ? `${str(at(d, "cores"))} / ${list(at(d, "abis")).join(", ")}` : TODO],
    ["Permissions at start", has(at(d, "permissions")) ? "`" + JSON.stringify(at(d, "permissions")) + "`" : TODO],
    ["Permissions after the request step", has(at(r, "permissions")) ? "`" + JSON.stringify(at(r, "permissions")) + "`" : TODO],
    ["Start-of-run thermal status / battery temp (°C)", has(at(d, "batteryTempC")) ? `${str(at(d, "thermalStatus"))} / ${num(at(d, "batteryTempC"))}` : TODO],
  ]);
}

const SENSOR_KEYS = ["rotation_vector", "game_rotation_vector", "step_detector", "accelerometer", "gyroscope", "magnetometer"];
export function sensorsSection(r: Json | null): string {
  const described = list(at(r, "sensors.sensors"));
  const stream = at(r, "sensors.stream") as Json | undefined;
  return table(
    ["Sensor", "Present", "Advertised max Hz", "Achieved Hz (wall)", "Achieved Hz (sensor clock)", "Events", "Max gap ms", "Notes"],
    SENSOR_KEYS.map((k) => {
      const s = described.find((x) => x.key === k);
      const st = stream?.[k] as Json | undefined;
      const walk = k === "step_detector";
      return [
        k,
        s ? yn(s.present) : TODO,
        s?.present === true ? (typeof s.maxRateHzAdvertised === "number" ? num(s.maxRateHzAdvertised, 0) : "n/a (event-driven)") : s ? "n/a" : TODO,
        st ? num(st.hzWall) : "(not streamed)",
        st ? (typeof st.hzSensorClock === "number" ? num(st.hzSensorClock) : "n/a") : "",
        st ? str(st.events) : "",
        st ? num(st.maxGapMs, 0) : "",
        walk ? `HUMAN: walk during the 5 s test. ${cell(st?.note)}`.trim() : cell(st?.note ?? s?.reportingMode),
      ];
    }),
  );
}

export function cameraSection(r: Json | null): string {
  const info = at(r, "camera.info");
  const cams = list(at(info, "cameras"));
  const stream = at(r, "camera.stream");
  const jpegs = list(at(r, "camera.jpeg640")).filter((j) => typeof j.totalEncodeMs === "number");
  const conc = at(r, "camera.concurrent");
  const cold = jpegs[0]; // the first sample is the cold path
  const typical = median(jpegs.slice(1).map((j) => j.totalEncodeMs as number));
  const camTable = table(
    ["Id", "Facing", "Focal (mm)", "Sensor (mm)", "FOV short side (°)", "FOV long side (°)", "Logical multi-cam", "640x480 / 1280x720 / 1920x1080", "YUV sizes (largest first)"],
    cams.length
      ? cams.map((c) => [
          str(c.id), str(c.facing), list(c.focalLengthsMm).join(", ") || TODO,
          has(at(c, "sensorPhysicalSizeMm")) ? `${num(at(c, "sensorPhysicalSizeMm.w"), 2)} x ${num(at(c, "sensorPhysicalSizeMm.h"), 2)}` : TODO,
          num(c.fovShortSideDeg), num(c.fovLongSideDeg), yn(c.logicalMultiCamera),
          `${yn(c.has640x480)} / ${yn(c.has1280x720)} / ${yn(c.has1920x1080)}`,
          list(c.yuvSizes).slice(0, 6).join(", ") || TODO,
        ])
      : [[TODO, TODO, TODO, TODO, TODO, TODO, TODO, TODO, TODO]],
  );
  const facts = table(["Field", "Value"], [
    ["**FOV, short side (portrait horizontal): use for `CAMERA_HFOV_DEG`** (first back camera; smaller if the stream crops the sensor)", num(cams.find((c) => c.facing === "back")?.fovShortSideDeg)],
    ["Multiple back cameras? (ids)", has(at(info, "multipleBackCameras")) ? `${yn(at(info, "multipleBackCameras"))} (${list(at(info, "backCameraIds")).join(", ")})` : TODO],
    ["Analysis stream size (requested 1280x720)", has(at(stream, "analysisWidth")) ? `${str(at(stream, "analysisWidth"))} x ${str(at(stream, "analysisHeight"))} (rotation ${str(at(stream, "rotationDegrees"))}°)` : TODO],
    ["**Steady-state fps**", num(at(stream, "fps"))],
    ["Frame interval mean / p95 / max (ms)", has(at(stream, "meanFrameIntervalMs")) ? `${num(at(stream, "meanFrameIntervalMs"))} / ${num(at(stream, "p95FrameIntervalMs"))} / ${num(at(stream, "maxFrameIntervalMs"))}` : TODO],
    ["Stream error, if any", has(stream) ? str(at(stream, "error") ?? "none") : TODO],
    ["**640 px JPEG**: size (bytes) / dimensions", cold ? `${str(cold.bytes)} / ${str(cold.width)} x ${str(cold.height)}` : TODO],
    ["640 px JPEG: encode time, first (cold) / typical median (ms)", cold ? `${num(cold.totalEncodeMs)} / ${num(typical)}` : TODO],
    ["Two cameras open at once?", has(at(conc, "bothOpenedAtOnce")) ? `${yn(at(conc, "bothOpenedAtOnce"))} — pair ${list(at(conc, "pair")).join("+")}, ${JSON.stringify(at(conc, "perCamera"))}` : has(at(conc, "note")) ? str(at(conc, "note")) : TODO],
    ["Camera2 concurrent id sets (API 30+)", has(at(info, "concurrentCameraIdSets")) ? "`" + JSON.stringify(at(info, "concurrentCameraIdSets")) + "`" : TODO],
  ]);
  return `${camTable}\n\n${facts}`;
}

export function exclusivitySection(r: Json | null): string {
  const ex = at(r, "exclusivity");
  const sum = at(ex, "summary");
  return table(["Question", "Result"], [
    ["WebView `getUserMedia({audio:true})` while the native camera streams (also confirms the mic prompt path)", yn(at(sum, "webAudioWhileNativeCamera"))],
    ["WebView `getUserMedia({video:true})` while the native camera streams", yn(at(sum, "webVideoWhileNativeCamera"))],
    ["Native stream keeps delivering after the WebView tried the camera?", yn(at(sum, "nativeKeepsStreamingWhenWebOpensCamera"))],
    ["Native can open the camera while the WebView holds it?", yn(at(sum, "nativeCanOpenWhileWebHoldsCamera"))],
    ["WebView permission requests seen (audio attempt / video attempt)", has(at(ex, "nativeFirst.webAudio")) ? `${JSON.stringify(at(ex, "nativeFirst.webAudio.permissionRequested"))} → ${str(at(ex, "nativeFirst.webAudio.permissionDecision"))} / ${JSON.stringify(at(ex, "nativeFirst.webVideo.permissionRequested"))} → ${str(at(ex, "nativeFirst.webVideo.permissionDecision"))}` : TODO],
    ["WebView errors (audio / video)", has(at(ex, "nativeFirst.webAudio")) ? `${str(at(ex, "nativeFirst.webAudio.error.name") ?? "none")} / ${str(at(ex, "nativeFirst.webVideo.error.name") ?? "none")}` : TODO],
    ["Verdict", str(at(sum, "verdict"))],
  ]);
}

export function foregroundSection(r: Json | null): string {
  const f = at(r, "foregroundService");
  return table(["Field", "Result"], [
    ["Started on this Android version with camera + microphone types", has(at(f, "started.started")) ? `${yn(at(f, "started.started"))} (API ${str(at(f, "started.sdkInt"))})` : TODO],
    ["Error, if any (verbatim)", has(at(f, "started")) ? str(at(f, "started.error") ?? "none") : TODO],
    ["Still running 1.5 s later", yn(at(f, "statusAfter1500ms.running"))],
    ["Notifications enabled for the app", yn(at(f, "started.notificationsEnabled"))],
  ]);
}

interface SoakRow { elapsedS: number; fps: number; thermal: number; headroom: number; tempC: number; levelPct: number; currentUa: number; charging: boolean }
export function parseSoak(csv: string): SoakRow[] {
  const [head, ...lines] = csv.trim().split(/\r?\n/);
  const cols = (head ?? "").split(",");
  const col = (name: string) => cols.indexOf(name);
  const n = (v: string | undefined) => (v === undefined || v === "" ? NaN : Number(v));
  return lines.filter(Boolean).map((l) => {
    const c = l.split(",");
    return {
      elapsedS: n(c[col("elapsed_s")]), fps: n(c[col("fps")]), thermal: n(c[col("thermal_status")]), headroom: n(c[col("thermal_headroom_10s")]),
      tempC: n(c[col("battery_temp_c")]), levelPct: n(c[col("battery_level_pct")]), currentUa: n(c[col("battery_current_ua")]), charging: c[col("charging")] === "true",
    };
  });
}

export function soakSection(csv: string | null): string {
  const rows = csv ? parseSoak(csv) : [];
  if (!rows.length) {
    return table(["Metric", "Start", "End", "Notes"], [
      ["fps (10 s window)", TODO, TODO, "drop % = TODO"],
      ["Highest thermal status seen (0 none .. 6 shutdown)", TODO, TODO, "first >= 2 (moderate): TODO"],
      ["Thermal headroom (10 s forecast; 1.0 = throttle point)", TODO, TODO, ""],
      ["Battery temperature (°C)", TODO, TODO, ""],
      ["Battery level (%) / charging", TODO, TODO, ""],
    ]);
  }
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const maxThermal = Math.max(...rows.map((x) => x.thermal));
  const firstModerate = rows.find((x) => x.thermal >= 2);
  const drop = first.fps > 0 ? ((first.fps - last.fps) / first.fps) * 100 : NaN;
  return table(["Metric", "Start", "End", "Notes"], [
    ["fps (10 s window)", num(first.fps), num(last.fps), `drop ${num(drop, 0)} % over ${rows.length} rows (${num(last.elapsedS, 0)} s)`],
    ["Highest thermal status seen (0 none .. 6 shutdown)", num(first.thermal, 0), num(maxThermal, 0), firstModerate ? `first >= 2 (moderate) at ${num(firstModerate.elapsedS, 0)} s` : "never reached moderate"],
    ["Thermal headroom (10 s forecast; 1.0 = throttle point)", num(first.headroom, 2), num(last.headroom, 2), ""],
    ["Battery temperature (°C)", num(first.tempC), num(last.tempC), `max ${num(Math.max(...rows.map((x) => x.tempC)))}`],
    ["Battery level (%) / charging", `${num(first.levelPct, 0)} / ${yn(first.charging)}`, `${num(last.levelPct, 0)} / ${yn(last.charging)}`, `current now ${num(last.currentUa, 0)} µA`],
  ]);
}

export function displaySection(r: Json | null): string {
  const n = at(r, "display.native");
  const displays = list(at(n, "displays"));
  const rows = displays.length
    ? displays.map((d) => [str(d.id), str(d.name), `${str(d.widthPx)} x ${str(d.heightPx)}`, num(d.refreshRateHz, 0), str(d.densityDpi), str(d.rotation), yn(d.isPresentationCapable)])
    : [[TODO, TODO, TODO, TODO, TODO, TODO, TODO]];
  return `${table(["Display id", "Name", "Size (px)", "Hz", "dpi", "Rotation", "Presentation-capable"], rows)}\n\n` +
    `Display count: ${str(at(n, "displayCount"))} (more than 1 means the glasses appear as a separate display; 1 means a mirror). ` +
    `Presentation display ids: ${has(at(n, "presentationDisplayIds")) ? JSON.stringify(at(n, "presentationDisplayIds")) : TODO}. ` +
    `Activity window: ${has(at(n, "activityWindow")) ? `${str(at(n, "activityWindow.widthPx"))} x ${str(at(n, "activityWindow.heightPx"))} px, ${str(at(n, "activityWindow.orientation"))}` : TODO}.`;
}

export const SECTIONS = ["device", "sensors", "camera", "exclusivity", "foreground", "soak", "display"] as const;

export function renderAll(report: Json | null, soakCsv: string | null): Record<(typeof SECTIONS)[number], string> {
  return {
    device: deviceSection(report), sensors: sensorsSection(report), camera: cameraSection(report), exclusivity: exclusivitySection(report),
    foreground: foregroundSection(report), soak: soakSection(soakCsv), display: displaySection(report),
  };
}

/** Replaces the text between `<!-- AUTO:name -->` and `<!-- /AUTO:name -->`. Blocks that are absent are left alone. */
export function patchDoc(doc: string, sections: Record<string, string>): string {
  let out = doc;
  for (const [name, body] of Object.entries(sections)) {
    const re = new RegExp(`(<!-- AUTO:${name} -->)[\\s\\S]*?(<!-- /AUTO:${name} -->)`);
    out = out.replace(re, (_m, open: string, close: string) => `${open}\n${body}\n${close}`);
  }
  return out;
}

function latestDir(root: string): string | null {
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory()).sort();
  return dirs.length ? join(root, dirs[dirs.length - 1]!) : null;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const docPath = join(root, "docs", "probe-results.md");
  const flags = args.filter((a) => a.startsWith("--"));
  const target = args.find((a) => !a.startsWith("--"));

  let report: Json | null = null;
  let soak: string | null = null;
  let outDir: string | null = null;
  if (!flags.includes("--empty")) {
    outDir = target ? resolve(target) : latestDir(join(root, "docs", "probe-data"));
    if (outDir && outDir.endsWith(".json")) outDir = dirname(outDir);
    if (!outDir || !existsSync(outDir)) {
      console.error("no probe data found. Run `pnpm android:probe` first (or pass a directory).");
      process.exit(2);
    }
    const files = readdirSync(outDir);
    const reports = files.filter((f) => /^probe-report-.*\.json$/.test(f)).sort();
    const soaks = files.filter((f) => /^soak-.*\.csv$/.test(f)).sort();
    if (!reports.length) {
      console.error(`no probe-report-*.json in ${outDir}`);
      process.exit(2);
    }
    report = JSON.parse(readFileSync(join(outDir, reports[reports.length - 1]!), "utf8")) as Json;
    soak = soaks.length ? readFileSync(join(outDir, soaks[soaks.length - 1]!), "utf8") : null;
  }

  const sections = renderAll(report, soak);
  if (outDir) {
    const md = SECTIONS.map((s) => `## ${s}\n\n${sections[s]}\n`).join("\n");
    writeFileSync(join(outDir, "summary.md"), `# Probe summary\n\n${md}`);
    console.log(`wrote ${join(outDir, "summary.md")}`);
  }
  if (!flags.includes("--no-doc") && existsSync(docPath)) {
    writeFileSync(docPath, patchDoc(readFileSync(docPath, "utf8"), sections));
    console.log(`updated the AUTO blocks in ${docPath}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
