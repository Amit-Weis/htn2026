# Forgetmenot Unity integration

This folder connects an AR Foundation camera frame to the custom hacker-card detector on Android, then converts the selected detection into an XREAL anchor and navigation target.

## What is implemented

1. `ARCameraObjectDetector` acquires an `XRCpuImage`, converts it to RGBA, and throttles inference.
2. `AndroidMediaPipeDetector` calls the bundled Android library.
3. The Android library runs the custom YOLO ONNX model on CPU and returns JSON.
4. `DetectionAnchorController` samples five points inside the best bounding box, raycasts against a depth-mesh collider or AR plane, and anchors the median hit.
5. `AnchorNavigationGuide` points an assigned indicator toward the anchor and displays distance.
6. Detection stops after the first successful model match by default. `SearchAgain()` resumes it.

## Prepare the model

From the repository root:

```bash
python forgetmenot_cv/training/deploy_model.py forgetmenot_cv/training/runs/hacker_card/weights/best.onnx
```

The generated `.onnx` file is intentionally ignored by Git. Every developer and CI build must run this command before making an Android build.

## One-time scene wiring in Unity

On the existing XR Origin:

1. Confirm these components exist and are enabled:
   - `ARCameraManager` on the AR camera
   - `ARRaycastManager`
   - `ARPlaneManager`
   - `ARAnchorManager`
2. Add `ARCameraObjectDetector` to the same object as `ARCameraManager`.
3. Add `DetectionAnchorController` to the XR Origin.
4. Assign its raycast manager, anchor manager, XR camera, and optional marker prefab.
5. In `ARCameraObjectDetector > On Detections`, connect the anchor controller's `HandleDetections` method.
6. Add `AnchorNavigationGuide` to a navigation UI object.
7. Assign its XR camera, 3D direction indicator, and optional TextMesh Pro distance label.
8. In `DetectionAnchorController > On Anchor Created`, connect `AnchorNavigationGuide.SetTarget`.
9. For Editor-only wiring tests, add `DetectionSimulator` and use its **Simulate Center Detection** context menu while an AR simulation plane is available.

## Android build requirements

- Camera permission is declared by the embedded Android library.
- Minimum Android SDK is 24.
- The library resolves `com.microsoft.onnxruntime:onnxruntime-android:1.20.0` from Maven Central.
- `hacker_card.onnx` must exist in the Android library assets directory.

## Device caveats

- `TryAcquireLatestCpuImage` must be supported by the active XREAL camera provider. If it returns false on Beam Pro, the next integration step is feeding CameraX frames directly into the Android library.
- Camera-image rotation/cropping must be validated on device. `DetectionCoordinateMapper` currently handles top-left to bottom-left conversion and optional horizontal mirroring, but device-specific 90-degree rotation may need an additional transform.
- Raycasting requires a detected AR plane or a depth mesh with colliders. It does not map the whole room in application code.
- The anchor remains correct only while the physical object stays where it was detected.
- Current anchors last for the active session. Persistent anchor save/load can reuse the existing `SpawnedObjectsManager` pattern after device placement is verified.
