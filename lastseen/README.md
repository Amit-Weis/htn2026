# Lastseen

A wearable memory for objects. A Xreal Beam Pro is strapped to the chest and runs a Capacitor Android APK. It watches the scene
with an on-device object detector; when you put something down it logs **what** it was and **where**. Later you ask out loud
("where are my keys?") and the Xreal One glasses (mirroring the phone screen) show an arrow toward the object's last known
location while a voice answers.

Built at Hack the North 2026 for two sponsor tracks:

| Track | What satisfies it here |
| --- | --- |
| **Huawei OMNI Live** | Qwen3.5-Omni (via yibuapi) sees the keyframes, hears the wearer, and reasons in one loop on an edge device: placement extraction (vision + narration audio), voice queries (audio + frame + pose), `verify_visible` (live frame check), spoken replies. Interruptible (barge-in), privacy-aware (on-device detection, frames only on a candidate, only the thumbnail kept), multi-device (phone + glasses + dashboard). |
| **Cloudflare Best Agent with a Brain** | Workers is the backend: a `TrackerAgent` Durable Object per device (state, SQLite memory, tools, a 4-step planning loop, traces), a durable retried Workflow for ingest, Vectorize + Workers AI for semantic recall, the Images binding for cropping, `schedule()` for retention. The dashboard shows it plan, remember and call tools live. |

Architecture, data flow and the mermaid diagram: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Design decisions: [docs/DECISIONS.md](docs/DECISIONS.md).
The interface the Kotlin teammates implement: [docs/NATIVE_CONTRACT.md](docs/NATIVE_CONTRACT.md).

## Repo layout

```
apps/worker      Worker gateway, TrackerAgent (Durable Object), ingest Workflow, tools, OMNI adapter
apps/wearable    web layer of the wearer app (TypeScript): native plugin bindings + fallbacks, filter, HUD, voice
apps/probe       plain Android hardware-probe app (Kotlin, no Capacitor): sensors, camera, thermal, keys, display
apps/dashboard   judge/debug dashboard served at /dash
packages/shared  zod contract v2 (+ v1 compat), geometry, native payload schemas
tools/sim        scenario runner: real phone-side code + mock plugins over the real WebSocket
scripts/         probe-omni, validate-native, android.mjs (build/install/probe pipeline), probe-report
docs/            ARCHITECTURE, DECISIONS, NATIVE_CONTRACT, omni-capabilities
```

