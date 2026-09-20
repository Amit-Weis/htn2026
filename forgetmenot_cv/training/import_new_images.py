"""Append new hacker-card photos with tight automatic COCO annotations."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil

import cv2
import numpy as np

from tighten_annotations import purple_card_box


SUFFIXES = {".jpg", ".jpeg", ".png"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("--dataset", type=Path, default=Path("training/data/all"))
    parser.add_argument("--reference-number", type=int, default=113)
    parser.add_argument("--max-size", type=int, default=1280)
    args = parser.parse_args()
    source, dataset = args.source.resolve(), args.dataset.resolve()
    labels_path = dataset / "labels.json"
    data = json.loads(labels_path.read_text())
    annotations_by_image = {a["image_id"]: a for a in data["annotations"]}

    reference = data["images"][args.reference_number - 1]
    reference_image = cv2.imread(str(dataset / reference["file_name"]))
    x, y, width, height = annotations_by_image[reference["id"]]["bbox"]
    template = reference_image[y:y + height, x:x + width]
    sift = cv2.SIFT_create(nfeatures=3000)
    template_points, template_descriptors = sift.detectAndCompute(
        cv2.cvtColor(template, cv2.COLOR_BGR2GRAY), None
    )
    matcher = cv2.BFMatcher()

    existing_sources = {item.get("source_path") for item in data["images"]}
    next_image_id = max(item["id"] for item in data["images"]) + 1
    next_annotation_id = max(item["id"] for item in data["annotations"]) + 1
    imported, feature_count, fallback_count = 0, 0, 0
    candidates = sorted(
        path for path in source.rglob("*")
        if path.is_file() and path.suffix.lower() in SUFFIXES
    )
    for path in candidates:
        source_key = f"{source.name}/{path.relative_to(source)}"
        if source_key in existing_sources:
            continue
        image = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if image is None:
            print(f"Skipping unreadable file: {path}")
            continue
        original_height, original_width = image.shape[:2]
        match_scale = min(1.0, 1400 / max(image.shape[:2]))
        target = cv2.resize(image, None, fx=match_scale, fy=match_scale)
        points, descriptors = sift.detectAndCompute(
            cv2.cvtColor(target, cv2.COLOR_BGR2GRAY), None
        )
        box, inliers = None, 0
        if descriptors is not None:
            pairs = matcher.knnMatch(template_descriptors, descriptors, k=2)
            good = [a for a, b in pairs if a.distance < 0.76 * b.distance]
            if len(good) >= 8:
                src = np.float32([template_points[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
                dst = np.float32([points[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
                transform, mask = cv2.findHomography(src, dst, cv2.RANSAC, 6)
                if transform is not None:
                    inliers = int(mask.sum())
                    corners = np.float32([[[0, 0], [width, 0], [width, height], [0, height]]])
                    projected = cv2.perspectiveTransform(corners, transform)[0] / match_scale
                    bx, by, bw, bh = cv2.boundingRect(projected)
                    bx, by = max(0, bx), max(0, by)
                    bw, bh = min(original_width - bx, bw), min(original_height - by, bh)
                    fraction = bw * bh / (original_width * original_height)
                    if inliers >= 8 and bw > 0 and bh > 0 and 0.001 < fraction < 0.8:
                        box = [bx, by, bw, bh]
        if box is None:
            box = purple_card_box(image, [0, 0, original_width, original_height])
            fallback_count += 1
        else:
            feature_count += 1
        is_negative = box is None

        save_scale = min(1.0, args.max_size / max(image.shape[:2]))
        saved = cv2.resize(image, None, fx=save_scale, fy=save_scale)
        if box is not None:
            box = [round(value * save_scale) for value in box]
        digest = hashlib.sha1(source_key.encode()).hexdigest()[:10]
        name = f"{path.stem}_{digest}.jpg"
        cv2.imwrite(str(dataset / "images" / name), saved, [cv2.IMWRITE_JPEG_QUALITY, 94])
        data["images"].append({
            "id": next_image_id,
            "file_name": f"images/{name}",
            "width": saved.shape[1],
            "height": saved.shape[0],
            "source_path": source_key,
            "auto_match_inliers": inliers,
        })
        if not is_negative:
            data["annotations"].append({
                "id": next_annotation_id,
                "image_id": next_image_id,
                "category_id": 1,
                "bbox": box,
                "area": box[2] * box[3],
                "iscrowd": 0,
            })
            next_annotation_id += 1
        else:
            print(f"Imported as candidate negative: {path.name}")
        next_image_id += 1
        imported += 1

    backup = dataset / "labels.before_new_import.json"
    if not backup.exists():
        shutil.copy2(labels_path, backup)
    labels_path.write_text(json.dumps(data, indent=2) + "\n")
    print(f"Imported {imported} images: {feature_count} feature boxes, {fallback_count} color fallbacks")
    print(f"Combined dataset: {len(data['images'])} images")
    print(f"Pre-import backup: {backup}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
