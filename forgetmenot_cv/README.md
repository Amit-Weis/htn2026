# Forgetmenot object-detection prototype

Desktop test harness for MediaPipe Object Detector using Google's int8 EfficientDet-Lite0 model. It detects COCO objects in a BGR NumPy frame and returns platform-neutral dataclasses containing class, confidence, bounding box, and center.

Optional YOLO26 monocular depth adds an approximate distance in meters to each detection.

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

Enable distance estimates (the checkpoint downloads on first use):

```bash
python app.py --webcam 0 --model yolo26n.pt \
  --depth-model yolo26n-depth.pt
```

The JSON includes `distance_m`. In the preview, the object label is on the top-left
edge of its box and the estimated meters appear in a separate badge on the opposite
bottom-right edge. The value is the median depth from the inner half of the detection
box, which avoids most background pixels.

For better absolute distance on the actual camera, photograph a centered object at
three or more measured distances spanning the intended range, then fit calibration:

```bash
python training/calibrate_depth.py \
  --sample calibration/card_050cm.jpg=0.50 \
  --sample calibration/card_100cm.jpg=1.00 \
  --sample calibration/card_200cm.jpg=2.00

python app.py --webcam 0 --model yolo26n.pt \
  --depth-model yolo26n-depth.pt \
  --depth-calibration models/depth_calibration.json
```

Use at least 5–10 measurements for a serious calibration. Detection box labels
cannot train a depth model: full depth training requires an RGB image and measured
depth map for every frame. Calibration is the practical route for this prototype.

### Recommended MVP: known-size card distance

For a steadier hacker-card demo, skip the depth model. Hold one card face-on at
exactly 1 meter and press `C` while it is the only detected target:

```bash
python app.py --webcam 0 \
  --model training/runs/hacker_card-2/weights/best.pt \
  --custom-label hacker_card --target hacker_card \
  --calibrate-at 1.0
```

This saves `models/hacker_card_distance.json` and begins showing meters immediately.
For later runs, load the saved calibration:

```bash
python app.py --webcam 0 \
  --model training/runs/hacker_card-2/weights/best.pt \
  --custom-label hacker_card --target hacker_card \
  --size-calibration models/hacker_card_distance.json
```

This route requires no depth model. It assumes the card is approximately face-on
and depends on a tight, stable detection box.

To show regular COCO objects and the custom hacker card in the same preview:

```bash
source .yolo-venv/bin/activate
python app.py --webcam 0 \
  --model yolo26n.pt \
  --hacker-card-model training/runs/hacker_card-2/weights/best.pt
```

## Labels

EfficientDet-Lite0 uses the 80 COCO classes embedded in its TFLite metadata. List accepted names with `python app.py --list-classes`. `cell phone`, `backpack`, `bottle`, and `remote` are supported; `keys` and `wallet` are not COCO classes.

## Train the hacker-card model

The custom-training tools live in `training/`. Annotation normalizes EXIF rotation,
strips phone metadata, writes COCO boxes, and can be safely resumed.

```bash
cd forgetmenot_cv
source .venv/bin/activate
python training/annotate.py "/Users/ethanxinq/Downloads/New Folder With Items"
python training/split_dataset.py training/data/all
```

In the annotation window, drag a tight rectangle around the whole purple card and
press Enter or Space. Press `C` for a true negative image containing no card. The
splitter keeps blocks of consecutive iPhone images together so burst photographs
do not leak across train and test sets.

Convert the COCO split to YOLO format and train the single-class detector:

```bash
python3 -m venv .yolo-venv
source .yolo-venv/bin/activate
python -m pip install -r requirements-train.txt
python training/coco_to_yolo.py
python training/train_yolo.py
```

Export the selected checkpoint to ONNX, install it for Android/Unity, and build:

```bash
python -c 'from ultralytics import YOLO; YOLO("training/runs/hacker_card/weights/best.pt").export(format="onnx", imgsz=640, simplify=False)'
python training/deploy_model.py
cd ../android_detector_test && ./gradlew :app:assembleDebug
```

The Android adapter letterboxes RGBA input to 640x640, runs ONNX Runtime,
decodes the YOLO output, applies NMS, and preserves the existing JSON contract.
Pass `hacker_card` as the target class.

Validate the same checkpoint with a desktop webcam before deploying:

```bash
source .yolo-venv/bin/activate
python app.py --webcam 0 \
  --model training/runs/hacker_card/weights/best.pt \
  --custom-label hacker_card --target hacker_card
```

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
- Monocular distance is approximate and camera/scene dependent; it is not a safety sensor.
- There are no persistent IDs or world/AR coordinates.
- The desktop webcam loop is synchronous, so inference can reduce preview frame rate.
