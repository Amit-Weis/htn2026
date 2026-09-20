"""Install the custom model into the desktop and Unity Android targets."""

from __future__ import annotations

import argparse
from pathlib import Path
import shutil


PROJECT = Path(__file__).resolve().parents[2]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "model", type=Path, nargs="?",
        help="exported hacker-card ONNX model (defaults to the newest training run)",
    )
    args = parser.parse_args()
    if args.model is None:
        candidates = list((Path(__file__).parent / "runs").glob("*/weights/best.onnx"))
        if not candidates:
            raise SystemExit("No exported best.onnx found; export a training checkpoint first")
        model = max(candidates, key=lambda path: path.stat().st_mtime).resolve()
    else:
        model = args.model.resolve()
    if not model.is_file():
        raise SystemExit(f"Model not found: {model}")
    destinations = [
        PROJECT / "forgetmenot_cv/models/hacker_card.onnx",
        PROJECT / (
            "Assets/Plugins/Android/ForgetmenotMediaPipe.androidlib/"
            "src/main/assets/hacker_card.onnx"
        ),
    ]
    for destination in destinations:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(model, destination)
        print(f"Installed {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
