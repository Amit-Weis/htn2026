// Build / install / probe pipeline for the plain Android hardware-probe app in apps/probe (no Capacitor, no web layer).
//   pnpm android:doctor           print the toolchain and attached devices
//   pnpm android:build            gradlew assembleDebug  (apps/probe/app/build/outputs/apk/debug/app-debug.apk)
//   pnpm android:test             gradlew testDebugUnitTest (JVM unit tests of the probe logic)
//   pnpm android:install          adb install -r the debug APK
//   pnpm android:run [--autorun]  install + launch (--autorun runs every automated probe on launch)
//   pnpm android:logcat           logcat filtered to the probe app and crashes
//   pnpm android:probe [--soak N] grant permissions, run the automated probes on the attached device, pull the results,
//                                 write docs/probe-data/<timestamp>/summary.md and fill the AUTO blocks in docs/probe-results.md
//   pnpm android:report [dir]     re-render the summary from data already pulled (--empty resets the AUTO blocks to TODO)
// Finds JDK 17+ and the Android SDK from JAVA_HOME / ANDROID_HOME or the usual install locations. Nothing global is modified.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const androidDir = join(root, "apps", "probe");
const win = platform() === "win32";
const APP_ID = "dev.lastseen.probe";
const APK = join(androidDir, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
const MIN_JDK = 17;

const args = process.argv.slice(2);
const cmd = args[0] ?? "doctor";
const flag = (f) => args.includes(f);
const valueAfter = (f) => (args.includes(f) && args[args.indexOf(f) + 1] && !args[args.indexOf(f) + 1].startsWith("--") ? args[args.indexOf(f) + 1] : undefined);

function javaMajor(home) {
  const r = spawnSync(join(home, "bin", win ? "java.exe" : "java"), ["-version"], { encoding: "utf8" });
  const m = /version "(\d+)(?:\.(\d+))?/.exec(`${r.stderr ?? ""}${r.stdout ?? ""}`);
  if (!m) return 0;
  return Number(m[1]) === 1 ? Number(m[2]) : Number(m[1]); // "1.8.0" is Java 8
}

function findJdk() {
  const candidates = [
    process.env.JAVA_HOME,
    join(homedir(), ".jdks", "temurin-21"),
    join(homedir(), ".jdks", "temurin-17"),
    "C:\\Program Files\\Android\\Android Studio\\jbr",
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
    "/usr/lib/jvm/temurin-21-jdk-amd64",
    "/usr/lib/jvm/java-21-openjdk-amd64",
    "/usr/lib/jvm/temurin-17-jdk-amd64",
    "/usr/lib/jvm/java-17-openjdk-amd64",
  ].filter(Boolean);
  return candidates.find((p) => existsSync(join(p, "bin", win ? "java.exe" : "java")) && javaMajor(p) >= MIN_JDK);
}

function findSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    win ? join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk") : undefined,
    join(homedir(), "Library", "Android", "sdk"),
    join(homedir(), "Android", "Sdk"),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(join(p, "platform-tools")));
}

const jdk = findJdk();
const sdk = findSdk();
const env = { ...process.env, ...(jdk ? { JAVA_HOME: jdk } : {}), ...(sdk ? { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk } : {}) };
const adbBin = sdk ? join(sdk, "platform-tools", win ? "adb.exe" : "adb") : "adb";
const pnpm = win ? "pnpm.cmd" : "pnpm";
const gradlew = join(androidDir, win ? "gradlew.bat" : "gradlew");

function need(what, ok, hint) {
  if (!ok) {
    console.error(`\nMissing ${what}. ${hint}\nSee docs/apk-setup.md.`);
    process.exit(2);
  }
}

function run(bin, a, opts = {}) {
  const r = spawnSync(bin, a, { stdio: "inherit", env, shell: win && /\.(cmd|bat)$/i.test(bin), ...opts });
  if (r.status !== 0) {
    console.error(`\n${bin} ${a.join(" ")} failed (exit ${r.status ?? r.signal})`);
    process.exit(r.status ?? 1);
  }
}

