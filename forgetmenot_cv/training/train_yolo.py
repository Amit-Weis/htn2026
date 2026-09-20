"""Train the immediately testable Apple-silicon hacker-card detector."""

from pathlib import Path

from ultralytics import YOLO


def main() -> None:
    here = Path(__file__).resolve().parent
    model = YOLO("yolo26n.pt")
    model.train(
        data=str(here / "data/yolo/dataset.yaml"),
        epochs=30,
        imgsz=640,
        batch=8,
        device="mps",
        project=str(here / "runs"),
        name="hacker_card",
        patience=8,
        workers=2,
    )


if __name__ == "__main__":
    main()
