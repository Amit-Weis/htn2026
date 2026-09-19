from pathlib import Path

import numpy as np

from src.inputs.image_source import ImageSource


def test_static_image_source_reads_frame(monkeypatch, tmp_path: Path):
    image_path = tmp_path / "photo.jpg"
    image_path.touch()
    expected = np.zeros((12, 18, 3), dtype=np.uint8)
    monkeypatch.setattr("src.inputs.image_source.cv2.imread", lambda *_: expected)
    assert ImageSource(image_path).read() is expected
