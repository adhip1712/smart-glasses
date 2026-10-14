# =========================================================
# VISIONARY NEXUS - CAMERA SOURCES
# =========================================================
#
# Frame acquisition only. The detector never touches OpenCV's camera API: it
# receives frames from anything that satisfies `FrameSource`, which is what
# keeps a laptop webcam replaceable by other hardware later:
#
#   WebcamSource        the laptop camera through OpenCV   (implemented, usable)
#   Esp32CameraSource   an ESP32-CAM / ESP32-S3 Sense HTTP stream, reusing the
#                       camera/ package that already serves /stream and
#                       /capture  (implemented; the HTTP path is covered by
#                       tests/test_camera.py, the S3 Sense board itself has NOT
#                       been tested - see ml/README.md)
#
# Both raise honest errors: `SourceUnavailableError` when a camera cannot be
# opened at all, `FrameReadError` when a frame could not be read. Neither needs
# a camera to be importable, and `close()` is always safe to call.
# =========================================================

from __future__ import annotations

import threading
import time
from typing import Any, Callable, Dict, List, Optional, Protocol, Sequence, Tuple, runtime_checkable

from .config import CameraSettings, VisionConfigError, VisionSettings

try:  # numpy is already required by OpenCV / Ultralytics
    import numpy as np
except Exception:  # pragma: no cover - numpy ships with the ML extras
    np = None  # type: ignore


class SourceUnavailableError(RuntimeError):
    """The camera could not be opened (missing hardware, permissions, in use)."""


class FrameReadError(RuntimeError):
    """The camera is open but did not deliver a usable frame."""


@runtime_checkable
class FrameSource(Protocol):
    """Anything that can hand frames to the detector."""

    def open(self) -> None:  # pragma: no cover - protocol
        ...

    def read(self) -> Any:  # pragma: no cover - protocol
        ...

    def close(self) -> None:  # pragma: no cover - protocol
        ...

    @property
    def is_open(self) -> bool:  # pragma: no cover - protocol
        ...

    def describe(self) -> Dict[str, Any]:  # pragma: no cover - protocol
        ...


def _cv2():
    import cv2

    return cv2


def _required_numpy():
    if np is None:
        raise SourceUnavailableError(
            "numpy is not installed; frames cannot be handled (pip install numpy)"
        )
    return np


# ---------------------------------------------------------
# LAPTOP WEBCAM
# ---------------------------------------------------------

