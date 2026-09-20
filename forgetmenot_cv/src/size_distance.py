"""Distance estimation for a detected object with a fixed physical size."""

from __future__ import annotations

from dataclasses import replace
import json
from pathlib import Path

import numpy as np

from .models import DetectionResult


class KnownSizeDistanceEstimator:
    """Estimate range from a calibrated, resolution-independent box width."""

    def __init__(self, calibration: str | Path | None = None) -> None:
        self.constant: float | None = None
        if calibration is not None and Path(calibration).is_file():
            values = json.loads(Path(calibration).read_text())
            self.constant = float(values["normalized_width_distance_constant"])

    def calibrate(
        self, frame: np.ndarray, detection: DetectionResult,
        reference_distance_m: float, output: str | Path,
    ) -> None:
        if reference_distance_m <= 0:
            raise ValueError("reference distance must be positive")
        frame_width = frame.shape[1]
        box_width = detection.bbox.x2 - detection.bbox.x1
        if box_width <= 0:
            raise ValueError("detection bounding box has no width")
        self.constant = reference_distance_m * box_width / frame_width
        output_path = Path(output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps({
            "normalized_width_distance_constant": self.constant,
            "reference_distance_m": reference_distance_m,
            "reference_box_width_px": box_width,
            "reference_frame_width_px": frame_width,
        }, indent=2) + "\n")

    def estimate(
        self, frame: np.ndarray, detections: list[DetectionResult]
    ) -> list[DetectionResult]:
        if self.constant is None:
            return detections
        frame_width = frame.shape[1]
        enriched = []
        for detection in detections:
            box_width = detection.bbox.x2 - detection.bbox.x1
            distance = (
                round(self.constant / (box_width / frame_width), 2)
                if box_width > 0 else None
            )
            enriched.append(replace(detection, distance_m=distance))
        return enriched
