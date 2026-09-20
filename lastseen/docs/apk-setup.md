# Android probe app setup (Xreal Beam Pro)

`apps/probe` is a plain Android app (Kotlin, Gradle, package `dev.lastseen.probe`): no Capacitor, no web layer, no product features. It measures the
Beam Pro's hardware (sensors, camera, thermal behaviour, foreground service, hardware keys, display) and the scripts around it are the pipeline:
**build → install → run probes on the device → pull the results → fill the tables in [probe-results.md](probe-results.md)**.
The product frontend and its native plugins are separate work ([NATIVE_CONTRACT.md](NATIVE_CONTRACT.md)).

## 1. Toolchain

| Tool | Version | Why |
| --- | --- | --- |
| Node | >= 22 | scripts and the report generator |
| pnpm | 10 | workspace |
| JDK | **17 or newer** (21 tested) | Android Gradle Plugin 8.13 needs 17+. The app compiles to Java/Kotlin 17 |
| Android SDK | platform **36**, build-tools **36.0.0**, platform-tools | `compileSdk = targetSdk = 36`, `minSdk = 24`, AGP 8.13.0, Kotlin 2.2.20, CameraX 1.6.2, Gradle 8.14.3 (downloaded by the wrapper) |
| adb | from platform-tools | install, logcat, pulling results |

Check what is installed: `pnpm android:doctor` (finds `JAVA_HOME` / `ANDROID_HOME` or the usual locations, lists attached devices; it never changes global settings).

### Windows (what was done on the dev machine, all user-local, no admin)

```powershell
# JDK 21 (17 also works)
Invoke-WebRequest "https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse" -OutFile $env:TEMP\jdk21.zip
Expand-Archive $env:TEMP\jdk21.zip $env:TEMP\jdk21x
Move-Item (Get-ChildItem $env:TEMP\jdk21x -Directory | Select-Object -First 1).FullName $env:USERPROFILE\.jdks\temurin-21

# Android command-line tools (current build number is in https://dl.google.com/android/repository/repository2-3.xml)
$sdk = "$env:LOCALAPPDATA\Android\Sdk"; mkdir "$sdk\cmdline-tools" -Force
Invoke-WebRequest "https://dl.google.com/android/repository/commandlinetools-win-16111833_latest.zip" -OutFile $env:TEMP\cmdtools.zip
Expand-Archive $env:TEMP\cmdtools.zip $env:TEMP\cmdx
Move-Item $env:TEMP\cmdx\cmdline-tools "$sdk\cmdline-tools\latest"

# SDK packages. NOTE the inner quotes: without them PowerShell/cmd split "platforms;android-36" at the semicolon.
$env:JAVA_HOME = "$env:USERPROFILE\.jdks\temurin-21"
& "$sdk\cmdline-tools\latest\bin\sdkmanager.bat" --sdk_root="$sdk" "platform-tools"
(1..30 | % { "y" }) | & "$sdk\cmdline-tools\latest\bin\sdkmanager.bat" --sdk_root="$sdk" '"platforms;android-36"' '"build-tools;36.0.0"'
```

`sdkmanager` asks you to accept the Android SDK licenses on the first package install; accepting is your decision.

### macOS / Linux

