"""Tighten legacy hacker-card boxes around the purple PCB surface."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil

import cv2
import numpy as np


def purple_card_box(image: np.ndarray, old_box: list[int]) -> list[int] | None:
    """Find the purple PCB inside a loose legacy annotation."""
    image_height, image_width = image.shape[:2]
    x, y, width, height = old_box
    x1, y1 = max(0, x), max(0, y)
    x2, y2 = min(image_width, x + width), min(image_height, y + height)
    crop = image[y1:y2, x1:x2]
    if crop.size == 0:
        return None

    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    # Purple PCB remains in this hue band across shadows and screen glare.
    mask = cv2.inRange(hsv, (115, 38, 22), (178, 255, 255))
    short_side = min(crop.shape[:2])
    # Cap morphology sizes so a distant card is not erased in a 12 MP frame.
    open_size = min(7, max(3, round(short_side * 0.001))) | 1
    close_size = min(15, max(5, round(short_side * 0.004))) | 1
    mask = cv2.morphologyEx(
        mask, cv2.MORPH_OPEN, np.ones((open_size, open_size), np.uint8)
    )
    mask = cv2.morphologyEx(
        mask, cv2.MORPH_CLOSE, np.ones((close_size, close_size), np.uint8),
        iterations=2,
    )
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    largest = max(contours, key=cv2.contourArea)
    if cv2.contourArea(largest) < crop.shape[0] * crop.shape[1] * 0.00002:
        return None
    bx, by, bw, bh = cv2.boundingRect(largest)

    # A tiny allowance includes anti-aliased physical edges without restoring background.
    padding = max(2, round(max(bw, bh) * 0.012))
    nx1 = max(0, x1 + bx - padding)
    ny1 = max(0, y1 + by - padding)
    nx2 = min(image_width, x1 + bx + bw + padding)
    ny2 = min(image_height, y1 + by + bh + padding)
    return [nx1, ny1, nx2 - nx1, ny2 - ny1]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path, nargs="?", default=Path("training/data/all"))
    parser.add_argument(
        "--backup", type=Path,
        default=Path("training/data/all/labels.before_tightening.json"),
    )
    args = parser.parse_args()
    dataset = args.dataset.resolve()
    labels_path = dataset / "labels.json"
    data = json.loads(labels_path.read_text())
    images = {item["id"]: item for item in data["images"]}

    changed, failed = 0, []
    for annotation in data["annotations"]:
        item = images[annotation["image_id"]]
        image = cv2.imread(str(dataset / item["file_name"]))
        if image is None:
            failed.append(item["file_name"])
            continue
        box = purple_card_box(image, annotation["bbox"])
        if box is None:
            failed.append(item["file_name"])
            continue
        annotation["bbox"] = box
        annotation["area"] = box[2] * box[3]
        changed += 1

    backup = args.backup.resolve()
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(labels_path, backup)
    temporary = labels_path.with_suffix(".tightening.tmp")
    temporary.write_text(json.dumps(data, indent=2) + "\n")
    temporary.replace(labels_path)
    print(f"Tightened {changed}/{len(data['annotations'])} boxes")
    print(f"Original annotations: {backup}")
    if failed:
        print(f"Kept {len(failed)} original boxes where segmentation was uncertain")
        for name in failed:
            print(f"  {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
