# Native plugin contract (contract v2)

The wearer app ships as a **Capacitor Android APK** on the Xreal Beam Pro. `apps/wearable` is only the web layer
(TypeScript: HUD, voice, upload logic). Everything that touches hardware is a native Kotlin Capacitor plugin.
This document is the interface the Kotlin side implements. It is enforced by zod schemas in
[`packages/shared/src/native.ts`](../packages/shared/src/native.ts) and by the mocks in
[`apps/wearable/src/native/mock.ts`](../apps/wearable/src/native/mock.ts).

| Plugin (Capacitor name) | Owns | Owner |
| --- | --- | --- |
| `LastseenDetector` | CameraX camera, MediaPipe Object Detector (EfficientDet-Lite0 int8), keyframe ring buffer, stills, placement candidates | detection teammate |
| `LastseenPose` | Accelerometer/gyro/rotation-vector, heading, step counting and dead reckoning, stationary flag, put-down detection | pose owner |
| `LastseenHeadPose` | Xreal glasses head orientation (experimental) | HUD teammate |
| `LastseenKeys` | Hardware key events from the Activity (phone buttons, Bluetooth clicker/headset) | whoever owns `MainActivity` (suggest: HUD teammate) |

## Ground rules

1. **Clock: every `t` is epoch milliseconds** (`System.currentTimeMillis()`). Never `uptimeMillis()`,
   `elapsedRealtime()`, `nanoTime()`, seconds or microseconds. The validator rejects anything outside 2020-2100.
   The phone's wall clock is the single time base for frames, poses and events; the web layer compares them directly.
2. **The WebView never opens the camera.** Frames reach JS only through `LastseenDetector`. (The TS layer refuses to
   start its browser camera fallback inside the native shell.)
3. **Units and frames.** Meters, local frame **x east, y north**. Headings are **degrees clockwise from north** in `[0, 360)`.
   Bounding boxes are `[x, y, w, h]` **normalized 0..1, origin top-left** of the frame they belong to.
4. **Capacitor names** are exactly `LastseenDetector`, `LastseenPose`, `LastseenHeadPose`, `LastseenKeys`.
   Events are emitted with `notifyListeners(eventName, payload)`; methods resolve with the JSON below.
5. **Every plugin implements `ping()`** and resolves `{ "ok": true, "version": 1 }`. The web layer calls it at start-up: if it rejects
   (or the plugin is missing) the app reports "not implemented natively" and falls back per plugin (see *Fallbacks*).
   `ping()` must have no side effects.
6. **Images:** base64 JPEG, **no `data:` prefix**. **At most 6 keyframes, 640 px wide, quality about 0.6**, plus **one optional
   full-resolution still** (long edge at most 1920 px, under about 1 MB of base64; larger stills are dropped by the backend).
7. **Never call the network.** Native plugins only talk to the web layer. Uploads, auth and privacy filtering live in TS.
8. Errors: reject with a Capacitor error (`call.reject("message")`). Unknown methods reject with `UNIMPLEMENTED`
   (Capacitor does this by default).

## Shared shapes

```jsonc
// Frame (keyframes: w <= 640; jpegBase64 required. Stills: w/h up to 1920)
{ "t": 1789800000000, "w": 640, "h": 480, "hash": "3c3c3c3cc3c3c3c3", "jpegBase64": "/9j/4AAQ..." }

// Detection: normalized box in the frame it belongs to
{ "label": "cup", "score": 0.81, "bbox": [0.42, 0.55, 0.12, 0.16] }

// Pose: chest-mounted phone
{ "t": 1789800000000, "x": 1.4, "y": 3.5, "headingDeg": 92.5, "steps": 12, "confidence": 0.93, "stationary": false }
```

`hash` is a 64-bit **average hash** of the frame (8x8 grayscale, bit = pixel >= mean) as 16 hex characters. The backend
treats hashes within 4 bits of each other as the same scene (duplicate suppression), so use a perceptual hash, not a file checksum.

---

## `LastseenDetector`

### Methods

| Method | Args | Resolves | Notes |
| --- | --- | --- | --- |
| `ping()` | none | `{ok:true,version:1}` | |
| `start(config)` | `{fps, keyframeWidthPx, jpegQuality, scoreThreshold, settleMs, ringSeconds}` | void | Opens CameraX (rear camera, upright portrait), loads the model, starts the ring buffer. Defaults: `{fps:2, keyframeWidthPx:640, jpegQuality:0.6, scoreThreshold:0.35, settleMs:800, ringSeconds:6}` |
| `stop()` | none | void | Releases the camera. |
| `getStatus()` | none | `DetectorStatus` | `{running, ready, fps, model, ringFrames, note?}`. `ready:false` while the model loads. |
| `getFrames(args)` | `{fromT, toT, maxFrames}` | `{frames, detections?}` | Frames from the ring buffer with `fromT <= t <= toT`, **oldest first, at most `min(maxFrames, 6)`, evenly spread**. `maxFrames: 1` returns the **newest** frame in range. `detections` aligned index-for-index with `frames`. Empty range returns `{frames: []}`. |
| `captureStill()` | none | `{frame: Frame \| null}` | One high-quality still (long edge <= 1920). `null` if the camera is not running. |

