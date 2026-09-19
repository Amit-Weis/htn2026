# Forgetmenot object-detection prototype

Desktop test harness for MediaPipe Object Detector using Google's int8 EfficientDet-Lite0 model. It detects COCO objects in a BGR NumPy frame and returns platform-neutral dataclasses containing class, confidence, bounding box, and center.

There is no depth estimation, tracking, ReID, segmentation, or XREAL integration in this milestone.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python download_model.py
```

The model is downloaded from Google's official MediaPipe model bucket into `models/` and is ignored by Git.

The desktop requirements pin MediaPipe 0.10.35 because 1.0.1 crashes in its macOS Metal post-processing service on the tested Apple Silicon machine, even with the CPU delegate selected.

## Static image (first milestone)

```bash
python app.py --image test.jpg --target "cell phone"
```

Omit `--target` to return every detected class. The command prints JSON and saves `outputs/test_annotated.jpg`.

## Webcam

```bash
python app.py --webcam 0 --target "cell phone"
```

Press `Q` to quit. The desktop harness uses synchronous image inference frame-by-frame for one source-independent `detect(frame)` API.

## Labels

EfficientDet-Lite0 uses the 80 COCO classes embedded in its TFLite metadata. List accepted names with `python app.py --list-classes`. `cell phone`, `backpack`, `bottle`, and `remote` are supported; `keys` and `wallet` are not COCO classes.

## Tests

```bash
python -m pytest -q
```

Tests inject a fake backend and do not need MediaPipe or the TFLite model.

## Android / Beam Pro path

Keep `DetectionResult`, bounding-box semantics, and target filtering. Replace OpenCV sources with CameraX/XREAL frames and use MediaPipe Tasks Vision for Android with the same `.tflite` asset. A production camera loop should use `LIVE_STREAM` mode, handle rotation/mirroring, and map image coordinates to display coordinates.

The repository now includes the initial Unity/Android bridge under `Assets/Forgetmenot` and `Assets/Plugins/Android/ForgetmenotMediaPipe.androidlib`. Prepare its model before an Android build with:

```bash
python download_model.py --android
```

## Limitations

- Detection is limited to 80 COCO labels; other items need a custom compatible TFLite model.
- Small, occluded, or unusual objects may be missed by EfficientDet-Lite0.
- There are no persistent IDs or world/AR coordinates.
- The desktop webcam loop is synchronous, so inference can reduce preview frame rate.
