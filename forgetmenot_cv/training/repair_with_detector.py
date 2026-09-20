"""Repair selected annotations using the current detector as a box proposal source."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
from ultralytics import YOLO


DEFAULT_NUMBERS = (
    "226-231,233,236,238,245-246,250-258,261-275,277,288-306,"
    "308-315,318,320-321,324-349,351-361,366-367,369,371-383,386-388"
)


def parse_numbers(value: str) -> set[int]:
    numbers = set()
    for part in value.split(","):
        bounds = [int(item) for item in part.strip().split("-")]
        numbers.update(range(bounds[0], bounds[-1] + 1))
    return numbers


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, default=Path("training/data/all"))
    parser.add_argument("--model", default="training/runs/hacker_card-2/weights/best.pt")
    parser.add_argument("--numbers", default=DEFAULT_NUMBERS)
    parser.add_argument("--confidence", type=float, default=0.01)
    args = parser.parse_args()
    dataset = args.dataset.resolve()
    labels_path = dataset / "labels.json"
    data = json.loads(labels_path.read_text())
    selected = parse_numbers(args.numbers)
    annotations = {a["image_id"]: a for a in data["annotations"]}
    model = YOLO(args.model)
    repaired, failed = 0, []

    for number in sorted(selected):
        item = data["images"][number - 1]
        image = cv2.imread(str(dataset / item["file_name"]))
        result = model.predict(image, conf=args.confidence, verbose=False)[0]
        if result.boxes is None or len(result.boxes) == 0:
            failed.append(number)
            continue
        best = int(result.boxes.conf.argmax().item())
        x1, y1, x2, y2 = result.boxes.xyxy[best].cpu().tolist()
        x1, y1 = max(0, round(x1)), max(0, round(y1))
        x2 = min(item["width"], round(x2))
        y2 = min(item["height"], round(y2))
        box = [x1, y1, x2 - x1, y2 - y1]
        if box[2] <= 0 or box[3] <= 0:
            failed.append(number)
            continue
        annotation = annotations.get(item["id"])
        if annotation is None:
            annotation = {
                "id": max(a["id"] for a in data["annotations"]) + 1,
                "image_id": item["id"], "category_id": 1,
                "iscrowd": 0,
            }
            data["annotations"].append(annotation)
            annotations[item["id"]] = annotation
        annotation["bbox"] = box
        annotation["area"] = box[2] * box[3]
        repaired += 1

    # Keep review numbering stable and use #350 as a valuable true negative.
    negative_item = data["images"][349]
    data["annotations"] = [
        a for a in data["annotations"] if a["image_id"] != negative_item["id"]
    ]
    labels_path.write_text(json.dumps(data, indent=2) + "\n")
    print(f"Repaired {repaired}/{len(selected)} requested boxes")
    print(f"No detector proposal for: {failed}")
    print("#350 retained as an unboxed negative")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