This lives in `lastseen/` inside the Unity repo (Unity's `Packages/` would collide with `packages/` on case-insensitive filesystems).

## Quick start (no accounts, no hardware)

Requirements: Node >= 20 (22 recommended: tests use the built-in `node:sqlite`), pnpm 10.

```bash
pnpm install
pnpm check         # typecheck + lint + tests (about 170 tests, all offline)
pnpm sim:local     # builds the web apps, starts `wrangler dev` with MOCK_OMNI=1, plays every scenario, stops it
```

`pnpm sim:local` plays five scenarios through the **real** phone-side code and WebSocket path against the real agent:
`keys-on-table` (accepted, with detections; queries give correct arrows; "my drinking thing" finds the mug),
`walking-false-trigger` (dropped), `duplicate-burst` (deduped and cooled down), `voice-narration`, `move-and-verify`.
`pnpm check:all` runs both.

Try it by hand:

```bash
cp apps/worker/.dev.vars.example apps/worker/.dev.vars      # DEVICE_TOKEN=dev-token, MOCK_OMNI=1, USE_VECTORIZE=0
pnpm dev                                                    # builds the web apps and runs wrangler dev on :8787
# dashboard:  http://localhost:8787/dash/?token=dev-token
# wearer app (no hardware): http://localhost:8787/?token=dev-token&mode=mock&dev=1   -> Start, then "place keys" / "hold to talk"
```

In a desktop browser the wearer app uses web fallbacks: Space = talk, N = narrate a placement, hold M = recenter, arrow keys =
fake head turn.

## Cloudflare setup

```bash
cd apps/worker
npx wrangler login
npx wrangler vectorize create lastseen-objects --dimensions=768 --metric=cosine
# optional, keyframe storage (enable R2 once in the dashboard first): wrangler r2 bucket create lastseen-frames, then uncomment r2_buckets
echo -n "<a long random token>" | npx wrangler secret put DEVICE_TOKEN
npx wrangler deploy            # KV (BUDGET) is auto-provisioned on the first deploy
```

The Worker is `https://lastseen.<your-subdomain>.workers.dev`. `/api/health` is public; everything else needs the device token.
`wrangler.jsonc` ships with `MOCK_OMNI=1` so a fresh deploy never spends credit.

## OMNI (Huawei track)

```bash
# put OMNI_API_KEY, OMNI_BASE_URL, OMNI_MODEL in .env (see .env.example)
pnpm probe:omni
```

The probe writes the measured model list, image/audio input, audio output, streaming, JSON mode, tool calling and latency to
[docs/omni-capabilities.md](docs/omni-capabilities.md). Then `wrangler secret put OMNI_API_KEY` and set `MOCK_OMNI` to `0`.
A KV budget guard caps estimated spend (`OMNI_BUDGET_CAP_CAD`, default 30). Credit is limited: downscaled frames, at most 6 vision
calls per minute, the cheapest fast variant.

## Phone setup

* **Hardware probe app (milestone A0).** `pnpm i && pnpm android:build && pnpm android:install` builds and installs `apps/probe`, a plain Android app
  (`dev.lastseen.probe`, no Capacitor). `pnpm android:probe` runs the automated hardware probes (sensors, camera, camera ownership, foreground service,
  thermal soak, displays) on an attached Beam Pro, pulls the results and fills the tables in [docs/probe-results.md](docs/probe-results.md), which also holds the
  go/no-go decisions and the human checklists (keys, glasses display, glasses IMU). Toolchain (JDK 17+, Android SDK), wireless adb for the Beam Pro and
  troubleshooting: [docs/apk-setup.md](docs/apk-setup.md). This is a measuring tool, not the wearer app.
* **Wearer app (target).** The product shell and the Kotlin plugins (detector, pose, head pose, keys) are owned elsewhere
  ([NATIVE_CONTRACT.md](docs/NATIVE_CONTRACT.md)); until they land the app says so on the debug overlay and falls back per plugin.
* **Browser (fallback).** Open `https://<worker>/?token=<token>` in Chrome on the Beam Pro and tap Start (needed for camera, mic,
  sensor permissions). Uses the web camera fallback: frame-diff trigger, no detector.

HUD: pure black background (reads as see-through on the glasses), a bright green arrow, large text, amber dashed arrow in "zone" mode
when confidence is low or the object is far, a small always-visible recording indicator, and a debug overlay (tap the REC dot).

## Configuration

See [.env.example](.env.example). Highlights: `DEVICE_TOKEN`, `OMNI_*`, `MOCK_OMNI`, `RETENTION_HOURS` (24), `CAMERA_HFOV_DEG` (70),
`STEP_LENGTH_M` (0.7), `CANDIDATE_COOLDOWN_MS` (4000), `MAX_OMNI_PER_MIN` (6), `DEDUPE_WINDOW` (10), `CROP_MIN_PIXELS`, and the optional
remote detector `DETECTOR_URL` / `DETECTOR_SECRET` (off by default; only used when a candidate arrives without detections).

## Privacy and safety

* Object detection runs on the phone. Nothing leaves the device until the detector reports a placement, and then it is at most 6 keyframes
  (640 px JPEG) plus one bounded still. **No raw video is ever stored or uploaded.**
* After processing, only the single frame that became a thumbnail is kept; other keyframes and narration audio are deleted.
* Ledger rows, thumbnails and vectors expire after `RETENTION_HOURS` (scheduled purge). Say or click **forget everything** / **forget the keys**.
* Connections are bearer-authenticated (`DEVICE_TOKEN`, fail-closed). The client cannot write agent state.
* A recording indicator is always visible on the HUD. Glasses head pose never leaves the phone.
* Detector boxes are geometry only; the model is told never to describe faces or identities.

## Known gaps

See the summary at the end of the patch report and [docs/DECISIONS.md](docs/DECISIONS.md): the Kotlin plugins are owned by teammates,
zone anchors and `pose_correction` sending are not built, `pnpm probe:omni` has not been run (no key yet), and the deployed Worker
has not been redeployed since M0.
