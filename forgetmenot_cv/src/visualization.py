"""Debug overlay rendering, separate from detection."""

import cv2
import numpy as np

from .models import DetectionResult


def annotate(frame: np.ndarray, detections: list[DetectionResult]) -> np.ndarray:
    output = frame.copy()
    for detection in detections:
        box = detection.bbox
        cv2.rectangle(output, (box.x1, box.y1), (box.x2, box.y2), (50, 220, 80), 2)
        cv2.circle(output, (detection.center.x, detection.center.y), 4, (20, 60, 255), -1)
        label = f"{detection.class_name.upper()} {detection.confidence:.0%}"
        cv2.putText(
            output, label, (box.x1, max(20, box.y1 - 8)),
            cv2.FONT_HERSHEY_SIMPLEX, 0.55, (50, 220, 80), 2, cv2.LINE_AA,
        )
    return output
