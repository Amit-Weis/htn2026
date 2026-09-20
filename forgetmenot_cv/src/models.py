"""Platform-neutral result models shared with future frame sources."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class Point:
    x: int
    y: int


@dataclass(frozen=True)
class BoundingBox:
    x1: int
    y1: int
    x2: int
    y2: int

    @property
    def center(self) -> Point:
        return Point(x=(self.x1 + self.x2) // 2, y=(self.y1 + self.y2) // 2)


@dataclass(frozen=True)
class DetectionResult:
    class_name: str
    confidence: float
    bbox: BoundingBox
    center: Point
    distance_m: float | None = None

    @classmethod
    def from_bbox(
        cls, class_name: str, confidence: float, bbox: BoundingBox
    ) -> "DetectionResult":
        return cls(class_name, confidence, bbox, bbox.center)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