class WebcamSource:
    """The laptop camera, opened through OpenCV with backend fallback.

    Windows laptop cameras are unreliable through a single backend, so each
    configured backend is tried in order (DirectShow, then Media Foundation,
    then the platform default) and the first one that opens *and* delivers a
    frame wins. Every failure is collected into one readable message instead of
    a generic "camera not found".
    """

    def __init__(
        self,
        settings: Optional[CameraSettings] = None,
        capture_factory: Optional[Callable[[int, int], Any]] = None,
    ) -> None:
        self.settings = settings or CameraSettings()
        self._capture_factory = capture_factory or self._open_capture
        self._capture: Any = None
        self._backend: str = ""
        self._resolution: Tuple[int, int] = (0, 0)
        self._failures = 0
        self._frame_times: List[float] = []
        self._lock = threading.Lock()

    # -- lifecycle -----------------------------------------------------

    @property
    def is_open(self) -> bool:
        return self._capture is not None

    def open(self) -> None:
        """Open the camera, trying each backend in order.

        Raises SourceUnavailableError listing every attempt when none works.
        """

        with self._lock:
            if self._capture is not None:
                return

            attempts: List[str] = []

            for name, flag in self.settings.backend_candidates():
                capture = None

                try:
                    capture = self._capture_factory(self.settings.index, flag)
                except Exception as error:  # backend raised (driver level)
                    attempts.append(f"{name}: {type(error).__name__}: {error}")
                    continue

                if capture is None or not _safe_is_opened(capture):
                    _safe_release(capture)
                    attempts.append(f"{name}: could not be opened")
                    continue

                self._apply_properties(capture)

                frame = self._warm_up(capture)

                if frame is None:
                    _safe_release(capture)
                    attempts.append(f"{name}: opened but returned no frames")
                    continue

                self._capture = capture
                self._backend = name
                self._failures = 0
                self._resolution = _frame_size(frame)
                return

            raise SourceUnavailableError(
                self._unavailable_message(attempts)
            )

    def _unavailable_message(self, attempts: Sequence[str]) -> str:
        tried = "; ".join(attempts) or "no backends available"

        hint = (
            f"camera index {self.settings.index} could not be opened ({tried}). "
            "Check that a camera is connected, that no other application is using it, "
            "and on Windows that Settings > Privacy > Camera allows desktop apps."
        )

        if self.settings.index == 0:
            hint += " If the laptop has several cameras, try VISION_CAMERA_INDEX=1."

        return hint

    def _open_capture(self, index: int, flag: int) -> Any:
        cv2 = _cv2()
        return cv2.VideoCapture(index, flag)

    def _apply_properties(self, capture: Any) -> None:
        cv2 = _cv2()

        for prop, value in (
            (cv2.CAP_PROP_FRAME_WIDTH, float(self.settings.width)),
            (cv2.CAP_PROP_FRAME_HEIGHT, float(self.settings.height)),
            (cv2.CAP_PROP_FPS, float(self.settings.fps)),
            (cv2.CAP_PROP_BUFFERSIZE, 1.0),   # always hand over the newest frame
        ):
            try:
                capture.set(prop, value)
            except Exception:
                # Some drivers reject a property; the capture still works.
                continue

    def _warm_up(self, capture: Any) -> Any:
        """Discard a few frames - laptop cameras deliver dark/stale first frames."""

        frame = None

        for _ in range(max(self.settings.warmup_frames, 1)):
            try:
                ok, candidate = capture.read()
            except Exception:
                return None

            if ok and candidate is not None and getattr(candidate, "size", 0):
                frame = candidate

        return frame

    def read(self) -> Any:
        """Return one BGR frame, reopening the camera after repeated failures."""

        with self._lock:
            if self._capture is None:
                raise FrameReadError("the camera is not open")

            try:
                ok, frame = self._capture.read()
            except Exception as error:
                self._register_failure()
                raise FrameReadError(f"the camera raised while reading: {error}") from None

            if not ok or frame is None or getattr(frame, "size", 0) == 0:
                self._register_failure()
                raise FrameReadError(
                    f"the camera returned no frame ({self._failures} in a row)"
                )

            self._failures = 0
            self._resolution = _frame_size(frame)
            self._frame_times.append(time.monotonic())

            if len(self._frame_times) > 60:
                del self._frame_times[:-60]

            return frame

    def _register_failure(self) -> None:
        self._failures += 1

        if self._failures >= self.settings.reopen_after_failures:
            # Driver hiccup or the device was unplugged: start a fresh handle.
            self._release_locked()
            self._failures = 0

    def close(self) -> None:
        """Release the camera. Safe to call more than once."""

        with self._lock:
            self._release_locked()

    def _release_locked(self) -> None:
        if self._capture is not None:
            _safe_release(self._capture)
            self._capture = None

    def __enter__(self) -> "WebcamSource":
        self.open()
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()

    # -- reporting -----------------------------------------------------

    @property
    def measured_fps(self) -> float:
        if len(self._frame_times) < 2:
            return 0.0

        span = self._frame_times[-1] - self._frame_times[0]

        return round((len(self._frame_times) - 1) / span, 2) if span > 0 else 0.0

    def describe(self) -> Dict[str, Any]:
        width, height = self._resolution

        return {
            "type": "webcam",
            "is_open": self.is_open,
            "index": self.settings.index,
            "backend": self._backend or self.settings.backend,
            "requested": {
                "width": self.settings.width,
                "height": self.settings.height,
                "fps": self.settings.fps,
            },
            "width": width,
            "height": height,
            "resolution": f"{width}x{height}" if width and height else "unknown",
            "measured_fps": self.measured_fps,
            "consecutive_failures": self._failures,
        }


def _safe_is_opened(capture: Any) -> bool:
    try:
        return bool(capture.isOpened())
    except Exception:
        return False


def _safe_release(capture: Any) -> None:
    if capture is None:
        return

    try:
        capture.release()
    except Exception:
        pass


def _frame_size(frame: Any) -> Tuple[int, int]:
    shape = getattr(frame, "shape", None)

    if not shape or len(shape) < 2:
        return (0, 0)

    return (int(shape[1]), int(shape[0]))


def list_available_cameras(
    max_index: int = 5,
    capture_factory: Optional[Callable[[int, int], Any]] = None,
) -> List[Dict[str, Any]]:
    """Probe camera indices and report which ones open (used by --list-cameras)."""

    found: List[Dict[str, Any]] = []
    cv2 = _cv2()
    factory = capture_factory or (lambda index, flag: cv2.VideoCapture(index, flag))

    for index in range(max(0, max_index) + 1):
        for name, flag in (
            ("dshow", getattr(cv2, "CAP_DSHOW", 0)),
            ("any", getattr(cv2, "CAP_ANY", 0)),
        ):
            capture = None

            try:
                capture = factory(index, flag)

                if capture is not None and _safe_is_opened(capture):
                    ok, frame = capture.read()

                    if ok and frame is not None and getattr(frame, "size", 0):
                        width, height = _frame_size(frame)
                        found.append(
                            {
                                "index": index,
                                "backend": name,
                                "resolution": f"{width}x{height}",
                            }
                        )
                        break
            except Exception:
                continue
            finally:
                _safe_release(capture)

    return found


# ---------------------------------------------------------
# ESP32-CAM / ESP32-S3 SENSE (HTTP)
# ---------------------------------------------------------