### Events

`placementCandidate` fires once when an object was put down: something entered the scene, then the scene stayed still for
`settleMs`. Payload:

```jsonc
{
  "t": 1789800000000,                    // when the scene settled (epoch ms)
  "trigger": "detector",                 // always "detector" from native
  "frames": [ /* 1..6 keyframes, oldest first, spanning before / during / after */ ],
  "stillFrame": { /* optional, <= 1920 px */ },
  "detections": [ [], [], [ { "label": "cup", "score": 0.81, "bbox": [0.42, 0.55, 0.12, 0.16] } ] ]
  //             ^ one array per keyframe, same order. Boxes of the LAST frame matter most:
  //               the backend asks OMNI "which detection index is the new object?" for that frame.
}
```

`detections` (debug only, never uploaded): `{ "t": ..., "detections": [ ... ] }` at most once per analyzed frame.

### What the web layer does with it

`placementCandidate` -> `CandidateFilter` (drops it if the wearer was walking in `[t-1.5 s, t+0.5 s]` using the pose ring
buffer, then a 4 s cooldown) -> attaches `poseSlice` + `hfovDeg` -> uploads. Backup triggers (voice narration key, dashboard
remote button, `putDown`) call `getFrames({fromT: t-3000, toT: now, maxFrames: 6})` + `captureStill()` instead.
So the ring buffer must keep the last **6 s** of frames even when no candidate fires.

Recommendations: run the detector on the analysis stream, not the still; compute the perceptual `hash` from the same
grayscale you already have; keep JPEG encoding off the analysis thread.

---

## `LastseenPose`

### Methods

| Method | Args | Resolves | Notes |
| --- | --- | --- | --- |
| `ping()` | none | `{ok:true,version:1}` | |
| `start(config)` | `{stepLengthM, sampleHz}` | void | Defaults `{0.7, 5}`. Starts sensors. |
| `stop()` | none | void | |
| `calibrateForward()` | none | void | The wearer is facing straight ahead of their body **right now**: derive the chest-mount yaw offset so `headingDeg` is the direction the wearer faces. |
| `calibrateStepLength({distanceM})` | `{distanceM}` | `{stepLengthM}` | The wearer just walked `distanceM` in a straight line: `stepLengthM = distanceM / stepsSinceStartOfWalk`. Valid range 0.3-1.5. |
| `getPoseAt({t})` | `{t}` | `{pose: Pose \| null}` | From a native pose history (>= 10 min); interpolate between samples; `null` if unknown. |

### Events

`pose`: a `Pose` at `sampleHz` (5 Hz), **and immediately on every stationary transition** (start/stop of walking).
`putDown`: `{ "t": ... }` when the phone dips or the wearer bends to put something down (optional; `t` = moment of the dip).

### Semantics

* **Heading** = azimuth of the camera-forward direction (device **-Z**), projected on the horizontal plane, from the **full
  rotation matrix** (`SensorManager.getRotationMatrixFromVector` on `TYPE_ROTATION_VECTOR`, then remap), **not** raw azimuth/alpha:
  the phone is upright on the chest, where Euler azimuth is degenerate. A reference implementation is
  `headingFromOrientation` in `packages/shared/src/geometry.ts` (with unit tests).
* **Steps:** accelerometer-magnitude peak detector, adaptive threshold, minimum 300 ms between steps
  (`StepDetector` in shared is the reference). Position: `p += L * (sin h, cos h)` per step, `L = stepLengthM`.
* **`stationary`** = no step in the last **1500 ms**. This drives the walking filter, so be accurate.
* **`confidence`** decays with steps and time since the last anchor: `exp(-steps/120) * exp(-seconds/600)` (see `poseConfidence`).
* `steps` is monotonically increasing since `start()`.
* Zone-anchor corrections (`pose_correction` from the agent) are applied by the **web layer** on top of your raw poses; do not
  try to apply them natively.

---

## `LastseenHeadPose` (experimental)

| Method | Resolves | Notes |
| --- | --- | --- |
| `ping()` | `{ok:true,version:1}` | |
| `start()` / `stop()` | void | Starts the Xreal head tracking. |
| `zeroView()` | void | Treat the current head yaw as straight ahead (native side re-zeroes its own reference). |

Event `headPose`, **at least 30 Hz** while tracking: `{ "t": ..., "yawDeg": 212.4, "pitchDeg": -6.1, "source": "glasses" }`
with `yawDeg` in `[0, 360)` increasing **clockwise** (same sense as headings) and an arbitrary origin, and `pitchDeg` in `[-90, 90]`.

