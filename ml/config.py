# =========================================================
# VISIONARY NEXUS - ML CONFIGURATION
# =========================================================
#
# Camera, model and confidence settings for the laptop-webcam vision pipeline.
#
# Values are resolved in this order (later wins):
#
#   1. the defaults in this file
#   2. ml/config/ml_config.json    - optional, user editable
#   3. environment variables       - see the table in ml/README.md
#
# Nothing here touches the ESP32 device protocol, the backend database or any
# existing API: it only describes how frames are acquired and detected.
#
#   VISION_ENABLED                on/off for the vision worker (default true)
#   VISION_SOURCE                 webcam | esp32 | auto      (default webcam)
#   VISION_CAMERA_INDEX           laptop camera index         (default 0)
#   VISION_CAMERA_WIDTH/HEIGHT    requested capture size      (default 640x480)
#   VISION_CAMERA_FPS             requested capture fps       (default 30)
#   VISION_CAMERA_BACKEND         auto | dshow | msmf | any | v4l2
#   VISION_MODEL_PATH             weights path or name        (default yolov8n.pt)
#   VISION_CONFIDENCE             detection threshold 0..1    (default 0.4)
#   VISION_IOU                    NMS IoU threshold 0..1      (default 0.5)
#   VISION_IMGSZ                  inference size              (default 640)
#   VISION_DEVICE                 cpu | cuda | auto           (default cpu)
#   VISION_MAX_DETECTIONS         detections kept per frame   (default 25)
#   VISION_TRACKING               keep object ids across frames (default false)
#   VISION_TRACKER                tracker config              (default bytetrack.yaml)
#   VISION_ALLOW_MODEL_DOWNLOAD   allow fetching weights      (default true)
#   VISION_TARGET_FPS             worker inference rate       (default 8)
#   VISION_JPEG_QUALITY           streamed frame quality      (default 75)
#   VISION_CAPTURE_FRAMES         keep the latest JPEG        (default true)
# =========================================================

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------
# DEFAULTS
# ---------------------------------------------------------

DEFAULT_MODEL_NAME = "yolov8n.pt"          # nano: the laptop-CPU default
DEFAULT_TRACKER = "bytetrack.yaml"         # Ultralytics ships this config
CONFIG_FILE = Path(__file__).resolve().parent / "config" / "ml_config.json"

VALID_SOURCES = ("webcam", "esp32", "auto")
VALID_BACKENDS = ("auto", "dshow", "msmf", "any", "v4l2")

# Which OpenCV capture constant each named backend maps to.
BACKEND_CONSTANTS = {
    "dshow": "CAP_DSHOW",
    "msmf": "CAP_MSMF",
    "any": "CAP_ANY",
    "v4l2": "CAP_V4L2",
}


class VisionConfigError(ValueError):
    """Raised when a camera/model setting is invalid (not silently accepted)."""


def _as_bool(value: Any, default: bool = False) -> bool:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _as_int(name: str, value: Any, default: int) -> int:
    if value is None or value == "":
        return default
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        raise VisionConfigError(f"{name} must be a whole number, got {value!r}") from None


def _as_float(name: str, value: Any, default: float) -> float:
    if value is None or value == "":
        return default
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        raise VisionConfigError(f"{name} must be a number, got {value!r}") from None


def _as_str(value: Any, default: str) -> str:
    if value is None:
        return default
    return str(value).strip()


# ---------------------------------------------------------
# CAMERA
# ---------------------------------------------------------

