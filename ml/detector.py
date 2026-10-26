# =========================================================
# VISIONARY NEXUS - OBJECT DETECTION
# =========================================================
#
# Pretrained Ultralytics YOLO detection (and optional tracking) on frames that
# come from any `FrameSource`. Nothing in this module knows what a webcam is.
#
#   detector = YoloDetector(settings.model)
#   detector.load()                      # once, lazily, never per frame
#   detections = detector.detect(frame)  # list[Detection]
#   detections = detector.track(frame)   # same, with track_id where possible
#
# Ultralytics is imported lazily: the backend, the config loader and the tests
# all work on a machine where torch/ultralytics are not installed, and a missing
# model is an error value in `describe()`, not a crash.
#
# What it can find: the pretrained COCO classes (person, car, bottle, laptop,
# ... and the other 70-odd). It does not recognise arbitrary objects, and it
# does not claim to - see ml/README.md.
# =========================================================

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence

from .config import ModelSettings

COCO_CLASS_COUNT = 80


class ModelUnavailableError(RuntimeError):
    """The detection model could not be loaded (not installed, missing, offline)."""


def _seq(value: Any) -> List[Any]:
    """Normalise tensor / ndarray / list results into a plain Python list."""

    if value is None:
        return []

    if hasattr(value, "cpu"):
        try:
            value = value.cpu()
        except Exception:
            pass

    if hasattr(value, "numpy"):
        try:
            value = value.numpy()
        except Exception:
            pass

    if hasattr(value, "tolist"):
        try:
            value = value.tolist()
        except Exception:
            pass

    if isinstance(value, (list, tuple)):
        return list(value)

    return [value]


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_int(value: Any, default: int = -1) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------
# RESULT
# ---------------------------------------------------------

@dataclass
class Detection:
    """One detected object on one frame."""

    label: str
    class_id: int
    confidence: float
    x1: float
    y1: float
    x2: float
    y2: float
    track_id: Optional[int] = None
    frame_width: int = 0
    frame_height: int = 0

    # -- geometry ------------------------------------------------------

    @property
    def width(self) -> float:
        return max(0.0, self.x2 - self.x1)

    @property
    def height(self) -> float:
        return max(0.0, self.y2 - self.y1)

    @property
    def area(self) -> float:
        return round(self.width * self.height, 2)

    @property
    def center(self) -> Dict[str, float]:
        return {
            "x": round((self.x1 + self.x2) / 2, 2),
            "y": round((self.y1 + self.y2) / 2, 2),
        }

    @property
    def tracked(self) -> bool:
        return self.track_id is not None

    def normalized_box(self) -> Optional[Dict[str, float]]:
        """Box as 0..1 fractions, for drawing on a scaled preview."""

        if not self.frame_width or not self.frame_height:
            return None

        return {
            "x": round(self.x1 / self.frame_width, 4),
            "y": round(self.y1 / self.frame_height, 4),
            "width": round(self.width / self.frame_width, 4),
            "height": round(self.height / self.frame_height, 4),
        }

    def to_dict(self) -> Dict[str, Any]:
        payload = {
            "label": self.label,
            "class_id": self.class_id,
            "confidence": round(self.confidence, 4),
            "box": {
                "x1": round(self.x1, 2),
                "y1": round(self.y1, 2),
                "x2": round(self.x2, 2),
                "y2": round(self.y2, 2),
            },
            "center": self.center,
            "width": round(self.width, 2),
            "height": round(self.height, 2),
            "area": self.area,
            "track_id": self.track_id,
            "tracked": self.tracked,
        }

        normalized = self.normalized_box()

        if normalized is not None:
            payload["box_normalized"] = normalized

        return payload


@dataclass
class InferenceResult:
    """Detections plus the timing of the call that produced them."""

    detections: List[Detection] = field(default_factory=list)
    inference_ms: float = 0.0
    frame_width: int = 0
    frame_height: int = 0
    tracked: bool = False

    @property
    def count(self) -> int:
        return len(self.detections)

    def labels(self) -> Dict[str, int]:
        counts: Dict[str, int] = {}

        for detection in self.detections:
            counts[detection.label] = counts.get(detection.label, 0) + 1

        return counts

    def to_dict(self) -> Dict[str, Any]:
        return {
            "count": self.count,
            "labels": self.labels(),
            "inference_ms": round(self.inference_ms, 2),
            "tracked": self.tracked,
            "frame": {"width": self.frame_width, "height": self.frame_height},
            "detections": [detection.to_dict() for detection in self.detections],
        }


# ---------------------------------------------------------
# DETECTOR
# ---------------------------------------------------------

def _default_model_loader(path: str) -> Any:
    """Load a YOLO model through Ultralytics (imported here, not at module level)."""

    try:
        from ultralytics import YOLO  # noqa: PLC0415 - optional, heavy dependency
    except ImportError as error:
        raise ModelUnavailableError(
            "Ultralytics is not installed, so object detection is unavailable. "
            "Install the ML extras into the project virtual environment:\n"
            "  Windows:  .venv\\Scripts\\pip install -r requirements-ml.txt\n"
            "  Linux:    .venv/bin/pip install -r requirements-ml.txt\n"
            f"(import error: {error})"
        ) from None

    return YOLO(path)


