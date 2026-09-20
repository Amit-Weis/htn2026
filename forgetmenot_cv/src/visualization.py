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
        if detection.distance_m is not None:
            distance_label = f"~{detection.distance_m:.2f} m"
            (text_width, text_height), baseline = cv2.getTextSize(
                distance_label, cv2.FONT_HERSHEY_SIMPLEX, 0.62, 2
            )
            text_x = max(box.x1, box.x2 - text_width)
            text_y = min(output.shape[0] - baseline - 4, box.y2 + text_height + 8)
            # Put distance on the opposite (bottom-right) edge of the same box.
            cv2.rectangle(
                output,
                (text_x - 5, text_y - text_height - 5),
                (min(output.shape[1] - 1, box.x2 + 5), text_y + baseline + 3),
                (50, 220, 80),
                -1,
            )
            cv2.putText(
                output, distance_label, (text_x, text_y),
                cv2.FONT_HERSHEY_SIMPLEX, 0.62, (15, 35, 20), 2, cv2.LINE_AA,
            )
    return output
