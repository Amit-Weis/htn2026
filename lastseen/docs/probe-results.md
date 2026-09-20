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
| Model / Android / API | XREAL X4000 · Android 14 (API 34) |
| WebView package + version | com.google.android.webview 126.0.6478.71 |
| CPU cores / ABIs | 8 / arm64-v8a, armeabi-v7a, armeabi |
| Permissions at start | `{"camera":true,"microphone":true,"notifications":true,"activityRecognition":true}` |
| Permissions after the request step | `{"camera":"granted","microphone":"granted","notifications":"granted","activityRecognition":"granted"}` |
| Start-of-run thermal status / battery temp (°C) | 0 / 26.0 |
<!-- /AUTO:device -->

## 2. Sensors (AUTO, plus HUMAN for the step detector)

Walk normally during the 5 s sensor test to get step events: **HUMAN**. `rotation_vector` is the heading source for the chest pose; `game_rotation_vector` has no
magnetometer (drift-prone but not disturbed by magnets); the accelerometer is the fallback for step detection (`StepDetector` in shared needs >= 50 Hz).

<!-- AUTO:sensors -->
| Sensor | Present | Advertised max Hz | Achieved Hz (wall) | Achieved Hz (sensor clock) | Events | Max gap ms | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| rotation_vector | yes | 200 | 198.6 | 200.1 | 993 | 5 | continuous |
| game_rotation_vector | yes | 200 | (not streamed) |  |  |  | continuous |
| step_detector | yes | n/a (event-driven) | 0.0 | n/a | 0 | 0 | HUMAN: walk during the 5 s test. needs the wearer to WALK during the test; 0 events while still is expected |
| accelerometer | yes | 400 | 399.6 | 400.3 | 1998 | 3 | continuous |
| gyroscope | yes | 400 | (not streamed) |  |  |  | continuous |
| magnetometer | yes | 100 | (not streamed) |  |  |  | continuous |
<!-- /AUTO:sensors -->

## 3. Camera (AUTO)

<!-- AUTO:camera -->
| Id | Facing | Focal (mm) | Sensor (mm) | FOV short side (°) | FOV long side (°) | Logical multi-cam | 640x480 / 1280x720 / 1920x1080 | YUV sizes (largest first) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | back | 2.1600000858306885 | 5.23 x 3.94 | 84.8 | 100.9 | no | yes / yes / yes | 4080x3072, 4000x3000, 3072x3072, 4080x2296, 3840x2160, 3280x2460 |
| 1 | front | 2.760999917984009 | 3.66 x 2.74 | 52.8 | 67.0 | no | yes / yes / yes | 3264x2448, 3200x2400, 3264x1836, 2448x2448, 2592x1944, 2592x1940 |

| Field | Value |
| --- | --- |
| **FOV, short side (portrait horizontal): use for `CAMERA_HFOV_DEG`** (first back camera; smaller if the stream crops the sensor) | 84.8 |
| Multiple back cameras? (ids) | no (0) |
| Analysis stream size (requested 1280x720) | 1280 x 960 (rotation 90°) |
| **Steady-state fps** | 29.9 |
| Frame interval mean / p95 / max (ms) | 33.5 / 34.9 / 37.7 |
| Stream error, if any | none |
| **640 px JPEG**: size (bytes) / dimensions | 27058 / 640 x 853 |
| 640 px JPEG: encode time, first (cold) / typical median (ms) | 44.1 / 29.7 |
| Two cameras open at once? | yes — pair 0+1, {"0":"opened","1":"opened"} |
| Camera2 concurrent id sets (API 30+) | `[["1"],["0","1"]]` |
<!-- /AUTO:camera -->

## 4. Camera ownership / exclusivity (AUTO)

<!-- AUTO:exclusivity -->
| Question | Result |
| --- | --- |
| WebView `getUserMedia({audio:true})` while the native camera streams (also confirms the mic prompt path) | yes |
| WebView `getUserMedia({video:true})` while the native camera streams | yes |
| Native stream keeps delivering after the WebView tried the camera? | yes |
| Native can open the camera while the WebView holds it? | yes |
| WebView permission requests seen (audio attempt / video attempt) | ["android.webkit.resource.AUDIO_CAPTURE"] → granted / ["android.webkit.resource.VIDEO_CAPTURE"] → granted |
| WebView errors (audio / video) | none / none |
| Verdict | WebView CAN open the camera while native streams: ownership must be enforced in code (never open it in the WebView) |
<!-- /AUTO:exclusivity -->

## 5. Foreground service (AUTO, plus HUMAN)

<!-- AUTO:foreground -->
| Field | Result |
| --- | --- |
| Started on this Android version with camera + microphone types | yes (API 34) |
| Error, if any (verbatim) | none |
| Still running 1.5 s later | yes |
| Notifications enabled for the app | yes |
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
| 0 | Built-in Screen | 1080 x 2400 | 60 | 480 | 0 | no |

Display count: 1 (more than 1 means the glasses appear as a separate display; 1 means a mirror). Presentation display ids: []. Activity window: 1080 x 2400 px, portrait.
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
