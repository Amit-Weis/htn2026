// Compiles the Unity C# and runs its EditMode tests in a headless editor.
//   pnpm unity:test                        run every EditMode test (Lastseen.Tests replays packages/shared/test-vectors/geometry.json)
//   pnpm unity:test -- --android-branches  also compile the `#if UNITY_ANDROID && !UNITY_EDITOR` code (DualCameraCapture, the
//                                          microphone permission, ...), which the editor normally skips: a scratch copy is rewritten
//                                          so those branches build as ordinary code. Compile check only; nothing runs on a device.
// It uses the real project when no editor has it open. Unity refuses to open one project twice, so when the project is open
// (its Temp/UnityLockfile is held) the scripts, tests and vectors are copied to a scratch project in the temp folder and run
// there instead: same compiler, same tests, none of your scene or XREAL packages. Set UNITY_EXE to pick an editor.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const lastseen = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = resolve(lastseen, "..");

function editorFor(version) {
  if (process.env.UNITY_EXE) return process.env.UNITY_EXE;
  const roots = [
    "C:\\Program Files\\Unity\\Hub\\Editor",
    join(process.env.LOCALAPPDATA ?? "", "Unity", "Hub", "Editor"),
    "/Applications/Unity/Hub/Editor",
    join(process.env.HOME ?? "", "Unity", "Hub", "Editor"),
  ];
  for (const r of roots) {
    for (const exe of [join(r, version, "Editor", "Unity.exe"), join(r, version, "Unity.app", "Contents", "MacOS", "Unity"), join(r, version, "Editor", "Unity")]) {
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

const version = /m_EditorVersion: (\S+)/.exec(readFileSync(join(project, "ProjectSettings", "ProjectVersion.txt"), "utf8"))?.[1];
const exe = version ? editorFor(version) : null;
if (!exe) {
  console.error(`Unity ${version ?? "(unknown version)"} not found. Install it with Unity Hub or set UNITY_EXE.`);
  process.exit(2);
}

/** A project that an editor has open holds its Temp/UnityLockfile exclusively. */
function projectIsOpen() {
  const lock = join(project, "Temp", "UnityLockfile");
  if (!existsSync(lock)) return false;
  try {
    closeSync(openSync(lock, "r+"));
    return false;
  } catch {
    return true;
  }
}

const androidBranches = process.argv.includes("--android-branches");

/** Rewrite `UNITY_ANDROID && !UNITY_EDITOR` (never true in the editor) to a symbol the scratch project defines. */
function enableAndroidBranches(dir) {
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".cs")) {
        const src = readFileSync(p, "utf8");
        const out = src.replace(/UNITY_ANDROID\s*&&\s*!UNITY_EDITOR/g, "LASTSEEN_ANDROID_CHECK");
        if (out !== src) writeFileSync(p, out);
      }
    }
  };
  walk(join(dir, "Assets", "Scripts"));
  writeFileSync(join(dir, "Assets", "csc.rsp"), "-define:LASTSEEN_ANDROID_CHECK\n");
}

function scratchProject() {
  const dir = join(tmpdir(), "lastseen-unity-check");
  mkdirSync(join(dir, "Packages"), { recursive: true });
  mkdirSync(join(dir, "ProjectSettings"), { recursive: true });
  const real = JSON.parse(readFileSync(join(project, "Packages", "manifest.json"), "utf8"));
  const keep = new Set(["com.unity.nuget.newtonsoft-json", "com.unity.test-framework", "com.unity.inputsystem", "com.unity.xr.arfoundation"]);
  const dependencies = Object.fromEntries(Object.entries(real.dependencies).filter(([k]) => keep.has(k) || k.startsWith("com.unity.modules.")));
  writeFileSync(join(dir, "Packages", "manifest.json"), JSON.stringify({ dependencies }, null, 2));
  writeFileSync(join(dir, "ProjectSettings", "ProjectVersion.txt"), `m_EditorVersion: ${version}\n`);
  const assets = join(dir, "Assets");
  rmSync(assets, { recursive: true, force: true });
  for (const p of ["Scripts", "Forgetmenot/Scripts", "Tests"]) {
    if (existsSync(join(project, "Assets", p))) cpSync(join(project, "Assets", p), join(assets, p), { recursive: true, filter: (s) => !s.endsWith(".meta") });
  }
  const vectors = join("lastseen", "packages", "shared", "test-vectors");
  rmSync(join(dir, "lastseen"), { recursive: true, force: true });
  cpSync(join(project, vectors), join(dir, vectors), { recursive: true });
  if (androidBranches) enableAndroidBranches(dir);
  return dir;
}

const open = projectIsOpen() || androidBranches;
const dir = open ? scratchProject() : project;
console.log(open ? `${androidBranches ? "Compiling the Android-only branches in" : "The Unity project is open in an editor: testing"} a scratch copy at ${dir}` : `Testing the project at ${dir}`);
const results = join(tmpdir(), "lastseen-unity-results.xml");
const log = join(tmpdir(), "lastseen-unity.log");
rmSync(results, { force: true });
const args = ["-batchmode", "-nographics", "-projectPath", dir, "-runTests", "-testPlatform", "EditMode", "-testResults", results, "-logFile", log];
console.log(`${exe}\n(the first run imports packages and can take several minutes; log: ${log})`);
const r = spawnSync(exe, args, { stdio: "inherit" });

const logText = existsSync(log) ? readFileSync(log, "utf8") : "";
const compileErrors = [...new Set(logText.split("\n").filter((l) => /error CS\d+/.test(l)))];
if (compileErrors.length) {
  console.error(`\n${compileErrors.length} C# compile error(s):\n${compileErrors.slice(0, 30).join("\n")}`);
  process.exit(1);
}
if (!existsSync(results)) {
  console.error(`\nNo test results were written (exit ${r.status}). Last lines of ${log}:\n${logText.split("\n").slice(-25).join("\n")}`);
  process.exit(1);
}
const xml = readFileSync(results, "utf8");
const root = /<test-run[^>]*>/.exec(xml)?.[0] ?? "";
const attr = (n) => Number(new RegExp(`${n}="(\\d+)"`).exec(root)?.[1] ?? 0);
const failed = [...xml.matchAll(/<test-case[^>]*name="([^"]+)"[^>]*result="Failed"[\s\S]*?<message><!\[CDATA\[([\s\S]*?)\]\]><\/message>/g)];
console.log(`\nEditMode: ${attr("passed")} passed, ${attr("failed")} failed, ${attr("skipped")} skipped (of ${attr("total")})`);
for (const f of failed) console.error(`  FAIL ${f[1]}\n       ${f[2].trim().split("\n")[0]}`);
process.exit(attr("failed") > 0 || attr("total") === 0 ? 1 : 0);
