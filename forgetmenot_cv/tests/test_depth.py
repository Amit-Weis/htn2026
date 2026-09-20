import json

import numpy as np

from src.depth import DepthEstimator
from src.models import BoundingBox, DetectionResult


def detection(box=(2, 2, 8, 8)):
    return DetectionResult.from_bbox("hacker_card", 0.9, BoundingBox(*box))


def test_depth_estimator_adds_median_distance():
    depth = np.full((10, 10), 2.5, dtype=np.float32)
    estimator = DepthEstimator(predictor=lambda frame: depth)
    found = estimator.estimate(np.zeros((10, 10, 3), dtype=np.uint8), [detection()])
    assert found[0].distance_m == 2.5


def test_depth_estimator_applies_calibration(tmp_path):
    calibration = tmp_path / "calibration.json"
    calibration.write_text(json.dumps({"scale": 2, "exponent": 1}))
    estimator = DepthEstimator(
        calibration=calibration,
        predictor=lambda frame: np.full((5, 5), 1.5, dtype=np.float32),
    )
    found = estimator.estimate(np.zeros((10, 10, 3), dtype=np.uint8), [detection()])
    assert found[0].distance_m == 3.0


def test_no_detections_skips_depth_inference():
    def fail(_frame):
        raise AssertionError("should not run")

    assert DepthEstimator(predictor=fail).estimate(
        np.zeros((2, 2, 3), dtype=np.uint8), []
    ) == []