function capture(bin, a) {
  const r = spawnSync(bin, a, { encoding: "utf8", env });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function devices() {
  const { out } = capture(adbBin, ["devices", "-l"]);
  return out.split("\n").slice(1).map((l) => l.trim()).filter((l) => l && !l.startsWith("*")).map((l) => ({ serial: l.split(/\s+/)[0], state: l.split(/\s+/)[1], line: l }));
}

function needDevice() {
  need("the Android SDK (adb)", sdk, "Install platform-tools and set ANDROID_HOME.");
  const d = devices().filter((x) => x.state === "device");
  need("an attached device", d.length > 0, "Connect the Beam Pro (USB or `adb pair` / `adb connect`) and accept the debugging prompt. `adb devices -l` must list it as `device`.");
  if (d.length > 1 && !process.env.ANDROID_SERIAL) {
    console.error(`Several devices attached; set ANDROID_SERIAL=<serial>:\n${d.map((x) => `  ${x.line}`).join("\n")}`);
    process.exit(2);
  }
}

function toolchainChecks() {
  need(`a JDK ${MIN_JDK}+`, jdk, `Install Temurin 17 or 21 and set JAVA_HOME (or unpack it to ~/.jdks/temurin-21).`);
  need("the Android SDK", sdk, "Install the command-line tools + platform-tools + platform 36 + build-tools 36 and set ANDROID_HOME.");
  // gradlew resolves the SDK from ANDROID_HOME; write local.properties as well so Android Studio agrees
  writeFileSync(join(androidDir, "local.properties"), `sdk.dir=${sdk.replace(/\\/g, "\\\\")}\n`);
}

function build() {
  toolchainChecks();
  run(gradlew, ["--console=plain", "assembleDebug"], { cwd: androidDir });
  console.log(`\nAPK: ${APK}`);
}

function test() {
  toolchainChecks();
  run(gradlew, ["--console=plain", "testDebugUnitTest"], { cwd: androidDir });
}

function install() {
  needDevice();
  need("the debug APK", existsSync(APK), "Run `pnpm android:build` first.");
  run(adbBin, ["install", "-r", "-t", APK]);
}

function launch(extras = []) {
  // wake the screen and dismiss a swipe keyguard: the camera cannot open while the device is locked
  capture(adbBin, ["shell", "input", "keyevent", "KEYCODE_WAKEUP"]);
  capture(adbBin, ["shell", "wm", "dismiss-keyguard"]);
  run(adbBin, ["shell", "am", "start", "-n", `${APP_ID}/.ProbeActivity`, ...extras]);
}

function doctor() {
  console.log(`node        ${process.version}`);
  console.log(`JAVA_HOME   ${jdk ?? `NOT FOUND (need JDK ${MIN_JDK}+)`}`);
  if (jdk) console.log(`java        ${capture(join(jdk, "bin", "java"), ["-version"]).out.split("\n")[0]}`);
  console.log(`ANDROID_HOME ${sdk ?? "NOT FOUND"}`);
  if (sdk) {
    console.log(`platforms   ${existsSync(join(sdk, "platforms")) ? readdirSync(join(sdk, "platforms")).join(", ") : "none"}`);
    console.log(`build-tools ${existsSync(join(sdk, "build-tools")) ? readdirSync(join(sdk, "build-tools")).join(", ") : "none"}`);
    console.log(`adb         ${capture(adbBin, ["version"]).out.split("\n")[0]}`);
  }
  const d = sdk ? devices() : [];
  console.log(`devices     ${d.length ? "\n  " + d.map((x) => x.line).join("\n  ") : "none attached"}`);
}

function logcat() {
  needDevice();
  const child = spawn(adbBin, ["logcat", "-v", "time", "LastseenProbe:V", "chromium:I", "AndroidRuntime:E", "*:S"], { stdio: "inherit", env });
  child.on("exit", (c) => process.exit(c ?? 0));
}

function report(extra = []) {
  run(pnpm, ["exec", "tsx", "scripts/probe-report.ts", ...extra], { cwd: root });
}

/** Grants permissions, launches with autorun, waits for PROBE_DONE in logcat, pulls the results folder, renders the summary. */
async function probe() {
  needDevice();
  need("the debug APK", existsSync(APK), "Run `pnpm android:build` and `pnpm android:install` first.");
  const soak = valueAfter("--soak") ?? "0";
  for (const p of ["CAMERA", "RECORD_AUDIO", "POST_NOTIFICATIONS", "ACTIVITY_RECOGNITION"]) capture(adbBin, ["shell", "pm", "grant", APP_ID, `android.permission.${p}`]);
  capture(adbBin, ["logcat", "-c"]);
  capture(adbBin, ["shell", "am", "force-stop", APP_ID]);
  launch(["--ez", "probe_autorun", "true", "--ei", "probe_soak_minutes", String(soak)]);
  console.log(`> probes running on the device (soak ${soak} min). Waiting for PROBE_DONE ...`);
  const timeoutMs = (Number(soak) * 60 + 180) * 1000;
  const done = await new Promise((resolveP) => {
    const child = spawn(adbBin, ["logcat", "-v", "brief", "LastseenProbe:I", "*:S"], { env });
    const timer = setTimeout(() => {
      child.kill();
      resolveP(null);
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      const s = String(d);
      process.stdout.write(s);
      const m = /PROBE_DONE (\S+)/.exec(s);
      if (m) {
        clearTimeout(timer);
        child.kill();
        resolveP(m[1]);
      }
    });
  });
  if (!done) {
    console.error("timed out waiting for PROBE_DONE. Is the screen on and unlocked? Check `pnpm android:logcat`.");
    process.exit(1);
  }
  const out = join(root, "docs", "probe-data", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(out, { recursive: true });
  run(adbBin, ["pull", `/sdcard/Android/data/${APP_ID}/files/probe/.`, out]);
  console.log(`\nResults pulled to ${out}`);
  report([out]);
  console.log("HUMAN fields in docs/probe-results.md (keys, display, glasses) are still TODO.");
}

switch (cmd) {
  case "doctor": doctor(); break;
  case "build": build(); break;
  case "test": test(); break;
  case "install": install(); break;
  case "run": needDevice(); install(); launch(flag("--autorun") ? ["--ez", "probe_autorun", "true"] : []); break;
  case "logcat": logcat(); break;
  case "probe": await probe(); break;
  case "report": report(args.slice(1)); break;
  default:
    console.error(`unknown command "${cmd}". Try: doctor | build | test | install | run | logcat | probe | report`);
    process.exit(2);
}
