"""Download Google's EfficientDet-Lite0 model with embedded COCO metadata."""

import argparse
from pathlib import Path
import shutil
from urllib.request import urlopen

MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/object_detector/"
    "efficientdet_lite0/int8/1/efficientdet_lite0.tflite"
)
PROJECT_DIR = Path(__file__).resolve().parent
DESTINATION = PROJECT_DIR / "models/efficientdet_lite0.tflite"
ANDROID_DESTINATION = (
    PROJECT_DIR.parent
    / "Assets/Plugins/Android/ForgetmenotMediaPipe.androidlib/"
    / "src/main/assets/efficientdet_lite0.tflite"
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--android", action="store_true", help="also copy the model into the Unity Android library"
    )
    args = parser.parse_args()
    DESTINATION.parent.mkdir(parents=True, exist_ok=True)
    if not DESTINATION.exists():
        print(f"Downloading {MODEL_URL}")
        with urlopen(MODEL_URL) as response, DESTINATION.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        print(f"Saved {DESTINATION}")
    else:
        print(f"Model already exists: {DESTINATION}")

    if args.android:
        ANDROID_DESTINATION.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(DESTINATION, ANDROID_DESTINATION)
        print(f"Copied model to {ANDROID_DESTINATION}")


if __name__ == "__main__":
    main()