class YoloDetector:
    """Pretrained YOLO detector with optional ByteTrack tracking.

    The model is loaded once and reused; `detect()` only runs inference.
    """

    def __init__(
        self,
        settings: Optional[ModelSettings] = None,
        model_loader: Optional[Callable[[str], Any]] = None,
    ) -> None:
        self.settings = settings or ModelSettings()
        self._model_loader = model_loader or _default_model_loader
        self._model: Any = None
        self._error: str = ""
        self._warning: str = ""
        self._classes: Dict[int, str] = {}
        # Re-entrant on purpose: load() -> _warm_up() -> _call() all run on the
        # same thread, and an Ultralytics model must not be predicted on by two
        # threads at once. A plain Lock here deadlocks the very first load.
        self._lock = threading.RLock()
        self._reset_tracking_next = False
        self._inference_ms: List[float] = []
        self._inference_count = 0

    # -- loading -------------------------------------------------------

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    @property
    def error(self) -> str:
        return self._error

    @property
    def class_names(self) -> Dict[int, str]:
        return dict(self._classes)

    def weights_path(self) -> Optional[Path]:
        """The on-disk weights file when the setting names one, else None."""

        path = Path(self.settings.path)

        if path.is_file():
            return path

        # A bare model name (yolov8n.pt) is resolved by Ultralytics, which also
        # looks in the current working directory before downloading.
        if "/" not in self.settings.path and "\\" not in self.settings.path:
            local = Path.cwd() / self.settings.path

            if local.is_file():
                return local

        return None

    def weights_present(self) -> bool:
        return self.weights_path() is not None

    def load(self) -> bool:
        """Load the model once. Raises ModelUnavailableError on failure."""

        with self._lock:
            if self._model is not None:
                return True

            if self._error:
                raise ModelUnavailableError(self._error)

            path = self.settings.path

            if not self.weights_present() and not self.settings.allow_download:
                self._error = (
                    f"model weights {path!r} were not found and downloading is disabled "
                    "(VISION_ALLOW_MODEL_DOWNLOAD=false). Put the .pt file next to the "
                    "project or point VISION_MODEL_PATH at it."
                )
                raise ModelUnavailableError(self._error)

            try:
                self._model = self._model_loader(path)
            except ModelUnavailableError as error:
                self._error = str(error)
                raise
            except Exception as error:
                self._error = (
                    f"the model {path!r} could not be loaded: {type(error).__name__}: {error}. "
                    "If it has to be downloaded, check the network connection, or download "
                    "it once and place it in the project directory."
                )
                raise ModelUnavailableError(self._error) from None

            self._classes = self._read_class_names(self._model)
            self._error = ""

        # Warm up outside the lock: it runs a real inference and must not keep
        # the model locked while other threads are waiting for it to load.
        if self.settings.warmup:
            self._warm_up()

        return True

    def _read_class_names(self, model: Any) -> Dict[int, str]:
        names = getattr(model, "names", None)

        if isinstance(names, dict):
            return {int(key): str(value) for key, value in names.items()}

        if isinstance(names, (list, tuple)):
            return {index: str(value) for index, value in enumerate(names)}

        return {}

    def _label_for(self, class_id: int, result: Any = None) -> str:
        names = getattr(result, "names", None) if result is not None else None

        if isinstance(names, dict) and class_id in names:
            return str(names[class_id])

        if isinstance(names, (list, tuple)) and 0 <= class_id < len(names):
            return str(names[class_id])

        return self._classes.get(class_id, f"class_{class_id}")

    def _warm_up(self) -> None:
        """One blank inference, so the first real frame is not the slow one."""

        try:
            import numpy as _np

            blank = _np.zeros((self.settings.imgsz, self.settings.imgsz, 3), dtype="uint8")
            self._call(blank, track=False)
        except Exception as error:
            # A warm-up failure is not fatal: report it and keep the model.
            self._warning = f"warm-up inference failed: {type(error).__name__}: {error}"

    # -- inference -----------------------------------------------------

    def detect(self, frame: Any) -> InferenceResult:
        """Detect objects in one BGR frame."""

        return self._call(frame, track=False)

    def track(self, frame: Any) -> InferenceResult:
        """Detect objects and keep their ids across frames (ByteTrack by default)."""

        return self._call(frame, track=True)

    def process(self, frame: Any) -> InferenceResult:
        """Detect, or track when `VISION_TRACKING` is on."""

        return self._call(frame, track=bool(self.settings.tracking))

    def _call(self, frame: Any, track: bool) -> InferenceResult:
        if not self.is_loaded:
            self.load()

        height = int(getattr(frame, "shape", [0, 0])[0] or 0)
        width = int(getattr(frame, "shape", [0, 0, 0])[1] or 0)

        if not height or not width:
            raise ValueError("the detector needs a BGR frame with width and height")

        device = self.settings.resolve_device()

        kwargs: Dict[str, Any] = {
            "source": frame,
            "conf": self.settings.confidence,
            "iou": self.settings.iou,
            "imgsz": self.settings.imgsz,
            "max_det": self.settings.max_detections,
            "device": device,
            "verbose": False,
        }

        if track:
            kwargs["tracker"] = self.settings.tracker
            kwargs["persist"] = not self._reset_tracking_next
            self._reset_tracking_next = False

        started = time.perf_counter()

        try:
            with self._lock:
                if track:
                    results = self._model.track(**kwargs)
                else:
                    results = self._model.predict(**kwargs)
        except Exception as error:
            raise ModelUnavailableError(
                f"inference failed: {type(error).__name__}: {error}"
            ) from None

        elapsed_ms = (time.perf_counter() - started) * 1000
        self._record_timing(elapsed_ms)

        detections = self._parse(results, width, height)

        if self.settings.tracking and not track:
            # Keep the ids stable only when tracking was asked for.
            detections = [d for d in detections]

        return InferenceResult(
            detections=detections,
            inference_ms=elapsed_ms,
            frame_width=width,
            frame_height=height,
            tracked=track,
        )

    def _parse(self, results: Any, width: int, height: int) -> List[Detection]:
        detections: List[Detection] = []

        if results is None:
            return detections

        if not isinstance(results, (list, tuple)):
            results = [results]

        for result in results:
            boxes = getattr(result, "boxes", None)

            if boxes is None:
                continue

            xyxy = _seq(getattr(boxes, "xyxy", None))
            confidences = _seq(getattr(boxes, "conf", None))
            classes = _seq(getattr(boxes, "cls", None))
            track_ids = _seq(getattr(boxes, "id", None))

            for index, coordinates in enumerate(xyxy):
                values = _seq(coordinates)

                if len(values) < 4:
                    continue

                class_id = _as_int(classes[index]) if index < len(classes) else -1
                confidence = _as_float(confidences[index]) if index < len(confidences) else 0.0

                track_id = None

                if index < len(track_ids) and track_ids[index] is not None:
                    parsed = _as_int(track_ids[index], default=-1)
                    track_id = parsed if parsed >= 0 else None

                detections.append(
                    Detection(
                        label=self._label_for(class_id, result),
                        class_id=class_id,
                        confidence=confidence,
                        x1=max(0.0, _as_float(values[0])),
                        y1=max(0.0, _as_float(values[1])),
                        x2=min(float(width), _as_float(values[2])),
                        y2=min(float(height), _as_float(values[3])),
                        track_id=track_id,
                        frame_width=width,
                        frame_height=height,
                    )
                )

        detections.sort(key=lambda detection: detection.confidence, reverse=True)
        return detections

    def _record_timing(self, elapsed_ms: float) -> None:
        self._inference_count += 1
        self._inference_ms.append(elapsed_ms)

        if len(self._inference_ms) > 60:
            del self._inference_ms[:-60]

    @property
    def last_inference_ms(self) -> float:
        return round(self._inference_ms[-1], 2) if self._inference_ms else 0.0

    @property
    def average_inference_ms(self) -> float:
        if not self._inference_ms:
            return 0.0

        return round(sum(self._inference_ms) / len(self._inference_ms), 2)

    def reset_tracking(self) -> None:
        """Drop tracker state so ids restart cleanly after a stop."""

        self._reset_tracking_next = True

    def close(self) -> None:
        """Release the model reference (weights stay on disk)."""

        with self._lock:
            self._model = None

        self._inference_ms.clear()

    # -- reporting -----------------------------------------------------

    def describe(self) -> Dict[str, Any]:
        installed, version = _ultralytics_status()
        weights = self.weights_path()

        return {
            "loaded": self.is_loaded,
            "available": installed,
            "ultralytics_version": version,
            "path": self.settings.path,
            "weights_path": str(weights) if weights else "",
            "weights_present": weights is not None,
            "device": self.settings.resolve_device(),
            "confidence": self.settings.confidence,
            "iou": self.settings.iou,
            "imgsz": self.settings.imgsz,
            "max_detections": self.settings.max_detections,
            "tracking": self.settings.tracking,
            "tracker": self.settings.tracker,
            "class_count": len(self._classes) or (COCO_CLASS_COUNT if installed else 0),
            "inference_count": self._inference_count,
            "last_inference_ms": self.last_inference_ms,
            "average_inference_ms": self.average_inference_ms,
            "error": self._error,
            "warning": self._warning,
        }


def _ultralytics_status() -> tuple:
    """(installed, version) without importing Ultralytics."""

    try:
        from importlib.metadata import PackageNotFoundError, version  # noqa: PLC0415

        try:
            return True, version("ultralytics")
        except PackageNotFoundError:
            return False, ""
    except Exception:
        return False, ""
