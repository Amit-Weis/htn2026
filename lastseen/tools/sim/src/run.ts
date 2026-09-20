// Scenario runner.
//   pnpm sim scenarios/keys-on-table.json            run one scenario against LASTSEEN_URL (default http://localhost:8787)
//   pnpm sim --all                                    run every scenario in tools/sim/scenarios
//   pnpm sim:local                                    build the web apps, start `wrangler dev` (MOCK_OMNI=1), run all, stop it
// Env: LASTSEEN_URL, DEVICE_TOKEN (default dev-token). With MOCK_OMNI=1 on the worker everything runs offline.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "./driver";
import { ScenarioSchema } from "./scenario";

const here = dirname(fileURLToPath(import.meta.url));
const simRoot = resolve(here, "..");
const workerDir = resolve(simRoot, "../../apps/worker");

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const files = args.filter((a) => !a.startsWith("--"));
const token = process.env.DEVICE_TOKEN ?? "dev-token";
let url = process.env.LASTSEEN_URL ?? "http://localhost:8787";

function resolveScenario(a: string): string {
  const candidates = [resolve(a), resolve(simRoot, a), resolve(simRoot, "scenarios", a), resolve(simRoot, "scenarios", `${a}.json`)];
  const hit = candidates.find((p) => existsSync(p) && p.endsWith(".json"));
  if (!hit) throw new Error(`scenario not found: ${a}`);
  return hit;
}

async function healthy(u: string): Promise<boolean> {
  try {
    return (await fetch(`${u}/api/health`)).ok;
  } catch {
    return false;
  }
}

/** Start `wrangler dev` for the worker and wait until /api/health answers. */
async function spawnWorker(): Promise<() => void> {
  const port = 8799;
  const req = createRequire(join(workerDir, "package.json"));
  const wrangler = join(dirname(req.resolve("wrangler/package.json")), "bin", "wrangler.js"); // not in wrangler's "exports"
  if (!existsSync(join(workerDir, "public"))) throw new Error("apps/worker/public is missing: run `pnpm build:web` first");
  const child = spawn(process.execPath, [wrangler, "dev", "--port", String(port), "--ip", "127.0.0.1"], { cwd: workerDir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MOCK_OMNI: "1" } });
  let out = "";
  child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
  const kill = () => {
    if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  };
  url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${out.slice(-1500)}`);
    if (await healthy(url)) return kill;
    await new Promise((r) => setTimeout(r, 500));
  }
  kill();
  throw new Error(`wrangler dev did not become healthy in 90 s:\n${out.slice(-1500)}`);
}

async function main() {
  let stop: (() => void) | null = null;
  if (flag("--spawn")) {
    console.log("starting wrangler dev (MOCK_OMNI=1)…");
    stop = await spawnWorker();
  } else if (!(await healthy(url))) {
    console.error(`no worker at ${url}. Start one (\`pnpm --filter @lastseen/worker dev\`) or use \`pnpm sim:local\`.`);
    process.exit(2);
  }

  const targets = flag("--all") || !files.length ? readdirSync(join(simRoot, "scenarios")).filter((f) => f.endsWith(".json")).sort().map((f) => join(simRoot, "scenarios", f)) : files.map(resolveScenario);
  let failed = 0;
  try {
    const health = (await (await fetch(`${url}/api/health`)).json()) as { mockOmni?: boolean };
    console.log(`worker ${url} · OMNI ${health.mockOmni ? "MOCK (offline)" : "LIVE (spends credit!)"}\n`);
    for (const file of targets) {
      const sc = ScenarioSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      console.log(`▶ ${sc.name}${sc.description ? ` — ${sc.description}` : ""}`);
      const t0 = Date.now();
      const r = await runScenario(sc, { url, token, log: (s) => console.log(s) });
      console.log(`${r.ok ? "PASS" : "FAIL"} ${basename(file)} (${((Date.now() - t0) / 1000).toFixed(1)} s, device ${r.device})\n`);
      if (!r.ok) failed++;
    }
  } finally {
    stop?.();
  }
  console.log(failed ? `${failed} scenario(s) FAILED` : `all ${targets.length} scenario(s) passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
