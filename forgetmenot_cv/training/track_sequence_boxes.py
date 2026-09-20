"""Propagate a trusted annotation through an ordered photo sequence."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np


def parse_numbers(value: str) -> set[int]:
    result: set[int] = set()
    for part in value.split(","):
        ends = [int(v) for v in part.strip().split("-")]
        result.update(range(ends[0], ends[-1] + 1))
    return result


def image_and_features(path: Path, sift: cv2.SIFT, max_size: int = 1200):
    image = cv2.imread(str(path))
    scale = min(1.0, max_size / max(image.shape[:2]))
    small = cv2.resize(image, None, fx=scale, fy=scale)
    points, descriptors = sift.detectAndCompute(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), None)
    return image.shape[:2], scale, points, descriptors


def homography(source, target, matcher: cv2.BFMatcher):
    _, source_scale, source_points, source_desc = source
    _, target_scale, target_points, target_desc = target
    if source_desc is None or target_desc is None:
        return None, 0
    pairs = matcher.knnMatch(source_desc, target_desc, k=2)
    good = [a for a, b in pairs if a.distance < 0.72 * b.distance]
    if len(good) < 12:
        return None, 0
    src = np.float32([source_points[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([target_points[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    h, mask = cv2.findHomography(src, dst, cv2.RANSAC, 3.5)
    if h is None or int(mask.sum()) < 10:
        return None, 0
    # Convert the homography from resized-image coordinates to originals.
    source_to_small = np.diag([source_scale, source_scale, 1.0])
    target_to_original = np.diag([1 / target_scale, 1 / target_scale, 1.0])
    return target_to_original @ h @ source_to_small, int(mask.sum())


def project_corners(corners: np.ndarray, h: np.ndarray) -> np.ndarray:
    return cv2.perspectiveTransform(corners.reshape(1, 4, 2), h)[0]


def corners_box(corners: np.ndarray, shape: tuple[int, int]) -> list[int]:
    bx, by, bw, bh = cv2.boundingRect(corners)
    image_height, image_width = shape
    x1, y1 = max(0, bx), max(0, by)
    x2, y2 = min(image_width, bx + bw), min(image_height, by + bh)
    return [x1, y1, max(1, x2 - x1), max(1, y2 - y1)]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--anchor", type=int, required=True)
    parser.add_argument("--first", type=int, required=True)
    parser.add_argument("--last", type=int, required=True)
    parser.add_argument("--write", required=True, help="Numbers/ranges to overwrite")
    parser.add_argument("--anchor-box", help="Optional trusted x,y,width,height")
    args = parser.parse_args()

    dataset = args.dataset.resolve()
    labels_path = dataset / "labels.json"
    data = json.loads(labels_path.read_text())
    annotations = {a["image_id"]: a for a in data["annotations"]}
    write_numbers = parse_numbers(args.write)
    sift, matcher = cv2.SIFT_create(nfeatures=5000), cv2.BFMatcher()

    anchor_item = data["images"][args.anchor - 1]
    current_box = (
        [int(value) for value in args.anchor_box.split(",")]
        if args.anchor_box else annotations[anchor_item["id"]]["bbox"]
    )
    x, y, width, height = current_box
    anchor_corners = np.float32([[x, y], [x + width, y], [x + width, y + height], [x, y + height]])
    boxes = {args.anchor: current_box}
    failures = []

    for direction, stop in [(-1, args.first), (1, args.last)]:
        number = args.anchor
        corners = anchor_corners.copy()
        source = image_and_features(dataset / data["images"][number - 1]["file_name"], sift)
        while number != stop:
            next_number = number + direction
            target = image_and_features(dataset / data["images"][next_number - 1]["file_name"], sift)
            h, inliers = homography(source, target, matcher)
            if h is None:
                failures.append((number, next_number))
                break
            corners = project_corners(corners, h)
            box = corners_box(corners, target[0])
            boxes[next_number] = box
            print(f"#{next_number}: {inliers} scene inliers -> {box}")
            number, source = next_number, target

    changed = 0
    for number in sorted(write_numbers):
        if number not in boxes:
            continue
        item = data["images"][number - 1]
        annotation = annotations[item["id"]]
        annotation["bbox"] = boxes[number]
        annotation["area"] = boxes[number][2] * boxes[number][3]
        changed += 1
    labels_path.write_text(json.dumps(data, indent=2) + "\n")
    print(f"Updated {changed}/{len(write_numbers)} requested boxes; tracking failures: {failures}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
