"""OpenCV webcam frame source."""

import cv2
import numpy as np


class WebcamSource:
    def __init__(self, index: int = 0) -> None:
        self.index = index
        self._capture = cv2.VideoCapture(index)
        if not self._capture.isOpened():
            self._capture.release()
            raise RuntimeError(f"Could not open webcam {index}")

    def read(self) -> np.ndarray:
        ok, frame = self._capture.read()
        if not ok or frame is None:
            raise RuntimeError(f"Could not read from webcam {self.index}")
        return frame

    def close(self) -> None:
        self._capture.release()

    def __enter__(self) -> "WebcamSource":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()
