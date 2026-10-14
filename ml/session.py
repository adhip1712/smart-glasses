# =========================================================
# VISIONARY NEXUS - VISION SESSION
# =========================================================
#
# One managed capture + inference worker, shared by the standalone demo and the
# FastAPI integration so neither re-implements the other.
#
#   session = VisionSession(settings)
#   session.start()      # idempotent - a second call does not start a 2nd thread
#   session.latest()     # last detections, never blocks
#   session.status()     # camera + model + worker health
#   session.stop()       # idempotent, always releases the camera
#
# Inference runs on a worker thread, so a caller (or FastAPI's event loop) never
# waits on a model. There is exactly one worker per session, and it is joined on
# shutdown; the camera is released even if inference raises.
# =========================================================

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from .config import VisionSettings, load_settings
from .detector import InferenceResult, ModelUnavailableError, YoloDetector
from .webcam_source import FrameReadError, FrameSource, SourceUnavailableError, open_frame_source

try:
    import numpy as np
except Exception:  # pragma: no cover - numpy ships with the ML extras
    np = None  # type: ignore


@dataclass
class VisionSnapshot:
    """What the last worker iteration produced, safe to hand to any client."""

    running: bool = False
    started_at: float = 0.0
    frames: int = 0
    inference_count: int = 0
    last_error: str = ""
    camera_error: str = ""
    model_error: str = ""
    result: Optional[InferenceResult] = None
    frame_age_seconds: float = 0.0
    fps: float = 0.0

    @property
    def fresh(self) -> bool:
        return self.result is not None and self.frame_age_seconds < 10.0

    def to_dict(self) -> Dict[str, Any]:
        result = self.result

        return {
            "running": self.running,
            "frames": self.frames,
            "inference_count": self.inference_count,
            "fps": self.fps,
            "frame_age_seconds": round(self.frame_age_seconds, 3),
            "last_error": self.last_error,
            "camera_error": self.camera_error,
            "model_error": self.model_error,
            "detections": result.to_dict() if result else None,
        }


@dataclass
class WorkerState:
    """Mutable state guarded by the session lock."""

    thread: Optional[threading.Thread] = None
    stop_event: threading.Event = field(default_factory=threading.Event)
    frames: int = 0
    inference_count: int = 0
    last_error: str = ""
    camera_error: str = ""
    model_error: str = ""
    result: Optional[InferenceResult] = None
    result_at: float = 0.0
    started_at: float = 0.0
    frame_times: List[float] = field(default_factory=list)
    jpeg: Optional[bytes] = None
    jpeg_at: float = 0.0


