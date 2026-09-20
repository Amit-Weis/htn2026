"""Convert the generated COCO splits into Ultralytics YOLO detection format."""

from __future__ import annotations

import json
from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parent
COCO_ROOT = ROOT / "data/split"
YOLO_ROOT = ROOT / "data/yolo"


def main() -> int:
    for split in ("train", "validation", "test"):
        source = COCO_ROOT / split
        coco = json.loads((source / "labels.json").read_text())
        images = YOLO_ROOT / "images" / split
        labels = YOLO_ROOT / "labels" / split
        images.mkdir(parents=True, exist_ok=True)
        labels.mkdir(parents=True, exist_ok=True)
        annotations: dict[int, list[dict]] = {}
        for annotation in coco["annotations"]:
            annotations.setdefault(annotation["image_id"], []).append(annotation)
        for image in coco["images"]:
            filename = Path(image["file_name"]).name
            shutil.copy2(source / image["file_name"], images / filename)
            width, height = image["width"], image["height"]
            rows = []
            for annotation in annotations.get(image["id"], []):
                x, y, box_width, box_height = annotation["bbox"]
                center_x = (x + box_width / 2) / width
                center_y = (y + box_height / 2) / height
                rows.append(
                    f"0 {center_x:.8f} {center_y:.8f} "
                    f"{box_width / width:.8f} {box_height / height:.8f}"
                )
            (labels / f"{Path(filename).stem}.txt").write_text("\n".join(rows) + "\n")
    config = (
        f"path: {YOLO_ROOT}\n"
        "train: images/train\n"
        "val: images/validation\n"
        "test: images/test\n"
        "names:\n  0: hacker_card\n"
    )
    (YOLO_ROOT / "dataset.yaml").write_text(config)
    print(f"Wrote {YOLO_ROOT / 'dataset.yaml'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
