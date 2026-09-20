"""Interactively create one-class COCO annotations for the hacker card."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import cv2


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Draw one hacker-card box per image; cancel the box for negatives."
    )
    parser.add_argument("source", type=Path, help="folder containing source photographs")
    parser.add_argument(
        "--output", type=Path, default=Path("training/data/all"),
        help="normalized images and labels.json destination",
    )
    parser.add_argument("--label", default="hacker_card")
    return parser.parse_args()


def load_coco(path: Path, label: str) -> dict:
    if path.exists():
        return json.loads(path.read_text())
    return {
        "info": {"description": "Forgetmenot hacker-card dataset"},
        "images": [],
        "annotations": [],
        "categories": [{"id": 1, "name": label, "supercategory": "object"}],
    }


def save_coco(path: Path, data: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, indent=2) + "\n")
    temporary.replace(path)


def main() -> int:
    args = parse_args()
    source = args.source.expanduser().resolve()
    output = args.output.expanduser().resolve()
    if not source.is_dir():
        raise SystemExit(f"Source folder does not exist: {source}")

    image_dir = output / "images"
    image_dir.mkdir(parents=True, exist_ok=True)
    labels_path = output / "labels.json"
    coco = load_coco(labels_path, args.label)
    done = {item["source_path"] for item in coco["images"]}
    next_image_id = max((item["id"] for item in coco["images"]), default=0) + 1
    next_annotation_id = max((item["id"] for item in coco["annotations"]), default=0) + 1

    candidates = sorted(
        p for p in source.rglob("*") if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES
    )
    files = []
    fingerprints: set[str] = set()
    for path in candidates:
        fingerprint = hashlib.sha256(path.read_bytes()).hexdigest()
        if fingerprint in fingerprints:
            print(f"Skipping exact duplicate: {path.relative_to(source)}")
            continue
        fingerprints.add(fingerprint)
        files.append(path)
    print(f"Found {len(files)} images; {len(done)} already annotated.")
    print("Drag a tight box and press Enter/Space. Press C to mark a negative. Ctrl-C resumes safely.")

    try:
        for number, path in enumerate(files, 1):
            relative = str(path.relative_to(source))
            if relative in done:
                continue
            frame = cv2.imread(str(path), cv2.IMREAD_COLOR)
            if frame is None:
                print(f"Skipping unreadable image: {path}")
                continue
            height, width = frame.shape[:2]
            window = f"Hacker card {number}/{len(files)}"
            x, y, box_width, box_height = cv2.selectROI(window, frame, showCrosshair=True)
            cv2.destroyWindow(window)

            digest = hashlib.sha1(relative.encode()).hexdigest()[:10]
            destination_name = f"{path.stem}_{digest}.jpg"
            destination = image_dir / destination_name
            if not cv2.imwrite(str(destination), frame, [cv2.IMWRITE_JPEG_QUALITY, 94]):
                raise RuntimeError(f"Could not write {destination}")

            coco["images"].append({
                "id": next_image_id,
                "file_name": f"images/{destination_name}",
                "width": width,
                "height": height,
                "source_path": relative,
            })
            if box_width > 0 and box_height > 0:
                coco["annotations"].append({
                    "id": next_annotation_id,
                    "image_id": next_image_id,
                    "category_id": 1,
                    "bbox": [int(x), int(y), int(box_width), int(box_height)],
                    "area": int(box_width * box_height),
                    "iscrowd": 0,
                })
                next_annotation_id += 1
            else:
                print(f"Marked negative: {relative}")
            next_image_id += 1
            save_coco(labels_path, coco)
    finally:
        cv2.destroyAllWindows()
        save_coco(labels_path, coco)

    print(f"Saved {len(coco['images'])} images and {len(coco['annotations'])} boxes to {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
