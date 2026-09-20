"""OpenCV webcam frame source."""

from time import monotonic, sleep

import cv2
import numpy as np


class WebcamSource:
    def __init__(self, index: int = 0) -> None:
        self.index = index
        self._capture = cv2.VideoCapture(index)
        if not self._capture.isOpened():
            self._capture.release()
            raise RuntimeError(f"Could not open webcam {index}")
        self._prefetched_frame = self._read_with_retry(timeout_seconds=6.0)

    def _read_with_retry(self, timeout_seconds: float) -> np.ndarray:
        deadline = monotonic() + timeout_seconds
        while monotonic() < deadline:
            ok, frame = self._capture.read()
            if ok and frame is not None:
                return frame
            sleep(0.1)
        raise RuntimeError(f"Could not read from webcam {self.index}")

    def read(self) -> np.ndarray:
        if self._prefetched_frame is not None:
            frame = self._prefetched_frame
            self._prefetched_frame = None
            return frame
        return self._read_with_retry(timeout_seconds=1.0)

    def close(self) -> None:
        self._capture.release()

    def __enter__(self) -> "WebcamSource":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()
