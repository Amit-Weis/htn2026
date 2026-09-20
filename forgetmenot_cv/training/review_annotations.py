"""Render saved COCO boxes into numbered contact sheets for fast review."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path, nargs="?", default=Path("training/data/all"))
    parser.add_argument("--output", type=Path, default=Path("outputs/annotation_review"))
    parser.add_argument("--columns", type=int, default=4)
    parser.add_argument("--rows", type=int, default=4)
    parser.add_argument("--start-number", type=int, default=1)
    args = parser.parse_args()

    dataset = args.dataset.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    data = json.loads((dataset / "labels.json").read_text())
    annotations: dict[int, list[dict]] = {}
    for annotation in data["annotations"]:
        annotations.setdefault(annotation["image_id"], []).append(annotation)

    tile_width, tile_height = 400, 330
    page_size = args.columns * args.rows
    pages = []
    manifest = []
    selected_images = data["images"][args.start_number - 1:]
    for page_start in range(0, len(selected_images), page_size):
        canvas = np.full(
            (args.rows * tile_height, args.columns * tile_width, 3), 28, dtype=np.uint8
        )
        page_images = selected_images[page_start:page_start + page_size]
        for offset, item in enumerate(page_images):
            image = cv2.imread(str(dataset / item["file_name"]))
            if image is None:
                continue
            scale = min(tile_width / image.shape[1], (tile_height - 48) / image.shape[0])
            resized = cv2.resize(image, None, fx=scale, fy=scale)
            row, column = divmod(offset, args.columns)
            left = column * tile_width + (tile_width - resized.shape[1]) // 2
            top = row * tile_height + 32
            canvas[top:top + resized.shape[0], left:left + resized.shape[1]] = resized
            for annotation in annotations.get(item["id"], []):
                x, y, width, height = annotation["bbox"]
                p1 = (left + round(x * scale), top + round(y * scale))
                p2 = (left + round((x + width) * scale), top + round((y + height) * scale))
                cv2.rectangle(canvas, p1, p2, (40, 255, 70), 3)
            review_number = args.start_number + page_start + offset
            name = Path(item["file_name"]).name
            label = f"#{review_number:03d}  {name}"
            cv2.putText(
                canvas, label, (column * tile_width + 8, row * tile_height + 23),
                cv2.FONT_HERSHEY_SIMPLEX, 0.48, (255, 255, 255), 1, cv2.LINE_AA,
            )
            manifest.append(f"#{review_number:03d}\t{name}\t{item.get('source_path', '')}")
        page_number = len(pages) + 1
        page_path = output / f"boxes_{page_number:02d}.jpg"
        cv2.imwrite(str(page_path), canvas, [cv2.IMWRITE_JPEG_QUALITY, 92])
        pages.append(page_path)

    (output / "manifest.txt").write_text("\n".join(manifest) + "\n")
    print(f"Rendered {len(selected_images)} annotations across {len(pages)} sheets in {output}")
    print("Report bad boxes using their # number from the sheet.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
