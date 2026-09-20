"""Repair selected boxes by projecting a clean card reference with SIFT."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np


DEFAULT_NUMBERS = "28-31,57,62-64,102-108,124,127-128,132-134,154,175-176,186-187,190-191,200,212-214"


def parse_numbers(value: str) -> set[int]:
    result = set()
    for part in value.split(","):
        bounds = [int(item) for item in part.strip().split("-")]
        result.update(range(bounds[0], bounds[-1] + 1))
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path, nargs="?", default=Path("training/data/all"))
    parser.add_argument("--numbers", default=DEFAULT_NUMBERS)
    parser.add_argument("--reference-number", type=int, default=113)
    args = parser.parse_args()
    dataset = args.dataset.resolve()
    labels_path = dataset / "labels.json"
    data = json.loads(labels_path.read_text())
    by_image = {item["image_id"]: item for item in data["annotations"]}
    selected = parse_numbers(args.numbers)

    reference_item = data["images"][args.reference_number - 1]
    reference_image = cv2.imread(str(dataset / reference_item["file_name"]))
    x, y, width, height = by_image[reference_item["id"]]["bbox"]
    template = reference_image[y:y + height, x:x + width]
    sift = cv2.SIFT_create(nfeatures=3000)
    template_points, template_descriptors = sift.detectAndCompute(
        cv2.cvtColor(template, cv2.COLOR_BGR2GRAY), None
    )
    matcher = cv2.BFMatcher()
    repaired, failed = 0, []
    for number in sorted(selected):
        item = data["images"][number - 1]
        image = cv2.imread(str(dataset / item["file_name"]))
        scale = min(1.0, 1400 / max(image.shape[:2]))
        target = cv2.resize(image, None, fx=scale, fy=scale)
        points, descriptors = sift.detectAndCompute(
            cv2.cvtColor(target, cv2.COLOR_BGR2GRAY), None
        )
        if descriptors is None:
            failed.append(number)
            continue
        pairs = matcher.knnMatch(template_descriptors, descriptors, k=2)
        good = [a for a, b in pairs if a.distance < 0.76 * b.distance]
        if len(good) < 7:
            failed.append(number)
            continue
        source = np.float32([template_points[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
        target_points = np.float32([points[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
        transform, inlier_mask = cv2.findHomography(source, target_points, cv2.RANSAC, 6)
        if transform is None or int(inlier_mask.sum()) < 6:
            failed.append(number)
            continue
        corners = np.float32([[[0, 0], [width, 0], [width, height], [0, height]]])
        projected = cv2.perspectiveTransform(corners, transform)[0] / scale
        bx, by, bw, bh = cv2.boundingRect(projected)
        bx, by = max(0, bx), max(0, by)
        bw = min(image.shape[1] - bx, bw)
        bh = min(image.shape[0] - by, bh)
        area_fraction = bw * bh / (image.shape[0] * image.shape[1])
        if bw <= 0 or bh <= 0 or not 0.002 < area_fraction < 0.85:
            failed.append(number)
            continue
        annotation = by_image[item["id"]]
        annotation["bbox"] = [bx, by, bw, bh]
        annotation["area"] = bw * bh
        repaired += 1
        print(f"#{number:03d}: {len(good)} matches, {int(inlier_mask.sum())} inliers")

    labels_path.write_text(json.dumps(data, indent=2) + "\n")
    print(f"Repaired {repaired}/{len(selected)} selected boxes; failed: {failed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
