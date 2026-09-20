# Probe results (milestone A0)

**Status: the probe app and the pipeline are built and verified off-device; no device probe has run yet.** No Android device was attached when this was built
(`adb devices` was empty), so every table in an `AUTO` block below is `TODO` until the first `pnpm android:probe` on the Beam Pro fills it, and every `HUMAN`
field needs a person. Nothing in those tables has been guessed.

How to fill this in:

1. `pnpm android:build && pnpm android:install`, then `pnpm android:probe -- --soak 10` (see [apk-setup.md](apk-setup.md)). That pulls the device files into
   `docs/probe-data/<timestamp>/` and **rewrites every `AUTO` block in this file** from them (the same tables are also saved as `summary.md` next to the data).
   Do not hand-edit inside an `AUTO` block: the next run replaces it. Re-render without a device: `pnpm android:report [dir]`.
2. Do the `HUMAN` items on the device (the app's **Start key probe** and **Display probe (glasses)** buttons) and type the results into the tables outside the `AUTO` blocks.

Legend: `AUTO` measured by the app · `HUMAN` needs a person · `TODO` not yet recorded · `VERIFIED` checked during the build (source, APK or desktop; not on the Beam Pro).

## 0. Verified while building (not on the Beam Pro)

| Fact | How it was verified | Result |
| --- | --- | --- |
| APK identity and levels | `aapt2 dump badging` on `app-debug.apk` | `dev.lastseen.probe`, compileSdk/targetSdk 36, minSdk 24, launchable `ProbeActivity` |
| Requested permissions | same | CAMERA, RECORD_AUDIO, INTERNET, ACCESS_NETWORK_STATE, WAKE_LOCK, POST_NOTIFICATIONS, FOREGROUND_SERVICE, FOREGROUND_SERVICE_CAMERA, FOREGROUND_SERVICE_MICROPHONE **+ MODIFY_AUDIO_SETTINGS, ACTIVITY_RECOGNITION, HIGH_SAMPLING_RATE_SENSORS** (why: [apk-setup.md](apk-setup.md#5-things-learned-while-building-a0)) |
| Foreground service type | merged manifest (`aapt2 dump xmltree`) | `foregroundServiceType = 0xc0` = camera (0x40) + microphone (0x80) |
| Cleartext / orientation | merged manifest | `usesCleartextTraffic=false`; no `screenOrientation` (not locked) |
| Kotlin compiles, APK builds from Gradle | `pnpm android:build` | `BUILD SUCCESSFUL`, `app-debug.apk` about 5.7 MB |
| Probe logic unit tests | `pnpm android:test` | 8 JVM tests pass (JSON helpers incl. NaN handling, exclusivity verdict logic, error field parsing) |
| Report generator | `pnpm test` (`scripts/probe-report.test.ts`) | 7 tests pass against a report shaped like the Kotlin output; an empty report renders all `TODO`. **The real device JSON has not been seen yet**, so the first real run may expose a key mismatch: check `summary.md` for unexpected `TODO`s |
| WebSocket round trip to the deployed Worker (historical) | headless Chrome on the dev PC, earlier A0 build (Capacitor Home screen) | 24-29 ms. **Not part of the probe app any more** (see [DECISIONS.md](DECISIONS.md) 51); the phone-to-Worker RTT is unmeasured |

## 1. Device (AUTO)

<!-- AUTO:device -->
| Field | Value |
| --- | --- |
| Model / Android / API | TODO |
| WebView package + version | TODO |
| CPU cores / ABIs | TODO |
| Permissions at start | TODO |
| Permissions after the request step | TODO |
| Start-of-run thermal status / battery temp (°C) | TODO |
<!-- /AUTO:device -->

## 2. Sensors (AUTO, plus HUMAN for the step detector)

Walk normally during the 5 s sensor test to get step events: **HUMAN**. `rotation_vector` is the heading source for the chest pose; `game_rotation_vector` has no
magnetometer (drift-prone but not disturbed by magnets); the accelerometer is the fallback for step detection (`StepDetector` in shared needs >= 50 Hz).

<!-- AUTO:sensors -->
| Sensor | Present | Advertised max Hz | Achieved Hz (wall) | Achieved Hz (sensor clock) | Events | Max gap ms | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| rotation_vector | TODO | TODO | (not streamed) |  |  |  |  |
| game_rotation_vector | TODO | TODO | (not streamed) |  |  |  |  |
| step_detector | TODO | TODO | (not streamed) |  |  |  | HUMAN: walk during the 5 s test. |
| accelerometer | TODO | TODO | (not streamed) |  |  |  |  |
| gyroscope | TODO | TODO | (not streamed) |  |  |  |  |
| magnetometer | TODO | TODO | (not streamed) |  |  |  |  |
<!-- /AUTO:sensors -->

## 3. Camera (AUTO)

<!-- AUTO:camera -->
| Id | Facing | Focal (mm) | Sensor (mm) | FOV short side (°) | FOV long side (°) | Logical multi-cam | 640x480 / 1280x720 / 1920x1080 | YUV sizes (largest first) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO |

| Field | Value |
| --- | --- |
| **FOV, short side (portrait horizontal): use for `CAMERA_HFOV_DEG`** (first back camera; smaller if the stream crops the sensor) | TODO |
| Multiple back cameras? (ids) | TODO |
| Analysis stream size (requested 1280x720) | TODO |
| **Steady-state fps** | TODO |
| Frame interval mean / p95 / max (ms) | TODO |
| Stream error, if any | TODO |
| **640 px JPEG**: size (bytes) / dimensions | TODO |
| 640 px JPEG: encode time, first (cold) / typical median (ms) | TODO |
| Two cameras open at once? | TODO |
| Camera2 concurrent id sets (API 30+) | TODO |
<!-- /AUTO:camera -->

## 4. Camera ownership / exclusivity (AUTO)

<!-- AUTO:exclusivity -->
| Question | Result |
| --- | --- |
| WebView `getUserMedia({audio:true})` while the native camera streams (also confirms the mic prompt path) | TODO |
| WebView `getUserMedia({video:true})` while the native camera streams | TODO |
| Native stream keeps delivering after the WebView tried the camera? | TODO |
| Native can open the camera while the WebView holds it? | TODO |
| WebView permission requests seen (audio attempt / video attempt) | TODO |
| WebView errors (audio / video) | TODO |
| Verdict | TODO |
<!-- /AUTO:exclusivity -->

## 5. Foreground service (AUTO, plus HUMAN)

<!-- AUTO:foreground -->
| Field | Result |
| --- | --- |
| Started on this Android version with camera + microphone types | TODO |
| Error, if any (verbatim) | TODO |
| Still running 1.5 s later | TODO |
| Notifications enabled for the app | TODO |
<!-- /AUTO:foreground -->

| Check | Result |
| --- | --- |
| Notification "Lastseen running" visible (press **Start FG service**, pull the shade) | HUMAN: TODO |
| Stop button in the notification works | HUMAN: TODO |
| Survives pressing Home / screen off (the probe's CameraX is bound to the Activity: expect the camera to stop; the *service* should stay) | HUMAN: TODO |

## 6. Hardware keys (HUMAN)

Press **Start key probe** (tick *also listen via MediaSession* on a second pass), press each button, and record which source reported it. Events are also saved on the device as
`keys-<epoch>.jsonl` (pulled by `pnpm android:probe` if a key session preceded it, or `adb pull` the folder).

| Button | Activity key event (`source: activity`) | MediaSession (`source: mediaSession`) | Notes |
| --- | --- | --- | --- |
| Phone volume up | TODO | TODO | |
| Phone volume down | TODO | TODO | |
| Bluetooth clicker: play/pause | TODO | TODO | model: TODO |
| Bluetooth clicker: next / previous | TODO | TODO | |
| Headset hook (if any) | TODO | TODO | |
| Long-press (>= 1.2 s) reported as down ... up with the right timestamps? | TODO | TODO | `t` must be epoch ms |
| Volume UI stays hidden while probing | TODO | | keys are consumed |

## 7. Thermal soak (AUTO after `--soak 10`)

`soak-*.csv` columns: fps, thermal_status, thermal_headroom_10s, battery_temp_c, battery_level_pct, battery_current_ua, charging.
Run with the case on, screen on, phone on the chest or in a similar enclosure if possible; **HUMAN**: note the conditions in the table under the block.

<!-- AUTO:soak -->
| Metric | Start | End | Notes |
| --- | --- | --- | --- |
| fps (10 s window) | TODO | TODO | drop % = TODO |
| Highest thermal status seen (0 none .. 6 shutdown) | TODO | TODO | first >= 2 (moderate): TODO |
| Thermal headroom (10 s forecast; 1.0 = throttle point) | TODO | TODO |  |
| Battery temperature (°C) | TODO | TODO |  |
| Battery level (%) / charging | TODO | TODO |  |
<!-- /AUTO:soak -->

| Conditions (HUMAN) | Value |
| --- | --- |
| Ambient temperature, case on/off, charging, glasses attached, phone on the chest or on a desk | TODO |

## 8. Display probe (AUTO + HUMAN)

Open **Display probe (glasses)** (pure black, immersive: viewport size and density, corner markers, grid, rotating green arrow, colour swatches, font ladder 24/32/48/64;
the ladder is in **dp**, which equals CSS px in a WebView). Do it twice: phone **portrait**, then **landscape** (orientation is not locked). Wear the glasses connected and in
the mode you plan to demo.

Android's own view of the displays (**AUTO**, from the last `pnpm android:probe`): `displayCount > 1` means the glasses appear as a separate display (a Presentation can target it);
`displayCount == 1` means a mirror.

<!-- AUTO:display -->
| Display id | Name | Size (px) | Hz | dpi | Rotation | Presentation-capable |
| --- | --- | --- | --- | --- | --- | --- |
| TODO | TODO | TODO | TODO | TODO | TODO | TODO |

Display count: TODO (more than 1 means the glasses appear as a separate display; 1 means a mirror). Presentation display ids: TODO. Activity window: TODO.
<!-- /AUTO:display -->

| Question (HUMAN) | Portrait | Landscape |
| --- | --- | --- |
| What do the glasses show (mirror of the phone screen, extended desktop, something else)? | TODO | TODO |
| Aspect ratio seen in the glasses; pillarboxing / letterboxing (black bars)? | TODO | TODO |
| Are all four corner markers (TL TR BL BR) visible? Is anything cropped? | TODO | TODO |
| Is the grid square and is the frame border complete? | TODO | TODO |
| Is text readable: 24 / 32 / 48 / 64 (smallest comfortable size) | TODO | TODO |
| Does pure black look see-through (compare the `#000000`, `#202020` swatches)? Is green `#39ff14` comfortable and bright enough indoors/outdoors? | TODO | TODO |
| Does the rotating arrow look smooth (no judder/lag)? | TODO | TODO |
| Any burn-in / brightness auto-dimming when the screen is mostly black? | TODO | TODO |
| Can the app stay **portrait** on the phone (chest mount) while the glasses view is usable? If the glasses follow the phone's rotation, what is the best combination? | TODO | |
| Viewport reported on screen (`viewport W x H px`, density) | TODO | TODO |

## 9. Glasses IMU (HUMAN, separate, time-boxed)

See [glasses-imu-probe.md](glasses-imu-probe.md). Record the outcome here:

| Check | Result |
| --- | --- |
| Demo installs and connects to the glasses (Follow mode, stabilization off) | TODO |
| Calibration completes | TODO |
| Yaw tracks a 90 degree left/right head turn smoothly | TODO |
| Update rate (Hz) | TODO |
| Yaw drift over 2 min still (deg) | TODO |
| Works while the Beam Pro outputs video to the glasses | TODO |
| Works on the base XREAL One (the README names One and One Pro) | TODO |
| Overall | TODO pass / fail |

## 10. Go / no-go (decisions each probe informs)

Thresholds are proposals to make the decision fast; change them if the demo needs differ. "Default" is what to do if a probe was not run.

| Probe | Decision it informs | GO if | NO-GO / fallback | Default |
| --- | --- | --- | --- | --- |
| Camera (sec. 3) | Can native CameraX feed the on-device detector, and at what resolution? | analysis stream >= 15 fps at 1280x720 (or >= 10 fps at 640x480) and a 640 px JPEG encodes in < 50 ms | drop the analysis size to 640x480, lower detector fps (the design needs about 2 fps), encode off the analysis thread | GO at 2 fps |
| Camera FOV (sec. 3) | Value of `CAMERA_HFOV_DEG` (bearing to object) | FOV short side measured | keep 70 only as a placeholder; wrong FOV skews every arrow | 70 (placeholder) |
| Multiple cameras / concurrent (sec. 3) | Is a second camera (stretch goal) possible | "Two cameras open at once" = yes for a back+back or back+front pair | drop the second-camera stretch | not needed for the MVP |
| Camera ownership (sec. 4) | Who may open the camera | any outcome; the product rule stays "the WebView never opens the camera". If the WebView is *refused* the camera while native streams, that is a free safety net; if it is *allowed*, enforcement is in code (already tested) | if native cannot open it while the WebView holds it, the WebView must never call getUserMedia({video}) (already true) | native owns the camera |
| Sensors (sec. 2) | Heading/step source for pose | rotation vector >= 50 Hz achieved and step detector present and firing | no step detector: use the accelerometer `StepDetector` (needs accelerometer >= 50 Hz); no rotation vector: game rotation vector + manual calibration | rotation vector + step detector |
| Thermal soak (sec. 7) | Can it run 2 fps detection continuously in a chest mount | thermal status stays <= LIGHT (1), fps drops < 25%, battery temp < 42 deg C after 10 min | reach MODERATE (2) or worse: lower fps/resolution, duty-cycle the detector (only analyze while stationary), plan a break in the demo | duty-cycled detection |
| Foreground service (sec. 5) | Can capture continue with the screen off / app backgrounded | "Started ... camera + microphone types" = yes on Android 14 | keep the app in the foreground with the screen on for the whole demo (already the plan: keep-screen-on) | screen-on foreground app |
| Hardware keys (sec. 6) | Push-to-talk source | volume keys and/or the clicker produce down+up, by either path | only mediaSession works: use the MediaSession path; nothing works: dashboard remote button + VAD only | volume keys + VAD |
| Display orientation (sec. 8) | Portrait vs landscape, mirror vs second display | glasses usable while the phone stays portrait; 32+ text readable; black reads as see-through | glasses need landscape: render the HUD rotated 90 degrees or mount the phone sideways | portrait, text >= 32 |
| Glasses head pose (sec. 9) | Use glasses yaw for the arrow | yaw tracks smoothly, >= 30 Hz, drift < 3 degrees over 2 min, works while video is output | otherwise chest heading only (already the fallback) | chest heading |
