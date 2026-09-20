# Glasses IMU probe (time-boxed, separate from the app)

Question: can we read head orientation from the Xreal One glasses on the Beam Pro, so the HUD arrow follows the head instead of the chest?
This is a **30 minute** feasibility check of a third-party library. **Nothing is integrated.** Result goes into [probe-results.md](probe-results.md) section 9.

## What was evaluated

| | |
| --- | --- |
| Project | <https://github.com/Skarian/one-xr> (Android library `io.onexr` + demo app `io.onexr.demo`) |
| Commit | `c7b0004` ("make glasses_version forward-compatible with warning-only validation") |
| License | **MIT**, Copyright (c) 2026 Neil Skaria (`LICENSE`), plus `THIRD_PARTY_NOTICES.md` for its references. Fine to use with attribution. |
| Status | **Unofficial.** Written against reverse-engineered protocol notes; the README says it targets **XREAL One and XREAL One Pro**. Whether it works on the **base XREAL One** is unknown until tested. |
| Where | cloned to `tools/one-xr` (git-ignored, not part of this repo) |
| Requirements (from its `docs/android-library.md`) | Android `minSdk 26`; a **network path to the glasses** (default link-local host `169.254.2.1`, control port `52999`, stream port `52998`); glasses in **Follow** mode; `INTERNET` + `ACCESS_NETWORK_STATE` permissions |
| Outputs | `sensorData` (IMU + magnetometer), `poseData` (`absoluteOrientation`, `relativeOrientation`, degrees), `zeroView()`, `recalibrate()`, stream diagnostics (`trackingHz`, receive-interval min/avg/max) |

## Build (done)

```bash
cd tools/one-xr
export JAVA_HOME=~/.jdks/temurin-21 ANDROID_HOME=~/AppData/Local/Android/Sdk   # any JDK >= 17 works for it
./gradlew :app:assembleDebug
# -> app/build/outputs/apk/debug/app-debug.apk   (package io.onexr.demo, compileSdk 35, AGP 8.6.1, Gradle 8.7)
```

**Build outcome on the dev PC: SUCCESS.** `BUILD SUCCESSFUL in 6m 23s` (mostly first-time downloads: Gradle 8.7, dependencies, and Gradle auto-installed Platform 35 and Build-Tools 34). APK: `tools/one-xr/app/build/outputs/apk/debug/app-debug.apk`, 6.6 MB, package `io.onexr.demo`, permissions INTERNET and ACCESS_NETWORK_STATE only. It compiled unmodified with JDK 21.

## On-device steps (HUMAN, about 15 minutes)

You need the Beam Pro, the glasses, and a way to run adb without a cable (the glasses use a USB-C port): see wireless adb in [apk-setup.md](apk-setup.md#3-connecting-the-beam-pro).

1. **Install the demo:**
   ```bash
   adb install -r tools/one-xr/app/build/outputs/apk/debug/app-debug.apk
   adb shell am start -n io.onexr.demo/.HomeActivity
   ```
2. **Connect the glasses** to the Beam Pro's USB-C port and confirm the normal XREAL display works.
3. On the glasses set the mode to **Follow** with **stabilization off** (the README's requirement; the exact menu/button is on the glasses' on-screen menu, not in the library).
4. Record how the glasses appear to Android, for later integration: `adb shell ip addr` and note any new interface holding a `169.254.x.x` address (**TODO**).
5. In the demo open **Sensor Demo**, keep the default host/ports (`169.254.2.1`, 52999/52998), tap **Start**, and **keep still until calibration reaches 100%** (the status shows `calibrating x% (n/target)`). Record the time it took and any error (`No matching Android Network candidate ...` or `Timed out waiting for first valid report ...`, see its troubleshooting).
6. Face straight ahead and tap **Zero View**.
7. **Yaw tracking:** turn your head **90 degrees left**, back to centre, **90 degrees right**, back. Watch the pose readout (or the 3D view). Record: does yaw follow smoothly (no jumps or lag), which direction is positive, how many degrees it reports for a true 90 degree turn.
8. **Update rate:** read `trackingHz` and the `rxMs[min,avg,max]` from the status line / the `diag` log lines while turning (**TODO**). We want >= 30 Hz with a small max gap.
9. **Drift:** press **Zero View** with the head still, note the yaw, keep completely still for **2 minutes**, note the yaw again. Drift = the difference (**TODO** degrees). If it drifts, tap **Recalibrate** and repeat once to see whether that helps.
10. **With video output:** repeat steps 7-9 while the phone is showing the HUD/display-probe to the glasses (open our app's **Display probe** first, then bring the demo to the foreground, or use split screen if the Beam Pro allows it). Both the display and the IMU stream must work at once (**TODO**).
11. Note whether `Raw IMU` vs `Smooth IMU` pose mode changes the feel.

## Pass / fail (proposed)

| Check | Pass if |
| --- | --- |
| Connects | `Start` succeeds and reaches streaming with the glasses in Follow mode |
| Calibration | completes without error in under about 30 s |
| Yaw | tracks a 90 degree turn within +/-5 degrees, smooth, no jumps > 10 degrees between samples |
| Rate | `trackingHz` >= 30 Hz |
| Drift | < 3 degrees over 2 minutes still |
| Video | all of the above still true while the phone outputs video to the glasses |
| Overall | all rows pass on the **base XREAL One** |

If it fails or is flaky: the design already falls back to the chest heading (glasses head pose is optional and local to the phone).

## If it passes, later (not now)

Wrap it as the native `LastseenHeadPose` plugin from [NATIVE_CONTRACT.md](NATIVE_CONTRACT.md): map `relativeOrientation` yaw to `yawDeg` in `[0, 360)`
increasing clockwise (check the sign from step 7), emit `headPose` at >= 30 Hz with epoch-millisecond timestamps, implement `zeroView()` with the library's
`zeroView()`, and keep it strictly local. Open questions to answer then: the licence attribution in the app, the glasses' mode requirement (Follow, stabilization off) versus the
mode the display needs, whether another app (Nebula) holding the control connection blocks ours, and what happens on reconnect/hot-unplug.

## Results

| Item | Result |
| --- | --- |
| Demo APK built on the dev PC | **done**: builds unmodified, 6.6 MB (see *Build*) |
| Demo installed and connected on the Beam Pro | TODO |
| Calibration | TODO |
| Yaw tracking (smooth? direction? 90 degree accuracy) | TODO |
| Update rate (Hz), max gap (ms) | TODO |
| Drift over 2 min (degrees) | TODO |
| Works while outputting video | TODO |
| Base XREAL One (not One Pro) | TODO |
| **Overall** | TODO pass / fail |
