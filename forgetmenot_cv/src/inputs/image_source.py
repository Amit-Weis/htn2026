"""Static image frame source."""

from pathlib import Path

import cv2
import numpy as np


class ImageSource:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)

    def read(self) -> np.ndarray:
        if not self.path.is_file():
            raise FileNotFoundError(f"Image not found: {self.path}")
        frame = cv2.imread(str(self.path), cv2.IMREAD_COLOR)
        if frame is None:
            raise ValueError(f"Could not decode image: {self.path}")
        return frame