@dataclass(frozen=True)
class CameraSettings:
    """Where frames come from and how the capture device is opened."""

    source: str = "webcam"          # webcam | esp32 | auto
    index: int = 0                  # laptop camera index
    width: int = 640
    height: int = 480
    fps: int = 30
    backend: str = "auto"           # auto | dshow | msmf | any | v4l2
    warmup_frames: int = 2          # frames discarded after opening
    reopen_after_failures: int = 15 # consecutive read failures before reopening

    def __post_init__(self) -> None:
        if self.source not in VALID_SOURCES:
            raise VisionConfigError(
                f"camera source must be one of {', '.join(VALID_SOURCES)}, got {self.source!r}"
            )
        if self.index < 0:
            raise VisionConfigError(f"camera index must be 0 or greater, got {self.index}")
        if self.width <= 0 or self.height <= 0:
            raise VisionConfigError(
                f"frame size must be positive, got {self.width}x{self.height}"
            )
        if self.fps <= 0:
            raise VisionConfigError(f"camera fps must be positive, got {self.fps}")
        if self.reopen_after_failures < 1:
            raise VisionConfigError("reopen_after_failures must be at least 1")
        if self.warmup_frames < 0:
            raise VisionConfigError(f"warmup_frames must not be negative, got {self.warmup_frames}")

        backend = (self.backend or "auto").lower()

        if backend not in VALID_BACKENDS:
            raise VisionConfigError(
                f"unknown camera backend {self.backend!r} "
                f"(use {', '.join(VALID_BACKENDS)})"
            )

    def with_overrides(self, **kwargs: Any) -> "CameraSettings":
        """A copy with the named fields replaced (settings are immutable)."""

        return replace(self, **kwargs)

    def backend_candidates(self) -> List[Tuple[str, int]]:
        """OpenCV backends to try, in order.

        On Windows DirectShow is the most reliable for laptop cameras, then
        Media Foundation, then whatever OpenCV prefers. On other platforms the
        default backend is used unless one was named explicitly.
        """

        wanted = (self.backend or "auto").lower()
        cv2 = _cv2_module()

        if wanted != "auto":
            constant = BACKEND_CONSTANTS[wanted]
            return [(wanted, getattr(cv2, constant, 0))]

        if os.name == "nt":
            return [
                (name, getattr(cv2, BACKEND_CONSTANTS[name], 0))
                for name in ("dshow", "msmf", "any")
            ]

        return [("any", getattr(cv2, "CAP_ANY", 0))]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "source": self.source,
            "index": self.index,
            "width": self.width,
            "height": self.height,
            "fps": self.fps,
            "backend": self.backend,
            "reopen_after_failures": self.reopen_after_failures,
        }


def _cv2_module():
    """Import OpenCV lazily so importing this module never requires it."""

    import cv2

    return cv2


# ---------------------------------------------------------
# MODEL
# ---------------------------------------------------------

@dataclass(frozen=True)
class ModelSettings:
    """Object-detection model, thresholds and execution device."""

    path: str = DEFAULT_MODEL_NAME
    confidence: float = 0.4
    iou: float = 0.5
    imgsz: int = 640
    device: str = "cpu"             # cpu | cuda | cuda:0 | auto
    max_detections: int = 25
    tracking: bool = False
    tracker: str = DEFAULT_TRACKER
    allow_download: bool = True     # only fetch weights when they are missing
    warmup: bool = True             # one blank inference after loading

    def __post_init__(self) -> None:
        if not self.path:
            raise VisionConfigError("model path must not be empty")
        if not 0.0 <= self.confidence <= 1.0:
            raise VisionConfigError(
                f"confidence must be between 0 and 1, got {self.confidence}"
            )
        if not 0.0 <= self.iou <= 1.0:
            raise VisionConfigError(f"iou must be between 0 and 1, got {self.iou}")
        if self.imgsz < 32:
            raise VisionConfigError(f"imgsz must be at least 32, got {self.imgsz}")
        if self.max_detections < 1:
            raise VisionConfigError(
                f"max_detections must be at least 1, got {self.max_detections}"
            )
        if self.tracking and not self.tracker:
            raise VisionConfigError("tracking is enabled but no tracker was configured")

    @property
    def is_weights_file(self) -> bool:
        """True when `path` points at a file on disk rather than a model name."""

        return any(sep in self.path for sep in ("/", "\\")) or self.path.endswith(".pt")

    def resolve_device(self) -> str:
        """`cpu` unless CUDA was asked for and is actually available."""

        wanted = (self.device or "cpu").strip().lower()

        if wanted in ("", "cpu"):
            return "cpu"

        if wanted == "auto":
            return "cuda:0" if _cuda_available() else "cpu"

        if wanted.startswith("cuda") and not _cuda_available():
            return "cpu"

        return wanted

    def with_overrides(self, **kwargs: Any) -> "ModelSettings":
        """A copy with the named fields replaced (settings are immutable)."""

        return replace(self, **kwargs)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "path": self.path,
            "confidence": self.confidence,
            "iou": self.iou,
            "imgsz": self.imgsz,
            "device": self.device,
            "resolved_device": self.resolve_device(),
            "max_detections": self.max_detections,
            "tracking": self.tracking,
            "tracker": self.tracker,
            "allow_download": self.allow_download,
        }