The web layer aligns the origin with the chest heading (`headOffsetDeg = calibrateHeadOffset(pose, headPose)`, triggered by the
agent tool `recenter` or a long-press on a media key). A head pose older than **300 ms** is ignored and the arrow falls back to the
chest heading, so a dropped tracker degrades gracefully. **`headPose` never leaves the phone.**

---

## `LastseenKeys`

| Method | Resolves |
| --- | --- |
| `ping()` | `{ok:true,version:1}` |
| `start()` / `stop()` | void |

Event `key`: `{ "t": ..., "keyCode": 24, "action": "down" }` (`action`: `"down"` or `"up"`). Forward **every** `KeyEvent` seen by the
Activity (`dispatchKeyEvent`), do not synthesize repeats (send only the first `down`; the web layer also ignores repeats).
**Consume** the volume keys while the app is in the foreground so the system volume UI does not appear.

Meaning is decided in TS (`apps/wearable/src/keyGestures.ts`):

| Keys | Action |
| --- | --- |
| `KEYCODE_VOLUME_UP` (24), `KEYCODE_HEADSETHOOK` (79), `KEYCODE_MEDIA_PLAY_PAUSE` (85) | hold = push-to-talk query |
| `KEYCODE_VOLUME_DOWN` (25) | hold = narrate a placement ("putting my keys here") |
| `KEYCODE_MEDIA_NEXT` (87), `KEYCODE_MEDIA_PREVIOUS` (88) | **long-press >= 1.2 s** = recenter the glasses view |

Screen taps are not used: with the phone on the chest the screen faces the wearer's body.

---

## Fallbacks when a plugin is missing

Selection is per plugin at start-up (`apps/wearable/src/native/select.ts`):

| Plugin | Answers `ping()` | Missing |
| --- | --- | --- |
| Detector | native | **silent mock** (no detections). Never the browser camera. |
| Pose | native | WebView DeviceOrientation + accelerometer |
| HeadPose | native | mock (chest heading only) |
| Keys | native | keyboard events (only useful with a BT keyboard) |

The debug overlay (tap the REC dot) prints each plugin's mode and reason, for example `Detector: mock - not implemented natively; no detector running`.

---

## Verify your plugin against the mocks (checklist)

Install and run once: `pnpm install`. Everything below works without a phone unless it says so.

**Any plugin**

- [ ] `pnpm validate:native list` shows your plugin and its payload names.
- [ ] `pnpm validate:native example <plugin> <payload>` prints a valid sample; diff your real payload against it.
- [ ] Capture a real payload (logcat or the Capacitor bridge log), save it as `payload.json`, then
      `pnpm validate:native <plugin> <payload> payload.json` says `OK`. Repeat for **every** method result and event.
- [ ] All `t` values are epoch ms (the validator fails on uptime/seconds).
- [ ] `ping()` answers within 1.5 s and has no side effects; calling an unknown method rejects.

**Detector**

- [ ] `getFrames` returns at most 6 frames, oldest first, `w <= 640`, JPEG bytes present, no `data:` prefix.
- [ ] `getFrames({maxFrames:1})` returns the **newest** frame; an empty range returns `{frames: []}`.
- [ ] `detections.length === frames.length` whenever `detections` is present; all boxes normalized, origin top-left.
- [ ] Put a mug on a table, keep still: exactly one `placementCandidate` about `settleMs` after it stops moving; none while you wave the camera around.
- [ ] `captureStill` is <= 1920 px on the long edge and < 1 MB of base64.
- [ ] Hashes of two consecutive shots of the same static scene differ by <= 4 bits; different scenes differ by many.
- [ ] Camera keeps working with the screen dimmed and the app in the foreground for 10 minutes; `stop()` releases it.

**Pose**

- [ ] `stationary` flips to `false` within about one step of starting to walk and to `true` about 1.5 s after stopping.
- [ ] Walk 10 m in a straight line: `y` (facing north) increases by about 10 m within your step-length error; `calibrateStepLength({distanceM:10})` fixes it.
- [ ] Turn 90 degrees clockwise: `headingDeg` increases by 90 (wraps 359 -> 0). Phone **upright on the chest**, not flat.
- [ ] `getPoseAt` matches the emitted poses at the same timestamps.

**HeadPose**

- [ ] `yawDeg` increases when you turn your head right; >= 30 Hz; `zeroView()` makes the current yaw the new reference.

**Keys**

- [ ] Volume up/down and a Bluetooth clicker produce `down` then `up`; the system volume bar does not appear.

**End to end with the real web layer**

- [ ] Build the web layer for the APK: `pnpm --filter @lastseen/wearable build:apk` (outputs `apps/wearable/dist`, `capacitor.config.json` points at it).
- [ ] Start the app: the debug overlay shows `Detector: native - native plugin v1` etc. instead of `mock`/`web`.
- [ ] Replay the same scenarios the mocks use with `pnpm sim:local` (they exercise the same `Bridge`/`CandidateFilter` code with mock plugins). If the real phone behaves differently from the sim for the same story, the difference is in your plugin.
