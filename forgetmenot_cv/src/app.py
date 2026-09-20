"""Desktop orchestration for static images and webcams."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from time import perf_counter

import cv2

from .detector import (
    COCO_CLASSES,
    CombinedBackend,
    MediaPipeBackend,
    ObjectDetector,
    UltralyticsBackend,
    UnsupportedTargetError,
    validate_target,
)
from .inputs.image_source import ImageSource
from .inputs.webcam_source import WebcamSource
from .visualization import annotate


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Forgetmenot object detection harness")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--image", type=Path, help="path to a static image")
    source.add_argument("--webcam", type=int, help="OpenCV camera index, usually 0")
    parser.add_argument("--target", help='optional model class, e.g. "cell phone"')
    parser.add_argument(
        "--custom-label",
        help='single label embedded in a custom model, e.g. "hacker_card"',
    )
    parser.add_argument(
        "--model", type=Path, default=Path("models/efficientdet_lite0.tflite"),
        help="path to a MediaPipe TFLite model or custom YOLO .pt/.onnx model",
    )
    parser.add_argument(
        "--hacker-card-model", type=Path,
        help="also run this custom YOLO model alongside the COCO model",
    )
    parser.add_argument("--threshold", type=float, default=0.3)
    parser.add_argument("--outputs", type=Path, default=Path("outputs"))
    parser.add_argument("--list-classes", action="store_true")
    return parser


def process_image(args: argparse.Namespace, detector: ObjectDetector) -> None:
    frame = ImageSource(args.image).read()
    started = perf_counter()
    detections = detector.detect(frame, args.target)
    inference_ms = (perf_counter() - started) * 1000
    args.outputs.mkdir(parents=True, exist_ok=True)
    output_path = args.outputs / f"{args.image.stem}_annotated.jpg"
    if not cv2.imwrite(str(output_path), annotate(frame, detections)):
        raise RuntimeError(f"Could not write output image: {output_path}")
    print(json.dumps({
        "source": str(args.image),
        "output": str(output_path),
        "inference_ms": round(inference_ms, 2),
        "detections": [item.to_dict() for item in detections],
    }, indent=2))


def process_webcam(args: argparse.Namespace, detector: ObjectDetector) -> None:
    with WebcamSource(args.webcam) as source:
        while True:
            frame = source.read()
            detections = detector.detect(frame, args.target)
            cv2.imshow("Forgetmenot - press Q to exit", annotate(frame, detections))
            if cv2.waitKey(1) & 0xFF in (ord("q"), ord("Q")):
                break
    cv2.destroyAllWindows()


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.list_classes:
        print("\n".join(COCO_CLASSES))
        return 0
    if args.image is None and args.webcam is None:
        parser.error("one of --image or --webcam is required")
    if not 0.0 <= args.threshold <= 1.0:
        parser.error("--threshold must be between 0 and 1")

    try:
        if args.hacker_card_model:
            supported_classes = COCO_CLASSES + ("hacker_card",)
            primary_backend = (
                UltralyticsBackend(args.model, args.threshold)
                if args.model.suffix.lower() in {".pt", ".onnx"}
                else MediaPipeBackend(args.model, args.threshold)
            )
            backend = CombinedBackend([
                primary_backend,
                UltralyticsBackend(args.hacker_card_model, args.threshold),
            ])
        else:
            supported_classes = (args.custom_label,) if args.custom_label else COCO_CLASSES
            backend = None
        validate_target(args.target, supported_classes)
        with ObjectDetector(
            args.model, args.threshold, backend=backend,
            supported_classes=supported_classes,
        ) as detector:
            if args.image is not None:
                process_image(args, detector)
            else:
                process_webcam(args, detector)
        return 0
    except UnsupportedTargetError as error:
        print(f"Unsupported target: {error}", file=sys.stderr)
        return 2
    except (FileNotFoundError, ValueError, RuntimeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