def _cuda_available() -> bool:
    try:
        import torch  # noqa: PLC0415 - optional dependency

        return bool(torch.cuda.is_available())
    except Exception:
        return False


# ---------------------------------------------------------
# WORKER
# ---------------------------------------------------------

@dataclass(frozen=True)
class WorkerSettings:
    """How often the background worker infers and what it keeps for clients."""

    target_fps: float = 8.0
    jpeg_quality: int = 75
    capture_frames: bool = True
    idle_sleep: float = 0.005
    max_frame_age_seconds: float = 5.0    # a frame older than this is not served

    def __post_init__(self) -> None:
        if not 0.1 <= self.target_fps <= 120:
            raise VisionConfigError(
                f"target_fps must be between 0.1 and 120, got {self.target_fps}"
            )
        if not 1 <= self.jpeg_quality <= 100:
            raise VisionConfigError(
                f"jpeg_quality must be between 1 and 100, got {self.jpeg_quality}"
            )
        if self.max_frame_age_seconds <= 0:
            raise VisionConfigError(
                f"max_frame_age_seconds must be positive, got {self.max_frame_age_seconds}"
            )

    def with_overrides(self, **kwargs: Any) -> "WorkerSettings":
        """A copy with the named fields replaced (settings are immutable)."""

        return replace(self, **kwargs)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "target_fps": self.target_fps,
            "jpeg_quality": self.jpeg_quality,
            "capture_frames": self.capture_frames,
            "max_frame_age_seconds": self.max_frame_age_seconds,
        }


@dataclass(frozen=True)
class VisionSettings:
    """Everything the vision pipeline needs, in one immutable object."""

    enabled: bool = True
    camera: CameraSettings = field(default_factory=CameraSettings)
    model: ModelSettings = field(default_factory=ModelSettings)
    worker: WorkerSettings = field(default_factory=WorkerSettings)

    def with_overrides(self, **kwargs: Any) -> "VisionSettings":
        return replace(self, **kwargs)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "enabled": self.enabled,
            "camera": self.camera.to_dict(),
            "model": self.model.to_dict(),
            "worker": self.worker.to_dict(),
        }


# ---------------------------------------------------------
# LOADING
# ---------------------------------------------------------

def load_config_file(path: Optional[Path] = None) -> Dict[str, Any]:
    """Read ml_config.json if it exists; a malformed file is reported, not ignored."""

    path = Path(path) if path else CONFIG_FILE

    if not path.is_file():
        return {}

    try:
        data = json.loads(path.read_text(encoding="utf-8") or "{}")
    except json.JSONDecodeError as error:
        raise VisionConfigError(f"{path} is not valid JSON: {error}") from None

    if not isinstance(data, dict):
        raise VisionConfigError(f"{path} must contain a JSON object")

    return data


