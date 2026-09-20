import json

import numpy as np

from src.models import BoundingBox, DetectionResult
from src.size_distance import KnownSizeDistanceEstimator


def result(width):
    return DetectionResult.from_bbox(
        "hacker_card", 0.9, BoundingBox(10, 10, 10 + width, 90)
    )


def test_calibration_and_inverse_width_distance(tmp_path):
    frame = np.zeros((200, 1000, 3), dtype=np.uint8)
    path = tmp_path / "calibration.json"
    estimator = KnownSizeDistanceEstimator()
    estimator.calibrate(frame, result(250), 1.0, path)
    assert estimator.estimate(frame, [result(500)])[0].distance_m == 0.5
    assert estimator.estimate(frame, [result(125)])[0].distance_m == 2.0
    assert json.loads(path.read_text())["normalized_width_distance_constant"] == 0.25


def test_saved_calibration_is_resolution_independent(tmp_path):
    path = tmp_path / "calibration.json"
    path.write_text(json.dumps({"normalized_width_distance_constant": 0.2}))
    frame = np.zeros((100, 2000, 3), dtype=np.uint8)
    found = KnownSizeDistanceEstimator(path).estimate(frame, [result(400)])
    assert found[0].distance_m == 1.0


def test_uncalibrated_estimator_leaves_distance_empty():
    frame = np.zeros((100, 100, 3), dtype=np.uint8)
    found = KnownSizeDistanceEstimator().estimate(frame, [result(20)])
    assert found[0].distance_m is None