class VisionSession:
    """Owns the camera source, the detector and the single worker thread."""

    def __init__(
        self,
        settings: Optional[VisionSettings] = None,
        source_factory: Optional[Callable[..., FrameSource]] = None,
        detector_factory: Optional[Callable[..., YoloDetector]] = None,
    ) -> None:
        self.settings = settings or load_settings()
        self._source_factory = source_factory or open_frame_source
        self._detector_factory = detector_factory or (lambda: YoloDetector(self.settings.model))
        self._detector = self._detector_factory()
        self._source: Optional[FrameSource] = None
        self._state = WorkerState()
        # Guards brief state access only. Never held across a camera open, a
        # model load or an inference - see start().
        self._lock = threading.RLock()
        # Serialises start()/stop() against each other.
        self._lifecycle_lock = threading.Lock()
        self._device_lookup: Optional[Callable[[], Optional[Dict[str, Any]]]] = None

    # -- wiring --------------------------------------------------------

    def set_device_lookup(self, lookup: Callable[[], Optional[Dict[str, Any]]]) -> None:
        """Let an ESP32 camera source learn its address from the device registry."""

        self._device_lookup = lookup

    @property
    def detector(self) -> YoloDetector:
        return self._detector

    @property
    def source(self) -> Optional[FrameSource]:
        return self._source

    @property
    def is_running(self) -> bool:
        thread = self._state.thread
        return thread is not None and thread.is_alive()

    @property
    def stop_requested(self) -> bool:
        """True once stop() has been asked for (public, for demo loops)."""

        return self._state.stop_event.is_set()

    # -- lifecycle -----------------------------------------------------

    def start(self) -> Dict[str, Any]:
        """Start the worker. Safe against duplicate and concurrent calls.

        The camera is opened on the calling thread so a missing camera is
        reported to the caller instead of appearing only in a background log.

        Two locks, on purpose:

          * `_lifecycle_lock` serialises start/stop against each other, so two
            threads cannot both open the camera or both spawn a worker.
          * `_lock` guards only the short state reads/writes.

        The state lock is deliberately NOT held while the camera opens or the
        model loads: those take seconds, and holding it would block
        latest()/status() - i.e. /api/vision/status - for the whole load.
        """

        with self._lifecycle_lock:
            if not self.settings.enabled:
                return {"started": False, "already_running": False,
                        "error": "vision is disabled (VISION_ENABLED=false)"}

            with self._lock:
                if self.is_running:
                    return {"started": True, "already_running": True}

            # Slow work happens outside the state lock.
            # Fail loudly and early: no camera -> no thread.
            try:
                self._open_source()
            except SourceUnavailableError as error:
                with self._lock:
                    self._state.camera_error = str(error)
                    self._state.last_error = str(error)
                raise

            try:
                self._detector.load()
            except ModelUnavailableError as error:
                # The camera works but the model does not: keep the session
                # stopped rather than streaming frames with no detections.
                with self._lock:
                    self._state.model_error = str(error)
                    self._state.last_error = str(error)
                self._release_source()
                raise

            with self._lock:
                self._state.model_error = ""
                self._state.stop_event = threading.Event()
                self._state.frames = 0
                self._state.inference_count = 0
                self._state.last_error = ""
                self._state.camera_error = ""
                self._state.started_at = time.monotonic()
                self._state.frame_times = []

            self._detector.reset_tracking()

            thread = threading.Thread(
                target=self._run, name="visionary-nexus-vision", daemon=True
            )

            with self._lock:
                self._state.thread = thread

            thread.start()

        return {"started": True, "already_running": False}

    def _open_source(self) -> None:
        if self._source is not None:
            return

        kwargs: Dict[str, Any] = {}

        if self._device_lookup is not None:
            kwargs["device_lookup"] = self._device_lookup

        source = self._source_factory(self.settings, **kwargs)

        # open_frame_source() opens the source itself, but a caller-supplied
        # factory may not. Opening an already-open source is a no-op, so this
        # makes the contract explicit instead of relying on the factory.
        if not getattr(source, "is_open", False):
            source.open()

        self._source = source

    def _release_source(self) -> None:
        if self._source is None:
            return

        try:
            self._source.close()
        except Exception:
            pass
        finally:
            self._source = None

    def stop(self, timeout: float = 5.0) -> Dict[str, Any]:
        """Stop the worker and release the camera. Safe to call twice.

        Uses the lifecycle lock, so it cannot interleave with start(); the state
        lock is still released before joining the worker, because the worker
        takes it on every iteration.
        """

        with self._lifecycle_lock:
            return self._stop_locked(timeout)

    def _stop_locked(self, timeout: float) -> Dict[str, Any]:
        with self._lock:
            thread = self._state.thread

            if thread is None:
                return {"stopped": True, "was_running": False}

            was_running = thread.is_alive()
            self._state.stop_event.set()

        # Join outside the lock: the worker takes the same lock each iteration.
        if thread.is_alive():
            thread.join(timeout=timeout)

        with self._lock:
            still_alive = thread.is_alive()
            self._state.thread = None

            if still_alive:
                # Never block shutdown on a stuck thread; report it instead.
                self._state.last_error = (
                    "the vision worker did not exit within "
                    f"{timeout:.1f}s; the camera may still be held"
                )
                return {"stopped": False, "was_running": was_running,
                        "error": self._state.last_error}

            self._release_source()
            self._detector.reset_tracking()

        return {"stopped": True, "was_running": was_running}

    def close(self) -> None:
        """Shut everything down (used by FastAPI's shutdown handler)."""

        try:
            self.stop()
        except Exception:
            pass

        self._detector.close()

    # -- worker --------------------------------------------------------

    def _run(self) -> None:
        period = 1.0 / max(self.settings.worker.target_fps, 0.1)
        consecutive_failures = 0

        while not self._state.stop_event.is_set():
            started = time.monotonic()

            try:
                frame = self._read_frame()
            except (FrameReadError, SourceUnavailableError) as error:
                consecutive_failures += 1
                self._record_error(camera=str(error))

                if consecutive_failures >= self.settings.camera.reopen_after_failures:
                    self._try_reopen()
                    consecutive_failures = 0

                self._sleep(period)
                continue

            self._state.frames += 1

            try:
                result = self._detector.process(frame)
                consecutive_failures = 0
            except (ModelUnavailableError, ValueError) as error:
                self._record_error(model=str(error))
                self._sleep(period)
                continue
            except Exception as error:  # never let one bad frame kill the worker
                self._record_error(model=f"{type(error).__name__}: {error}")
                self._sleep(period)
                continue

            with self._lock:
                self._state.result = result
                self._state.result_at = time.monotonic()
                self._state.inference_count += 1
                self._state.last_error = ""
                self._state.frame_times.append(self._state.result_at)

                if len(self._state.frame_times) > 30:
                    del self._state.frame_times[:-30]

                if self.settings.worker.capture_frames:
                    self._encode_jpeg(frame, result)

            self._sleep(period - (time.monotonic() - started))

        self._release_source()

    def _read_frame(self) -> Any:
        if self._source is None:
            raise FrameReadError("the camera source was released")

        return self._source.read()

    def _try_reopen(self) -> None:
        """Reopen the camera after repeated read failures (unplug/replug)."""

        with self._lock:
            self._release_source()

            try:
                self._open_source()
                self._state.camera_error = ""
            except Exception as error:
                self._state.camera_error = f"reopening the camera failed: {error}"

    def _encode_jpeg(self, frame: Any, result: InferenceResult) -> None:
        """Keep the latest annotated JPEG for streaming clients."""

        if np is None:
            return

        try:
            from .overlay import annotate_frame, encode_jpeg

            annotated = annotate_frame(frame, result)
            self._state.jpeg = encode_jpeg(annotated, self.settings.worker.jpeg_quality)
            self._state.jpeg_at = time.monotonic()
        except Exception as error:
            # An overlay failure must not stop detection.
            self._state.last_error = f"could not encode the preview frame: {error}"

    def _record_error(self, camera: str = "", model: str = "") -> None:
        with self._lock:
            if camera:
                self._state.camera_error = camera
            if model:
                self._state.model_error = model
            self._state.last_error = camera or model or self._state.last_error

    @staticmethod
    def _sleep(seconds: float) -> None:
        if seconds > 0:
            time.sleep(seconds)

    # -- reporting -----------------------------------------------------

    def latest(self, max_age_seconds: Optional[float] = None) -> Dict[str, Any]:
        """The most recent detections. Never waits for the worker."""

        limit = (
            self.settings.worker.max_frame_age_seconds
            if max_age_seconds is None
            else max_age_seconds
        )

        with self._lock:
            state = self._state
            age = (time.monotonic() - state.result_at) if state.result_at else 0.0

            snapshot = VisionSnapshot(
                running=self.is_running,
                started_at=state.started_at,
                frames=state.frames,
                inference_count=state.inference_count,
                last_error=state.last_error,
                camera_error=state.camera_error,
                model_error=state.model_error,
                result=state.result,
                frame_age_seconds=age,
                fps=self._fps(state.frame_times),
            )

        payload = snapshot.to_dict()
        payload["stale"] = not snapshot.fresh or age > limit
        return payload

    def latest_jpeg(self, max_age_seconds: Optional[float] = None) -> Optional[bytes]:
        """The latest annotated JPEG, or None when nothing recent exists."""

        limit = (
            self.settings.worker.max_frame_age_seconds
            if max_age_seconds is None
            else max_age_seconds
        )

        with self._lock:
            jpeg = self._state.jpeg
            age = (time.monotonic() - self._state.jpeg_at) if self._state.jpeg_at else None

        if jpeg is None or age is None or age > limit:
            return None

        return jpeg

    @staticmethod
    def _fps(times: List[float]) -> float:
        if len(times) < 2:
            return 0.0

        span = times[-1] - times[0]

        return round((len(times) - 1) / span, 2) if span > 0 else 0.0

    def status(self) -> Dict[str, Any]:
        """Camera, model and worker health in one payload."""

        camera = (
            self._source.describe()
            if self._source is not None
            else {
                "type": self.settings.camera.source,
                "is_open": False,
                "index": self.settings.camera.index,
            }
        )

        model = self._detector.describe()
        snapshot = self.latest()

        errors = [
            value
            for value in (snapshot["camera_error"], snapshot["model_error"])
            if value
        ]

        return {
            "running": self.is_running,
            "enabled": self.settings.enabled,
            "healthy": self.is_running and not errors and snapshot["detections"] is not None,
            "camera": camera,
            "camera_available": bool(camera.get("is_open")),
            "model": model,
            "model_available": bool(model.get("available")),
            "model_loaded": bool(model.get("loaded")),
            "tracking": bool(self.settings.model.tracking),
            "frames": snapshot["frames"],
            "fps": snapshot["fps"],
            "inference_ms": model.get("last_inference_ms", 0.0),
            "errors": errors,
            "source": self.settings.camera.source,
            "configured": {
                "camera": self.settings.camera.to_dict(),
                "model": {
                    key: value
                    for key, value in self.settings.model.to_dict().items()
                    if key != "path" or True
                },
                "worker": self.settings.worker.to_dict(),
            },
        }
