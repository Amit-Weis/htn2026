import numpy as np
import pytest

from src.detector import ObjectDetector, UnsupportedTargetError
from src.models import BoundingBox, DetectionResult


class FakeBackend:
    def __init__(self, detections):
        self.detections = detections
        self.frames = []

    def detect(self, frame):
        self.frames.append(frame)
        return list(self.detections)

    def close(self):
        pass


def result(label, confidence, coordinates):
    return DetectionResult.from_bbox(label, confidence, BoundingBox(*coordinates))


def test_target_filtering_is_case_insensitive():
    backend = FakeBackend([
        result("cell phone", 0.93, (10, 20, 30, 60)),
        result("bottle", 0.80, (1, 2, 3, 4)),
    ])
    detector = ObjectDetector(backend=backend)
    found = detector.detect(np.zeros((80, 80, 3), dtype=np.uint8), "Cell Phone")
    assert [item.class_name for item in found] == ["cell phone"]


def test_unsupported_target_does_not_run_inference():
    backend = FakeBackend([])
    detector = ObjectDetector(backend=backend)
    with pytest.raises(UnsupportedTargetError, match="not supported"):
        detector.detect(np.zeros((2, 2, 3), dtype=np.uint8), "wallet")
    assert backend.frames == []


def test_multiple_detections_are_preserved():
    backend = FakeBackend([
        result("cell phone", 0.9, (0, 0, 10, 10)),
        result("cell phone", 0.8, (20, 20, 40, 50)),
    ])
    detector = ObjectDetector(backend=backend)
    assert len(detector.detect(np.zeros((60, 60, 3), dtype=np.uint8))) == 2


def test_no_detections_returns_empty_list():
    detector = ObjectDetector(backend=FakeBackend([]))
    assert detector.detect(np.zeros((2, 2, 3), dtype=np.uint8)) == []


def test_bbox_center_calculation():
    detection = result("remote", 0.75, (250, 130, 420, 340))
    assert detection.center.x == 335
    assert detection.center.y == 235