Install Temurin 17 or 21 (`brew install --cask temurin@21`, or your distro's `openjdk-21`) and the command-line tools from
<https://developer.android.com/studio#command-line-tools-only>, then run the same `sdkmanager` install (no extra quotes needed in bash).
Set `JAVA_HOME` and `ANDROID_HOME` (or use the default locations `pnpm android:doctor` looks in).

## 2. Build, install, run

From a clean clone:

```bash
pnpm i
pnpm android:build      # gradlew assembleDebug -> apps/probe/app/build/outputs/apk/debug/app-debug.apk (about 6 MB)
pnpm android:install    # adb install -r  (needs a device, see section 3)
pnpm android:run        # install + launch
pnpm android:logcat     # logcat filtered to the probe app and crashes
pnpm android:test       # JVM unit tests of the probe logic (no device needed)
```

`pnpm android:build` writes `apps/probe/local.properties` (git-ignored) from the SDK it finds. The first build downloads Gradle and the
dependencies (several minutes on a slow link); later builds take seconds. There is no web build step and no sync step.

The app id is `dev.lastseen.probe`, deliberately different from any product app so both can be installed side by side.
**Orientation is not locked** and the screen stays on while the app is open. Cleartext traffic is disabled (`usesCleartextTraffic=false`).

## 3. Connecting the Beam Pro

### Enable developer options and USB debugging

Menu names can differ slightly on the Beam Pro's Android 14 build; the flow is standard Android:

1. **Settings > About phone** (or *About tablet*) and tap **Build number** 7 times, enter the PIN if asked. "You are now a developer" appears.
2. **Settings > System > Developer options** (on some builds it is directly under Settings).
3. Turn on **Developer options**, then **USB debugging**.
4. Plug the Beam Pro into the PC with a USB-C data cable (not a charge-only cable) and unlock the screen.
5. Accept **Allow USB debugging?** on the phone (tick *Always allow from this computer*).
6. `adb devices -l` must list it as `device`.

The Beam Pro has two USB-C ports. The glasses occupy one and a charger may occupy the other, so you often cannot use a cable for adb: use wireless debugging.

### Wireless adb (no cable)

Android 11+ (the Beam Pro runs Android 14). Requires a recent platform-tools (`adb pair`) and the PC and Beam Pro on the **same Wi-Fi network**.

1. Developer options > **Wireless debugging** > turn on (allow on this network).
2. Tap **Pair device with pairing code**. Note the **IP:PAIRING_PORT** and the 6-digit code shown in the dialog.
3. On the PC: `adb pair <ip>:<pairing_port>` and type the code. Expect `Successfully paired`.
4. Back on the *Wireless debugging* screen, note the **IP address & Port** (this port is different from the pairing port).
5. `adb connect <ip>:<port>` then `adb devices -l` should show `<ip>:<port>  device`.

Alternative, needs a cable once: `adb tcpip 5555`, unplug, then `adb connect <ip>:5555`.
The pairing survives reboots but the connect port changes whenever wireless debugging is toggled or the Wi-Fi changes; repeat step 4-5.
With several devices attached set `ANDROID_SERIAL=<serial>` (the scripts refuse to guess).

### Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `adb devices` shows nothing | Charge-only cable or the port is in charge-only mode: pull down the USB notification and choose *File transfer / MTP*. Try the other USB-C port. On Windows install the Google USB Driver if the device shows as unknown in Device Manager. |
| `unauthorized` | Unlock the phone and accept the RSA prompt. If it never appears: Developer options > **Revoke USB debugging authorizations**, replug, `adb kill-server && adb start-server`. |
| `offline` | `adb kill-server`, replug or `adb connect` again; a stale wireless session is the usual cause. |
| `adb pair` fails / times out | Wrong port (pairing port vs connect port), code expired (they last about a minute), PC and phone on different networks, guest Wi-Fi with client isolation. |
| `INSTALL_FAILED_USER_RESTRICTED` | The OEM asks to confirm installs over USB: watch the phone screen, or enable *Install via USB* in Developer options if it exists. |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | Another build signed with a different key is installed: `adb uninstall dev.lastseen.probe`. |
| `INSTALL_FAILED_VERSION_DOWNGRADE` | `adb install -r -d ...` or uninstall first. |
| Build: `Android Gradle plugin requires Java 17 to run` | The scripts found a JDK older than 17. `pnpm android:doctor` shows which one; install Temurin 17 or 21. |
| Build: `SDK location not found` | `ANDROID_HOME` unset and the SDK is not in a standard location. Set it; `pnpm android:build` writes `apps/probe/local.properties` when it finds the SDK. |
| Build: `Failed to install the following Android SDK packages ... licenses` | Run `sdkmanager --licenses` (accepting is your decision) or install the packages named in the message. |
| `android:probe` times out waiting for `PROBE_DONE` | The screen was off or locked (the camera cannot open), or a permission dialog is showing. Unlock the phone, then `pnpm android:logcat` to see the step it stopped at. |
| `adb pull` returns nothing | The run did not finish saving. `adb shell ls /sdcard/Android/data/dev.lastseen.probe/files/probe/` (the **Files** button in the app lists the same folder). |
| `Camera ... already in use` / `CAMERA_DISABLED` | Another app holds the camera. Close the stock Camera app. |
| Wireless adb stops after the phone sleeps | Wireless debugging times out on some builds when the screen locks. Keep the screen on (the app does), or re-`adb connect`. |

## 4. Run the automated probes (the pipeline)

With a device attached and the APK installed:

```bash
pnpm android:probe                # about 40 s: device, permissions, display, sensors, camera, exclusivity, foreground service
pnpm android:probe -- --soak 10   # plus the 10-minute thermal soak (keep the app in the foreground)
pnpm android:report               # re-render the summary from the newest docs/probe-data/<timestamp>/ (no device needed)
```

`scripts/android.mjs probe` does, in order:

1. grants CAMERA / RECORD_AUDIO / POST_NOTIFICATIONS / ACTIVITY_RECOGNITION with `adb shell pm grant` (no dialogs on the device),
2. force-stops the app, wakes the screen, launches `ProbeActivity` with `--ez probe_autorun true --ei probe_soak_minutes N`,
3. waits for the `PROBE_DONE <path>` line in logcat (tag `LastseenProbe`; progress is printed as it goes),
4. `adb pull`s `/sdcard/Android/data/dev.lastseen.probe/files/probe/` into `docs/probe-data/<timestamp>/` (git-ignored; `adb pull` reads that folder without root),
5. runs `scripts/probe-report.ts`: writes `docs/probe-data/<timestamp>/summary.md` and fills the `AUTO` blocks in [probe-results.md](probe-results.md).
   Values the app did not measure stay `TODO`; nothing is guessed.

What lands on the device:

- `probe-report-<iso>.json`: one document with every automated result and a step table (a failing probe is recorded as data and the run continues; the file is rewritten after every step, so a crash still leaves partial results)
- `probe-<name>-<epoch>.json`: a single probe run by hand from a button
- `soak-<yyyyMMdd-HHmmss>.csv`: one row every 10 s (fps, thermal status, headroom, battery temp/level/current, charging), flushed row by row
- `keys-<epoch>.jsonl`: every hardware key event seen while the key probe was on (epoch-ms `t`, key code/name, `down`/`up`, `activity` or `mediaSession`)

The app's own buttons: **Run all probes**, **Run all + 10 min soak**, **Sensors**, **Camera**, **Exclusivity**, **Soak 10 min / Stop soak**, **Start / Stop FG service**
(leaves the notification up so you can press its Stop button), **Start key probe** (+ optional MediaSession path), **Display probe (glasses)**, **Files**.
The steps that need a human (keys, display, glasses IMU) are listed in [probe-results.md](probe-results.md).

## 5. Things learned while building A0

- **WebView permissions (exclusivity probe).** The camera-ownership test needs a real WebView, so `WebProbe` loads a tiny page from `https://localhost/` in a 1x1 WebView and
  calls `getUserMedia`. Its `WebChromeClient.onPermissionRequest` grants a request only if the matching Android runtime permission is already granted, and records what was
  asked and decided (`permissionRequested`, `permissionDecision` in the report). `MODIFY_AUDIO_SETTINGS` (install-time) stays declared: the earlier Capacitor build found that Capacitor's own client refused a
  `getUserMedia({audio})` request unless it was declared. Whether a plain WebView needs it is **not verified**; it is kept so the probe
  matches what a WebView-based frontend would have, and the exclusivity result records the WebView's exact error if audio is refused.
- **Android 14 foreground services.** A service with type `camera` / `microphone` must declare `android:foregroundServiceType` in the manifest, hold
  `FOREGROUND_SERVICE_CAMERA` / `FOREGROUND_SERVICE_MICROPHONE`, and have the matching runtime permission (`CAMERA` / `RECORD_AUDIO`) **granted**
  before `startForeground()`. Those runtime permissions are "while-in-use": a camera/microphone foreground service cannot be *started* while the app is in
  the background (start it from the visible app). The probe starts it from the foreground and reports any exception verbatim.
- **Two permissions beyond the milestone list**: `ACTIVITY_RECOGNITION` (the step detector delivers nothing without it) and `HIGH_SAMPLING_RATE_SENSORS`
  (Android 12+ caps motion sensors at 200 Hz without it).
- **CameraX / lifecycle.** The probe binds CameraX to the Activity's lifecycle, so the camera stops when the app leaves the foreground. Keeping the
  camera running with the screen off needs a foreground service that owns the camera (Camera2 directly, or CameraX bound to a `LifecycleService`): that is
  a design decision this milestone informs, not one it makes.
