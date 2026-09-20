"""Split a COCO folder into leakage-resistant train/validation/test folders."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path, help="COCO folder made by annotate.py")
    parser.add_argument("--output", type=Path, default=Path("training/data/split"))
    parser.add_argument(
        "--group-size", type=int, default=20,
        help="consecutive IMG numbers kept in one split to limit burst leakage",
    )
    return parser.parse_args()


def capture_group(image: dict, group_size: int) -> str:
    source = image.get("source_path", image["file_name"])
    match = re.search(r"IMG_(\d+)", source, re.IGNORECASE)
    if match:
        return f"IMG_{int(match.group(1)) // group_size}"
    return str(Path(source).parent)


def assignment(group: str) -> str:
    bucket = int(hashlib.sha256(group.encode()).hexdigest()[:8], 16) % 10
    if bucket == 0:
        return "test"
    if bucket == 1:
        return "validation"
    return "train"


def main() -> int:
    args = parse_args()
    if args.group_size < 1:
        raise SystemExit("--group-size must be positive")
    source = args.dataset.resolve()
    coco = json.loads((source / "labels.json").read_text())
    annotations_by_image: dict[int, list[dict]] = {}
    for annotation in coco["annotations"]:
        annotations_by_image.setdefault(annotation["image_id"], []).append(annotation)

    split_images = {name: [] for name in ("train", "validation", "test")}
    for image in coco["images"]:
        split_images[assignment(capture_group(image, args.group_size))].append(image)

    if any(not images for images in split_images.values()):
        raise SystemExit(
            "A split is empty. Try another --group-size or collect more independent sessions."
        )

    for split, images in split_images.items():
        destination = args.output.resolve() / split
        image_destination = destination / "images"
        image_destination.mkdir(parents=True, exist_ok=True)
        selected_ids = {item["id"] for item in images}
        selected_annotations = [
            annotation for image_id in selected_ids
            for annotation in annotations_by_image.get(image_id, [])
        ]
        for image in images:
            source_image = source / image["file_name"]
            target = image_destination / Path(image["file_name"]).name
            shutil.copy2(source_image, target)
            image["file_name"] = f"images/{target.name}"
        split_coco = {
            "info": coco.get("info", {}),
            "images": images,
            "annotations": selected_annotations,
            "categories": coco["categories"],
        }
        (destination / "labels.json").write_text(json.dumps(split_coco, indent=2) + "\n")
        print(f"{split}: {len(images)} images, {len(selected_annotations)} boxes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
