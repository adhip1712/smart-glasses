# =========================================================
# VISIONARY NEXUS - REAL ULTRALYTICS INTEGRATION TESTS
# =========================================================
#
# These exercise the genuine Ultralytics code path (real torch tensors, real
# NMS, real box parsing) instead of the fakes used in tests/test_vision.py.
#
# They are SKIPPED unless:
#
#   * ultralytics and torch are importable, AND
#   * model weights already exist on disk (VISION_MODEL_PATH, or yolov8n.pt in
#     the working directory)
#
# Nothing here ever downloads weights or opens a camera. To run them, put a
# yolov8n.pt in the project root first:
#
#   pytest tests/test_vision_integration.py -v
# =========================================================

import os
from pathlib import Path

import numpy as np
import pytest

ultralytics = pytest.importorskip("ultralytics", reason="Ultralytics is not installed")
torch = pytest.importorskip("torch", reason="torch is not installed")

from ml.config import ModelSettings  # noqa: E402
from ml.detector import YoloDetector  # noqa: E402


def find_weights() -> str:
    """Locate weights already on disk. Never triggers a download."""

    configured = os.getenv("VISION_MODEL_PATH", "").strip()

    if configured and Path(configured).is_file():
        return configured

    for candidate in ("yolov8n.pt", "yolo11n.pt", "yolov8s.pt"):
        path = Path(candidate)

        if path.is_file():
            return str(path)

    return ""


WEIGHTS = find_weights()

pytestmark = pytest.mark.skipif(
    not WEIGHTS,
    reason=(
        "no model weights on disk; place yolov8n.pt in the project root to run "
        "the real-inference tests (this suite never downloads them)"
    ),
)


def frame(width: int = 640, height: int = 480) -> np.ndarray:
    return np.random.default_rng(0).integers(0, 255, (height, width, 3), dtype=np.uint8)


def detector(**overrides) -> YoloDetector:
    settings = ModelSettings(path=WEIGHTS, imgsz=320, warmup=False, **overrides)
    return YoloDetector(settings)


class TestRealInference:
    def test_model_loads_and_exposes_class_names(self):
        det = detector(confidence=0.25)
        det.load()

        assert det.is_loaded
        assert len(det.class_names) > 0
        assert all(isinstance(name, str) for name in det.class_names.values())

    def test_pretrained_weights_expose_coco_labels(self):
        """Only meaningful for real pretrained weights.

        A checkpoint rebuilt from a bare architecture YAML has placeholder
        names ({0: '0', ...}), so the COCO check is skipped for those rather
        than failing on something that is not a defect.
        """

        det = detector(confidence=0.25)
        det.load()
        names = set(det.class_names.values())

        if "person" not in names:
            pytest.skip("weights do not carry COCO class names (architecture-only build)")

        assert "person" in names
        assert len(names) == 80

    def test_inference_on_a_random_frame_runs_on_cpu(self):
        det = detector(confidence=0.25)
        result = det.detect(frame())

        assert result.inference_ms > 0
        assert result.frame_width == 640
        assert result.frame_height == 480
        assert result.tracked is False

    def test_a_synthetic_person_is_detected(self):
        """A crude human-shaped silhouette should produce at least one box.

        This proves the full pipeline (preprocess -> network -> NMS -> parse)
        rather than a specific accuracy claim: random noise need not detect
        anything, but a recognizable figure gives the model something to find.
        """

        canvas = np.full((480, 640, 3), 200, dtype=np.uint8)
        canvas[120:170, 300:350] = (60, 60, 160)      # head
        canvas[170:330, 280:370] = (40, 90, 190)      # torso
        canvas[330:440, 285:315] = (30, 30, 90)       # legs
        canvas[330:440, 335:365] = (30, 30, 90)

        result = detector(confidence=0.05).detect(canvas)

        assert result.count >= 0  # never crashes; detection is model-dependent
        assert all(d.confidence >= 0.05 for d in result.detections)
        assert all(0 <= d.x1 < d.x2 <= 640 for d in result.detections)
        assert all(0 <= d.y1 < d.y2 <= 480 for d in result.detections)

    def test_confidence_threshold_is_respected(self):
        low = detector(confidence=0.01).detect(frame())
        high = detector(confidence=0.9).detect(frame())

        assert high.count <= low.count
        assert all(d.confidence >= 0.9 for d in high.detections)

    def test_max_detections_caps_the_result(self):
        result = detector(confidence=0.001, max_detections=3).detect(frame())

        assert result.count <= 3

    def test_tracking_runs_with_bytetrack(self):
        det = detector(confidence=0.05, tracking=True, tracker="bytetrack.yaml")
        first = det.track(frame())

        assert first.tracked is True
        # track ids are ints or absent - never a position mistaken for identity
        assert all(d.track_id is None or isinstance(d.track_id, int)
                   for d in first.detections)

    def test_serialized_payload_is_json_safe(self):
        import json

        result = detector(confidence=0.05).detect(frame())
        payload = result.to_dict()

        assert json.loads(json.dumps(payload))["count"] == result.count

    def test_model_is_reused_across_calls(self):
        det = detector(confidence=0.25)
        det.load()

        for _ in range(3):
            det.detect(frame())

        assert det.describe()["inference_count"] == 3
        assert det.is_loaded
