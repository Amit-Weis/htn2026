"""Bootstrap one-class COCO boxes using card feature and color matching."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np


SUFFIXES = {".jpg", ".jpeg", ".png"}


def card_color_box(image: np.ndarray) -> tuple[int, int, int, int]:
    """Fallback box around the largest saturated purple region."""
    height, width = image.shape[:2]
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, (120, 60, 30), (170, 255, 255))
    kernel_size = max(9, round(min(height, width) * 0.01)) | 1
    kernel = np.ones((kernel_size, kernel_size), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contour = max(contours, key=cv2.contourArea)
    x, y, box_width, box_height = cv2.boundingRect(contour)
    # Color often covers only pieces of the PCB; include its nearby white/screen area.
    padding_x = round(box_width * 0.35)
    padding_y = round(box_height * 0.35)
    x1, y1 = max(0, x - padding_x), max(0, y - padding_y)
    x2 = min(width, x + box_width + padding_x)
    y2 = min(height, y + box_height + padding_y)
    return x1, y1, x2 - x1, y2 - y1


def reference_crop(image: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, (115, 35, 25), (175, 255, 255))
    mask = cv2.morphologyEx(
        mask, cv2.MORPH_CLOSE, np.ones((31, 31), np.uint8), iterations=2
    )
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    x, y, width, height = cv2.boundingRect(max(contours, key=cv2.contourArea))
    padding = 30
    x1, y1 = max(0, x - padding), max(0, y - padding)
    x2, y2 = min(image.shape[1], x + width + padding), min(image.shape[0], y + height + padding)
    return image[y1:y2, x1:x2]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, default=Path("training/data/all"))
    parser.add_argument("--reference", default="IMG_3376.JPG")
    parser.add_argument("--max-size", type=int, default=1280)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source, output = args.source.resolve(), args.output.resolve()
    candidates = sorted(
        path for path in source.rglob("*")
        if path.is_file() and path.suffix.lower() in SUFFIXES
    )
    unique: list[Path] = []
    fingerprints: set[str] = set()
    for path in candidates:
        fingerprint = hashlib.sha256(path.read_bytes()).hexdigest()
        if fingerprint not in fingerprints:
            fingerprints.add(fingerprint)
            unique.append(path)
        else:
            print(f"Skipping exact duplicate: {path.relative_to(source)}")

    try:
        reference_path = next(path for path in unique if path.name == args.reference)
    except StopIteration as error:
        raise SystemExit(f"Reference image not found: {args.reference}") from error
    template = reference_crop(cv2.imread(str(reference_path)))
    template_scale = min(1.0, 900 / max(template.shape[:2]))
    template = cv2.resize(template, None, fx=template_scale, fy=template_scale)
    sift = cv2.SIFT_create(nfeatures=1800)
    template_points, template_descriptors = sift.detectAndCompute(
        cv2.cvtColor(template, cv2.COLOR_BGR2GRAY), None
    )
    matcher = cv2.BFMatcher()

    image_dir, review_dir = output / "images", output / "review"
    image_dir.mkdir(parents=True, exist_ok=True)
    review_dir.mkdir(parents=True, exist_ok=True)
    coco = {
        "info": {"description": "Auto-annotated Forgetmenot hacker-card dataset"},
        "images": [],
        "annotations": [],
        "categories": [{"id": 1, "name": "hacker_card", "supercategory": "object"}],
    }
    fallback_count = 0
    for image_id, path in enumerate(unique, 1):
        image = cv2.imread(str(path), cv2.IMREAD_COLOR)
        original_height, original_width = image.shape[:2]
        match_scale = min(1.0, 1200 / max(image.shape[:2]))
        match_image = cv2.resize(image, None, fx=match_scale, fy=match_scale)
        points, descriptors = sift.detectAndCompute(
            cv2.cvtColor(match_image, cv2.COLOR_BGR2GRAY), None
        )
        inliers, box = 0, None
        if descriptors is not None:
            pairs = matcher.knnMatch(template_descriptors, descriptors, k=2)
            good = [first for first, second in pairs if first.distance < 0.72 * second.distance]
            if len(good) >= 8:
                source_points = np.float32(
                    [template_points[item.queryIdx].pt for item in good]
                ).reshape(-1, 1, 2)
                target_points = np.float32(
                    [points[item.trainIdx].pt for item in good]
                ).reshape(-1, 1, 2)
                transform, mask = cv2.findHomography(
                    source_points, target_points, cv2.RANSAC, 5
                )
                if transform is not None:
                    corners = np.float32([[[0, 0], [template.shape[1], 0],
                                           [template.shape[1], template.shape[0]],
                                           [0, template.shape[0]]]])
                    projected = cv2.perspectiveTransform(corners, transform)[0] / match_scale
                    candidate = cv2.boundingRect(projected)
                    inliers = int(mask.sum())
                    x, y, width, height = candidate
                    area_fraction = width * height / (original_width * original_height)
                    mostly_inside = (
                        x > -0.1 * original_width and y > -0.1 * original_height
                        and x + width < 1.1 * original_width
                        and y + height < 1.1 * original_height
                    )
                    if inliers >= 10 and 0.005 < area_fraction < 0.9 and mostly_inside:
                        x1, y1 = max(0, x), max(0, y)
                        x2 = min(original_width, x + width)
                        y2 = min(original_height, y + height)
                        box = (x1, y1, x2 - x1, y2 - y1)
        if box is None:
            box = card_color_box(image)
            fallback_count += 1

        save_scale = min(1.0, args.max_size / max(image.shape[:2]))
        saved = cv2.resize(image, None, fx=save_scale, fy=save_scale)
        x, y, width, height = [round(value * save_scale) for value in box]
        name = f"{path.stem}_{hashlib.sha1(str(path.relative_to(source)).encode()).hexdigest()[:8]}.jpg"
        cv2.imwrite(str(image_dir / name), saved, [cv2.IMWRITE_JPEG_QUALITY, 94])
        preview = saved.copy()
        color = (0, 165, 255) if inliers < 10 else (0, 255, 0)
        cv2.rectangle(preview, (x, y), (x + width, y + height), color, 4)
        cv2.putText(preview, f"hacker_card inliers={inliers}", (max(0, x), max(30, y - 8)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2)
        cv2.imwrite(str(review_dir / name), preview)
        coco["images"].append({"id": image_id, "file_name": f"images/{name}",
                               "width": saved.shape[1], "height": saved.shape[0],
                               "source_path": str(path.relative_to(source)),
                               "auto_match_inliers": inliers})
        coco["annotations"].append({"id": image_id, "image_id": image_id,
                                    "category_id": 1, "bbox": [x, y, width, height],
                                    "area": width * height, "iscrowd": 0})
    (output / "labels.json").write_text(json.dumps(coco, indent=2) + "\n")
    print(f"Wrote {len(unique)} images and boxes to {output}")
    print(f"Feature-matched: {len(unique) - fallback_count}; color fallback: {fallback_count}")
    print(f"Review overlays: {review_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