class Esp32CameraSource:
    """Frames from an ESP32 camera HTTP server, via the existing camera package.

    This is the seam for hardware sources: the detector only ever sees frames.
    The HTTP client behind it (`camera/`) is implemented and tested; a
    physical ESP32-S3 Sense board has not been tested with it.
    """

    def __init__(
        self,
        settings: Optional[CameraSettings] = None,
        camera_config: Any = None,
        device_lookup: Optional[Callable[[], Optional[Dict[str, Any]]]] = None,
        capture: Optional[Callable[..., Any]] = None,
    ) -> None:
        self.settings = settings or CameraSettings(source="esp32")
        self._camera_config = camera_config
        self._device_lookup = device_lookup
        self._capture_fn = capture
        self._opened = False
        self._resolution: Tuple[int, int] = (0, 0)
        self._last_url = ""

    def _config(self) -> Any:
        if self._camera_config is None:
            from camera.config import CameraConfig

            self._camera_config = CameraConfig.from_env()

        return self._camera_config

    def _capture(self) -> Any:
        if self._capture_fn is None:
            from camera.image_capture import capture_frame

            self._capture_fn = capture_frame

        return self._capture_fn

    def _device_ip(self) -> str:
        if self._device_lookup is None:
            return ""

        try:
            device = self._device_lookup() or {}
        except Exception:
            return ""

        return str(device.get("ip_address") or "")

    @property
    def is_open(self) -> bool:
        return self._opened

    def open(self) -> None:
        """Verify that an address is known; the HTTP call happens per frame."""

        config = self._config()
        stream_url, origin = config.resolve_stream_url(self._device_ip())
        snapshot_url, _ = config.resolve_snapshot_url(self._device_ip())

        if not stream_url and not snapshot_url:
            raise SourceUnavailableError(
                "no ESP32 camera address is configured "
                "(set ESP32_CAM_IP / ESP32_CAM_STREAM_URL or let the device heartbeat register it)"
            )

        self._last_url = stream_url or snapshot_url
        self._origin = origin
        self._opened = True

    def read(self) -> Any:
        if not self._opened:
            raise FrameReadError("the ESP32 camera source is not open")

        capture = self._capture()
        frame, error = capture(self._config(), device_ip=self._device_ip())

        if frame is None:
            raise FrameReadError(error or "the ESP32 camera did not return a frame")

        image = self._to_image(frame)

        if image is None:
            raise FrameReadError("the frame from the ESP32 camera could not be decoded")

        self._resolution = _frame_size(image)
        return image

    def _to_image(self, frame: Any) -> Any:
        decoded = getattr(frame, "image", None)

        if decoded is not None:
            return decoded

        jpeg = getattr(frame, "jpeg", None)

        if not jpeg:
            return None

        cv2 = _cv2()
        buffer = _required_numpy().frombuffer(jpeg, dtype="uint8")
        image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)

        return image

    def close(self) -> None:
        """Nothing to release: each frame is one short HTTP request."""

        self._opened = False

    def __enter__(self) -> "Esp32CameraSource":
        self.open()
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()

    def describe(self) -> Dict[str, Any]:
        width, height = self._resolution

        return {
            "type": "esp32-camera",
            "is_open": self._opened,
            "url": self._last_url,
            "url_origin": getattr(self, "_origin", ""),
            "width": width,
            "height": height,
            "resolution": f"{width}x{height}" if width and height else "unknown",
            "hardware_verified": False,
            "note": "the HTTP path is tested; the S3 Sense board has not been tested",
        }


# ---------------------------------------------------------
# FACTORY
# ---------------------------------------------------------

def open_frame_source(
    settings: VisionSettings,
    device_lookup: Optional[Callable[[], Optional[Dict[str, Any]]]] = None,
    camera_config: Any = None,
    capture: Optional[Callable[..., Any]] = None,
    **kwargs: Any,
) -> FrameSource:
    """Build the frame source named by `settings.camera.source`.

    webcam - the laptop camera
    esp32  - an ESP32 camera HTTP server (reuses the camera/ package)
    auto   - the laptop camera first, then the ESP32 camera

    `kwargs` are webcam-only (e.g. capture_factory for tests); the ESP32
    arguments are named explicitly so neither constructor receives the other's.
    """

    source = (settings.camera.source or "webcam").lower()

    def make_esp32() -> Esp32CameraSource:
        return Esp32CameraSource(
            settings.camera,
            camera_config=camera_config,
            device_lookup=device_lookup,
            capture=capture,
        )

    if source == "webcam":
        webcam = WebcamSource(settings.camera, **kwargs)
        webcam.open()
        return webcam

    if source == "esp32":
        esp32 = make_esp32()
        esp32.open()
        return esp32

    if source == "auto":
        try:
            webcam = WebcamSource(settings.camera, **kwargs)
            webcam.open()
            return webcam
        except SourceUnavailableError as webcam_error:
            try:
                esp32 = make_esp32()
                esp32.open()
                return esp32
            except SourceUnavailableError as esp32_error:
                raise SourceUnavailableError(
                    f"no camera source is available - webcam: {webcam_error}; "
                    f"esp32: {esp32_error}"
                ) from None

    raise VisionConfigError(
        f"unknown camera source {source!r} (use webcam, esp32 or auto)"
    )
