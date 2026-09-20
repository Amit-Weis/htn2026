"""Monocular depth inference and per-detection distance estimation."""

from __future__ import annotations

from dataclasses import replace
import json
from pathlib import Path
from typing import Protocol

import cv2
import numpy as np

from .models import DetectionResult


class DepthPredictor(Protocol):
    def __call__(self, frame: np.ndarray) -> np.ndarray: ...


class YoloDepthPredictor:
    """Returns the dense metric-depth output from a YOLO26 depth checkpoint."""

    def __init__(self, model: str | Path = "yolo26n-depth.pt") -> None:
        from ultralytics import YOLO

        self._model = YOLO(str(model))

    def __call__(self, frame: np.ndarray) -> np.ndarray:
        result = self._model.predict(source=frame, verbose=False)[0]
        if result.depth is None:
            raise RuntimeError("The selected model did not return a depth map")
        return result.depth.data.cpu().numpy().astype(np.float32, copy=False)


class DepthEstimator:
    """Adds robust, camera-calibrated distance estimates to detections."""

    def __init__(
        self,
        model: str | Path = "yolo26n-depth.pt",
        calibration: str | Path | None = None,
        predictor: DepthPredictor | None = None,
        inner_fraction: float = 0.5,
    ) -> None:
        if not 0 < inner_fraction <= 1:
            raise ValueError("inner_fraction must be between 0 and 1")
        self._predictor = predictor or YoloDepthPredictor(model)
        self._inner_fraction = inner_fraction
        self._scale = 1.0
        self._exponent = 1.0
        if calibration is not None:
            values = json.loads(Path(calibration).read_text())
            self._scale = float(values["scale"])
            self._exponent = float(values["exponent"])

    def estimate(
        self, frame: np.ndarray, detections: list[DetectionResult]
    ) -> list[DetectionResult]:
        if not detections:
            return detections
        depth = np.asarray(self._predictor(frame), dtype=np.float32).squeeze()
        height, width = frame.shape[:2]
        if depth.shape != (height, width):
            depth = cv2.resize(depth, (width, height), interpolation=cv2.INTER_LINEAR)
        return [replace(item, distance_m=self._distance(depth, item)) for item in detections]

    def _distance(self, depth: np.ndarray, detection: DetectionResult) -> float | None:
        box = detection.bbox
        inset_x = round((box.x2 - box.x1) * (1 - self._inner_fraction) / 2)
        inset_y = round((box.y2 - box.y1) * (1 - self._inner_fraction) / 2)
        roi = depth[box.y1 + inset_y:box.y2 - inset_y, box.x1 + inset_x:box.x2 - inset_x]
        valid = roi[np.isfinite(roi) & (roi > 0)]
        if valid.size == 0:
            return None
        raw_m = float(np.median(valid))
        return round(self._scale * raw_m**self._exponent, 2)
