"""Apply reviewed x,y,width,height boxes keyed by one-based review number."""

import argparse
import json
from pathlib import Path


parser = argparse.ArgumentParser()
parser.add_argument("dataset", type=Path)
parser.add_argument("boxes", type=Path)
args = parser.parse_args()
labels = args.dataset / "labels.json"
data = json.loads(labels.read_text())
annotations = {a["image_id"]: a for a in data["annotations"]}
boxes = json.loads(args.boxes.read_text())
for number_text, box in boxes.items():
    item = data["images"][int(number_text) - 1]
    annotation = annotations[item["id"]]
    annotation["bbox"] = box
    annotation["area"] = box[2] * box[3]
labels.write_text(json.dumps(data, indent=2) + "\n")
print(f"Applied {len(boxes)} manually reviewed boxes")
