"""Compatibility entry point for ``python app.py``."""

from src.app import main


if __name__ == "__main__":
    raise SystemExit(main())
