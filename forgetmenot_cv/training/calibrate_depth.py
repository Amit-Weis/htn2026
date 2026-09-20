"""Fit monocular-depth scale from centered-subject photos at measured distances."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO


def parse_sample(value: str) -> tuple[Path, float]:
    try:
        path, meters = value.rsplit("=", 1)
        distance = float(meters)
    except ValueError as error:
        raise argparse.ArgumentTypeError("use IMAGE=METERS") from error
    if distance <= 0:
        raise argparse.ArgumentTypeError("distance must be positive")
    return Path(path), distance


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Calibrate YOLO26 depth using centered objects at known distances"
    )
    parser.add_argument("--model", default="yolo26n-depth.pt")
    parser.add_argument("--sample", type=parse_sample, action="append", required=True)
    parser.add_argument("--output", type=Path, default=Path("models/depth_calibration.json"))
    args = parser.parse_args()
    if len(args.sample) < 2:
        parser.error("provide at least two --sample measurements")

    model = YOLO(args.model)
    raw, measured = [], []
    for path, meters in args.sample:
        image = cv2.imread(str(path))
        if image is None:
            raise SystemExit(f"Could not read {path}")
        result = model.predict(source=image, verbose=False)[0]
        depth = result.depth.data.cpu().numpy().squeeze()
        h, w = depth.shape
        center = depth[h * 3 // 8:h * 5 // 8, w * 3 // 8:w * 5 // 8]
        values = center[np.isfinite(center) & (center > 0)]
        if values.size == 0:
            raise SystemExit(f"No valid depth predicted for {path}")
        prediction = float(np.median(values))
        raw.append(prediction)
        measured.append(meters)
        print(f"{path}: raw={prediction:.3f} m measured={meters:.3f} m")

    exponent, log_scale = np.polyfit(np.log(raw), np.log(measured), 1)
    payload = {
        "model": args.model,
        "scale": float(np.exp(log_scale)),
        "exponent": float(exponent),
        "samples": len(raw),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"Saved {args.output}: scale={payload['scale']:.6f}, exponent={exponent:.6f}")


if __name__ == "__main__":
    main()
