# Forgetmenot Beam Pro detector test

Standalone Android test harness for the non-Unity half of Forgetmenot. It uses CameraX, the shared MediaPipe Android library, and EfficientDet-Lite0 to prove that Beam Pro camera frames can produce aligned `cell phone` bounding boxes and the JSON contract consumed by Unity.

This APK is a development tool. The final product remains the Unity-built Android application.

## Prepare

From the repository root:

```bash
python forgetmenot_cv/download_model.py --android
```

This places the ignored model file in the shared Android library's assets directory.

Open `android_detector_test` in Android Studio and let Gradle sync. The project includes the shared library directly from:

```text
Assets/Plugins/Android/ForgetmenotMediaPipe.androidlib
```

## Run on Beam Pro

1. Enable Developer Options and USB debugging on Beam Pro.
2. Connect it over USB and accept its authorization prompt.
3. Confirm `adb devices` lists it as `device`.
4. Select Beam Pro in Android Studio and run the `app` configuration.
5. Accept camera permission.
6. Point the rear camera at a phone.

The app processes approximately one frame every 350 ms, draws `CELL PHONE <confidence>%`, and logs the complete handoff JSON under `ForgetmenotDetection`.

```bash
adb logcat -s ForgetmenotDetection:D '*:S'
```

## Completion checklist

- Camera preview remains smooth.
- A phone produces an aligned box and center marker.
- No phone produces an empty detection list without errors.
- Portrait rotation is correct.
- `frame_id` increases monotonically.
- `timestamp_ms` is populated.
- JSON matches `Assets/Forgetmenot/TestData/one_phone.json`.
- Typical inference latency and tested camera resolution are recorded for the Unity handoff.

## Boundary

Reusable deliverable:

```text
RGBA8888 bytes + dimensions + target
→ MediaPipeDetector
→ DetectionFrameResult JSON
```

Test-only code:

- `MainActivity`
- CameraX preview and analyzer
- `DetectionOverlayView`

Unity/XREAL code must replace the CameraX source with XREAL's RGB-camera source while keeping the detector contract.
