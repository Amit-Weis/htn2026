"""Source-agnostic object detector backed by MediaPipe Tasks."""

from __future__ import annotations

from pathlib import Path
from typing import Protocol

import cv2
import numpy as np

from .models import BoundingBox, DetectionResult


# The spelling matches the labels embedded in Google's EfficientDet-Lite0 model.
COCO_CLASSES = (
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train",
    "truck", "boat", "traffic light", "fire hydrant", "stop sign",
    "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
    "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag",
    "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite",
    "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
    "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana",
    "apple", "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza",
    "donut", "cake", "chair", "couch", "potted plant", "bed", "dining table",
    "toilet", "tv", "laptop", "mouse", "remote", "keyboard", "cell phone",
    "microwave", "oven", "toaster", "sink", "refrigerator", "book", "clock",
    "vase", "scissors", "teddy bear", "hair drier", "toothbrush",
)


class UnsupportedTargetError(ValueError):
    """The target is not part of the model label map."""


def validate_target(
    target_class: str | None, supported_classes: tuple[str, ...] = COCO_CLASSES
) -> str | None:
    """Return the canonical label without loading the inference model."""
    if target_class is None:
        return None
    lookup = {label.casefold(): label for label in supported_classes}
    normalized = target_class.strip().casefold()
    if normalized not in lookup:
        raise UnsupportedTargetError(
            f"{target_class!r} is not supported. Use --list-classes to see valid names."
        )
    return lookup[normalized]


class DetectionBackend(Protocol):
    def detect(self, frame: np.ndarray) -> list[DetectionResult]: ...
    def close(self) -> None: ...


class CombinedBackend:
    """Runs multiple independent models and merges their normalized detections."""

    def __init__(self, backends: list[DetectionBackend]) -> None:
        self._backends = backends

    def detect(self, frame: np.ndarray) -> list[DetectionResult]:
        return [item for backend in self._backends for item in backend.detect(frame)]

    def close(self) -> None:
        for backend in reversed(self._backends):
            backend.close()


class MediaPipeBackend:
    """Thin adapter around MediaPipe Object Detector in synchronous IMAGE mode."""

    def __init__(
        self,
        model_path: str | Path,
        score_threshold: float = 0.3,
        max_results: int = -1,
    ) -> None:
        import mediapipe as mp

        model_path = Path(model_path)
        if not model_path.is_file():
            raise FileNotFoundError(
                f"Model not found: {model_path}. Run: python download_model.py"
            )
        self._mp = mp
        options = mp.tasks.vision.ObjectDetectorOptions(
            base_options=mp.tasks.BaseOptions(
                model_asset_path=str(model_path),
                delegate=mp.tasks.BaseOptions.Delegate.CPU,
            ),
            running_mode=mp.tasks.vision.RunningMode.IMAGE,
            score_threshold=score_threshold,
            max_results=max_results,
        )
        self._task = mp.tasks.vision.ObjectDetector.create_from_options(options)

    def detect(self, frame: np.ndarray) -> list[DetectionResult]:
        if not isinstance(frame, np.ndarray) or frame.ndim != 3 or frame.shape[2] != 3:
            raise ValueError("frame must be a non-empty HxWx3 BGR NumPy array")

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = self._mp.Image(
            image_format=self._mp.ImageFormat.SRGB,
            data=np.ascontiguousarray(rgb),
        )
        raw_result = self._task.detect(mp_image)
        height, width = frame.shape[:2]
        results: list[DetectionResult] = []
        for detection in raw_result.detections:
            if not detection.categories:
                continue
            category = detection.categories[0]
            class_name = category.category_name or category.display_name
            if not class_name:
                continue
            raw_box = detection.bounding_box
            x1 = max(0, min(width, int(raw_box.origin_x)))
            y1 = max(0, min(height, int(raw_box.origin_y)))
            x2 = max(x1, min(width, int(raw_box.origin_x + raw_box.width)))
            y2 = max(y1, min(height, int(raw_box.origin_y + raw_box.height)))
            results.append(
                DetectionResult.from_bbox(
                    class_name,
                    float(category.score),
                    BoundingBox(x1=x1, y1=y1, x2=x2, y2=y2),
                )
            )
        return results

    def close(self) -> None:
        self._task.close()


class UltralyticsBackend:
    """Adapter for custom YOLO checkpoints used during desktop validation."""

    def __init__(self, model_path: str | Path, score_threshold: float = 0.3) -> None:
        from ultralytics import YOLO

        model_path = Path(model_path)
        if not model_path.is_file():
            raise FileNotFoundError(f"Model not found: {model_path}")
        self._model = YOLO(str(model_path))
        self._score_threshold = score_threshold

    def detect(self, frame: np.ndarray) -> list[DetectionResult]:
        if not isinstance(frame, np.ndarray) or frame.ndim != 3 or frame.shape[2] != 3:
            raise ValueError("frame must be a non-empty HxWx3 BGR NumPy array")
        prediction = self._model.predict(
            source=frame, conf=self._score_threshold, verbose=False
        )[0]
        results: list[DetectionResult] = []
        if prediction.boxes is None:
            return results
        height, width = frame.shape[:2]
        names = prediction.names
        for coordinates, score, class_index in zip(
            prediction.boxes.xyxy.cpu().tolist(),
            prediction.boxes.conf.cpu().tolist(),
            prediction.boxes.cls.cpu().tolist(),
        ):
            x1, y1, x2, y2 = coordinates
            results.append(
                DetectionResult.from_bbox(
                    names[int(class_index)],
                    float(score),
                    BoundingBox(
                        x1=max(0, min(width, round(x1))),
                        y1=max(0, min(height, round(y1))),
                        x2=max(0, min(width, round(x2))),
                        y2=max(0, min(height, round(y2))),
                    ),
                )
            )
        return results

    def close(self) -> None:
        pass


class ObjectDetector:
    """Validates targets and filters normalized backend results."""

    def __init__(
        self,
        model_path: str | Path = "models/efficientdet_lite0.tflite",
        score_threshold: float = 0.3,
        backend: DetectionBackend | None = None,
        supported_classes: tuple[str, ...] = COCO_CLASSES,
    ) -> None:
        if backend is not None:
            self._backend = backend
        elif Path(model_path).suffix.lower() in {".pt", ".onnx"}:
            self._backend = UltralyticsBackend(model_path, score_threshold)
        else:
            self._backend = MediaPipeBackend(model_path, score_threshold)
        self._supported_classes = supported_classes

    @property
    def supported_classes(self) -> tuple[str, ...]:
        return self._supported_classes

    def validate_target(self, target_class: str | None) -> str | None:
        return validate_target(target_class, self._supported_classes)

    def detect(
        self, frame: np.ndarray, target_class: str | None = None
    ) -> list[DetectionResult]:
        target = self.validate_target(target_class)
        detections = self._backend.detect(frame)
        if target is None:
            return detections
        return [item for item in detections if item.class_name.casefold() == target.casefold()]

    def close(self) -> None:
        self._backend.close()

    def __enter__(self) -> "ObjectDetector":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()
