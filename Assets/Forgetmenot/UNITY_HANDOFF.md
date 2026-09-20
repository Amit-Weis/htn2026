# Unity/XREAL handoff

## Delivered interface

The reusable Android library accepts packed RGBA8888 bytes (`width * height * 4`) in top-left-origin image order and returns JSON. The target must use the model label `hacker_card`.

```csharp
using var detector = new AndroidMediaPipeDetector(0.3f);
DetectionFrameResult result = detector.Detect(
    rgba,
    width,
    height,
    "hacker_card",
    frameId,
    timestampMs,
    rotationDegrees,
    mirrored);
```

The standalone `android_detector_test` proves CameraX → RGBA → detector → JSON independently of Unity.

## Unity developer checklist

1. Pull the integration branch.
2. Run `python forgetmenot_cv/training/deploy_model.py <path-to-best.onnx>`.
3. Open with Unity `6000.0.84f1` and allow `.meta` generation.
4. Resolve compile/Gradle errors before editing the scene.
5. Load JSON fixtures from `Assets/Forgetmenot/TestData` to build the box overlay without a live camera.
6. Implement an XREAL RGB-camera frame source that supplies bytes, dimensions, timestamp, camera pose, and intrinsics.
7. Invoke `AndroidMediaPipeDetector` off the render-critical path and throttle inference.
8. Draw boxes against the exact preview transform, accounting for center crop, rotation, and mirroring.
9. Retain the XREAL camera pose associated with each `frame_id`/timestamp.
10. Unproject the selected center pixel using XREAL camera calibration.
11. Raycast against depth mesh or planes and create an anchor.
12. Wire the anchor into navigation guidance.
13. Build ARM64 Android and validate on Beam Pro/glasses.

## Acceptance gates

### Gate 1 — contract

All fixture JSON parses and displays correctly in Unity.

### Gate 2 — live detection

The XREAL frame source produces an aligned `hacker_card` box using the shared Android detector.

### Gate 3 — spatial placement

The detection center unprojects using the pose from the same frame and produces a stable marker at the physical location.

### Gate 4 — navigation

Walking away and returning causes the arrow/distance to guide the user back to the active-session anchor.

## Known risks

- The current provisional `ARCameraObjectDetector` uses `ARCameraManager`; replace it if the XREAL RGB API is the authoritative source.
- The Android library is source-integrated and has been compiled through the standalone Android harness; a Unity Android build still needs verification.
- The final camera image may require device-specific rotation, mirroring, and crop calibration.
- A Beam Pro camera ray cannot align with the glasses unless XREAL supplies the correct camera pose/transform.
- Persistent anchor save/load is not part of this handoff.