def load_settings(
    env: Optional[Dict[str, str]] = None,
    config: Optional[Dict[str, Any]] = None,
    config_path: Optional[Path] = None,
) -> VisionSettings:
    """Build settings from defaults, ml_config.json and the environment.

    `env` and `config` are injectable so tests never depend on the machine.
    """

    if config is None:
        file_data = load_config_file(config_path)
    else:
        file_data = config

    getenv = (lambda name, default=None: env.get(name, default)) if env is not None else os.getenv

    camera_file = dict(file_data.get("camera") or {})
    model_file = dict(file_data.get("model") or {})
    worker_file = dict(file_data.get("worker") or {})

    camera = CameraSettings(
        source=_as_str(getenv("VISION_SOURCE", camera_file.get("source")), "webcam").lower(),
        index=_as_int("VISION_CAMERA_INDEX", getenv("VISION_CAMERA_INDEX", camera_file.get("index")), 0),
        width=_as_int("VISION_CAMERA_WIDTH", getenv("VISION_CAMERA_WIDTH", camera_file.get("width")), 640),
        height=_as_int("VISION_CAMERA_HEIGHT", getenv("VISION_CAMERA_HEIGHT", camera_file.get("height")), 480),
        fps=_as_int("VISION_CAMERA_FPS", getenv("VISION_CAMERA_FPS", camera_file.get("fps")), 30),
        backend=_as_str(
            getenv("VISION_CAMERA_BACKEND", camera_file.get("backend")), "auto"
        ).lower(),
        warmup_frames=_as_int(
            "VISION_CAMERA_WARMUP_FRAMES",
            getenv("VISION_CAMERA_WARMUP_FRAMES", camera_file.get("warmup_frames")),
            2,
        ),
        reopen_after_failures=_as_int(
            "VISION_CAMERA_REOPEN_AFTER_FAILURES",
            getenv(
                "VISION_CAMERA_REOPEN_AFTER_FAILURES", camera_file.get("reopen_after_failures")
            ),
            15,
        ),
    )

    model = ModelSettings(
        path=_as_str(
            getenv("VISION_MODEL_PATH", model_file.get("path")), DEFAULT_MODEL_NAME
        ),
        confidence=_as_float(
            "VISION_CONFIDENCE", getenv("VISION_CONFIDENCE", model_file.get("confidence")), 0.4
        ),
        iou=_as_float("VISION_IOU", getenv("VISION_IOU", model_file.get("iou")), 0.5),
        imgsz=_as_int("VISION_IMGSZ", getenv("VISION_IMGSZ", model_file.get("imgsz")), 640),
        device=_as_str(getenv("VISION_DEVICE", model_file.get("device")), "cpu"),
        max_detections=_as_int(
            "VISION_MAX_DETECTIONS",
            getenv("VISION_MAX_DETECTIONS", model_file.get("max_detections")),
            25,
        ),
        tracking=_as_bool(
            getenv("VISION_TRACKING", model_file.get("tracking")), False
        ),
        tracker=_as_str(
            getenv("VISION_TRACKER", model_file.get("tracker")), DEFAULT_TRACKER
        ),
        allow_download=_as_bool(
            getenv("VISION_ALLOW_MODEL_DOWNLOAD", model_file.get("allow_download")), True
        ),
        warmup=_as_bool(getenv("VISION_WARMUP", model_file.get("warmup")), True),
    )

    worker = WorkerSettings(
        target_fps=_as_float(
            "VISION_TARGET_FPS", getenv("VISION_TARGET_FPS", worker_file.get("target_fps")), 8.0
        ),
        jpeg_quality=_as_int(
            "VISION_JPEG_QUALITY",
            getenv("VISION_JPEG_QUALITY", worker_file.get("jpeg_quality")),
            75,
        ),
        capture_frames=_as_bool(
            getenv("VISION_CAPTURE_FRAMES", worker_file.get("capture_frames")), True
        ),
        max_frame_age_seconds=_as_float(
            "VISION_MAX_FRAME_AGE_SECONDS",
            getenv("VISION_MAX_FRAME_AGE_SECONDS", worker_file.get("max_frame_age_seconds")),
            5.0,
        ),
    )

    return VisionSettings(
        enabled=_as_bool(getenv("VISION_ENABLED", file_data.get("enabled")), True),
        camera=camera,
        model=model,
        worker=worker,
    )
