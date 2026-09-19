import json
from pathlib import Path


FIXTURES = Path(__file__).parents[2] / "Assets" / "Forgetmenot" / "TestData"


def test_detection_fixtures_follow_handoff_contract():
    fixture_paths = sorted(FIXTURES.glob("*.json"))
    assert fixture_paths
    for path in fixture_paths:
        payload = json.loads(path.read_text())
        assert payload["frame_id"] >= 0
        assert payload["timestamp_ms"] >= 0
        assert payload["image_width"] > 0
        assert payload["image_height"] > 0
        assert payload["rotation_degrees"] in {0, 90, 180, 270}
        assert isinstance(payload["mirrored"], bool)
        for detection in payload["detections"]:
            box = detection["bbox"]
            center = detection["center"]
            assert 0 <= box["x1"] <= center["x"] <= box["x2"] <= payload["image_width"]
            assert 0 <= box["y1"] <= center["y"] <= box["y2"] <= payload["image_height"]
            assert 0 <= detection["confidence"] <= 1
