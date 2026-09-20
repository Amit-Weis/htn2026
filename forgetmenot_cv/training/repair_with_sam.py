"""Expand point prompts into complete hacker-card boxes with MobileSAM."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from ultralytics import SAM


def parse_numbers(value: str) -> set[int]:
    result = set()
    for part in value.split(","):
        ends = [int(item) for item in part.strip().split("-")]
        result.update(range(ends[0], ends[-1] + 1))
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--numbers", required=True)
    parser.add_argument("--model", default="mobile_sam.pt")
    parser.add_argument("--points", type=Path, help="JSON map of review number to [x,y]")
    args = parser.parse_args()
    dataset = args.dataset.resolve()
    labels_path = dataset / "labels.json"
    data = json.loads(labels_path.read_text())
    annotations = {a["image_id"]: a for a in data["annotations"]}
    explicit = json.loads(args.points.read_text()) if args.points else {}
    model = SAM(args.model)
    changed, failed = 0, []

    for number in sorted(parse_numbers(args.numbers)):
        item = data["images"][number - 1]
        annotation = annotations.get(item["id"])
        if annotation is None:
            failed.append(number)
            continue
        if str(number) in explicit:
            point = explicit[str(number)]
        else:
            x, y, width, height = annotation["bbox"]
            point = [x + width // 2, y + height // 2]
        result = model.predict(
            str(dataset / item["file_name"]), points=[point], labels=[1], verbose=False
        )[0]
        if result.boxes is None or len(result.boxes) == 0:
            failed.append(number)
            continue
        x1, y1, x2, y2 = result.boxes.xyxy[0].cpu().tolist()
        padding = 2
        x1, y1 = max(0, round(x1) - padding), max(0, round(y1) - padding)
        x2 = min(item["width"], round(x2) + padding)
        y2 = min(item["height"], round(y2) + padding)
        box = [x1, y1, x2 - x1, y2 - y1]
        annotation["bbox"] = box
        annotation["area"] = box[2] * box[3]
        changed += 1
        print(f"#{number}: point {point} -> {box}")

    labels_path.write_text(json.dumps(data, indent=2) + "\n")
    print(f"SAM repaired {changed} boxes; failed: {failed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
