"""Download Google's EfficientDet-Lite0 model with embedded COCO metadata."""

from pathlib import Path
from urllib.request import urlopen

MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/object_detector/"
    "efficientdet_lite0/int8/1/efficientdet_lite0.tflite"
)
DESTINATION = Path("models/efficientdet_lite0.tflite")


def main() -> None:
    DESTINATION.parent.mkdir(parents=True, exist_ok=True)
    if DESTINATION.exists():
        print(f"Model already exists: {DESTINATION}")
        return
    print(f"Downloading {MODEL_URL}")
    with urlopen(MODEL_URL) as response, DESTINATION.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    print(f"Saved {DESTINATION}")


if __name__ == "__main__":
    main()
