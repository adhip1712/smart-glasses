"""Offline model comparison for object-label mistakes.

This tool NEVER opens a webcam and NEVER contacts the running preview API.
Give it a still image containing the objects being confused:
    python -m ml.accuracy_audit path/to/book_laptop.jpg
It compares the same image with multiple YOLO weights and saves annotated
comparison images plus a JSON report. Larger models may download weights and
run more slowly. Predictions are not ground truth; inspect the image yourself.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def run_audit(image_path: Path, model_names: list[str], output_dir: Path,
              imgsz: int = 640, confidence: float = 0.15) -> dict[str, Any]:
    try:
        import cv2
        from ultralytics import YOLO
    except ImportError as exc:
        raise RuntimeError(
            "Missing ML dependencies. Install with .venv\\Scripts\\pip install -r requirements-ml.txt"
        ) from exc

    if not image_path.is_file():
        raise FileNotFoundError(f"Input image not found: {image_path}")
    image = cv2.imread(str(image_path))
    if image is None:
        raise ValueError(f"OpenCV could not decode image: {image_path}")

    output_dir.mkdir(parents=True, exist_ok=True)
    report: dict[str, Any] = {
        "input_image": str(image_path.resolve()),
        "image_width": int(image.shape[1]),
        "image_height": int(image.shape[0]),
        "imgsz": imgsz,
        "confidence_threshold": confidence,
        "warning": "Model predictions are not ground truth; compare against visible objects.",
        "models": [],
    }

    for model_name in model_names:
        model = YOLO(model_name)
        results = model.predict(
            source=image, imgsz=imgsz, conf=confidence, iou=0.5,
            max_det=100, verbose=False,
        )
        rows = []
        result = results[0] if results else None
        if result is not None and result.boxes is not None:
            names = result.names
            for box in result.boxes:
                class_id = int(box.cls.item())
                score = float(box.conf.item())
                x1, y1, x2, y2 = [round(float(v), 2) for v in box.xyxy[0].tolist()]
                label = names.get(class_id, str(class_id)) if isinstance(names, dict) else names[class_id]
                rows.append({
                    "label": str(label), "class_id": class_id,
                    "confidence": round(score, 4), "box_xyxy": [x1, y1, x2, y2],
                })
        rows.sort(key=lambda item: item["confidence"], reverse=True)

        rendered = result.plot() if result is not None else image.copy()
        safe_name = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in model_name)
        annotated_path = output_dir / f"{image_path.stem}_{safe_name}_annotated.jpg"
        if not cv2.imwrite(str(annotated_path), rendered):
            raise OSError(f"Could not write annotated image: {annotated_path}")

        report["models"].append({
            "weights": model_name, "detections": rows,
            "annotated_image": str(annotated_path.resolve()),
        })

    report_path = output_dir / f"{image_path.stem}_accuracy_audit.json"
    report["report_path"] = str(report_path.resolve())
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare object detector labels on a still image; no camera access.")
    parser.add_argument("image", type=Path, help="path to a still image with the confusing object(s)")
    parser.add_argument("--models", nargs="+", default=["yolov8n.pt", "yolov8s.pt"],
                        help="weights to compare (default: yolov8n.pt yolov8s.pt)")
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--conf", type=float, default=0.15,
                        help="low audit threshold to reveal uncertain candidate detections")
    parser.add_argument("--output-dir", type=Path, default=Path("artifacts/vision_accuracy_audit"))
    args = parser.parse_args()
    try:
        report = run_audit(args.image, args.models, args.output_dir, args.imgsz, args.conf)
    except Exception as exc:
        parser.exit(2, f"ERROR: {type(exc).__name__}: {exc}\n")
    for model in report["models"]:
        print(f"\nMODEL: {model['weights']}")
        if not model["detections"]:
            print("  No objects detected.")
        for det in model["detections"]:
            print(f"  {det['label']:<18} confidence={det['confidence']:.3f} box={det['box_xyxy']}")
        print(f"  annotated: {model['annotated_image']}")
    print(f"\nJSON report: {report['report_path']}")
    print("\nNOTE: confidence is not the same as correctness. Check the annotated images.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
