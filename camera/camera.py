# =========================================================
# VISIONARY NEXUS - CAMERA SERVICE
# =========================================================
#
# The single object the API talks to. It answers four questions:
#
#   status()      what is configured, what was seen last, is OpenCV here
#   health()      is the ESP32-CAM actually reachable right now (live probe)
#   snapshot()    the latest JPEG frame (live, or the last good one, marked
#                 stale, so a dropped Wi-Fi link never blanks the UI)
#   stream_info() the URLs, framings and measured rate for a stream player
#
# It never raises and never blocks on the network for longer than the
# configured timeout, so the backend runs normally with no board attached.
#
# The camera address can come from the device registry: backend/camera_api.py
# installs a lookup that returns the ip_address the board reported in its last
# heartbeat, which is what makes a new DHCP lease a non-event.
# =========================================================

import threading
import time
from collections import deque
from datetime import datetime, timezone
from typing import Callable, Optional, Tuple

from .config import CameraConfig
from .image_capture import CapturedFrame, capture_frame
from .image_processing import opencv_available, opencv_version
from .video_stream import host_port_from_url, probe_host

STREAM_CONTENT_TYPE = "multipart/x-mixed-replace; boundary=frame"
STREAM_BOUNDARY = "frame"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class CameraService:
    """Configuration + last-known state for one camera pipeline."""

    def __init__(
        self,
        config: Optional[CameraConfig] = None,
        device_lookup: Optional[Callable[[], Optional[dict]]] = None,
        opener: Optional[Callable] = None,
    ):
        self.config = config or CameraConfig.from_env()
        self._device_lookup = device_lookup
        self._opener = opener
        self._lock = threading.Lock()
        self._last_frame: Optional[CapturedFrame] = None
        self._last_frame_at: float = 0.0
        self._last_error: str = ""
        self._last_checked_at: Optional[str] = None
        self._reachable: Optional[bool] = None
        self._frames_captured = 0
        self._failures = 0
        self._capture_times: deque = deque(maxlen=20)

    # -----------------------------------------------------
    # WIRING
    # -----------------------------------------------------

    def configure(
        self,
        config: Optional[CameraConfig] = None,
        device_lookup: Optional[Callable[[], Optional[dict]]] = None,
        opener: Optional[Callable] = None,
    ) -> "CameraService":
        with self._lock:
            if config is not None:
                self.config = config
            if device_lookup is not None:
                self._device_lookup = device_lookup
            if opener is not None:
                self._opener = opener
        return self

    def _device(self) -> Optional[dict]:
        """Registry view of the board (never raises)."""

        if self._device_lookup is None:
            return None

        try:
            return self._device_lookup()
        except Exception:
            return None

    @staticmethod
    def _device_ip(device: Optional[dict]) -> str:
        if not device:
            return ""
        return str(device.get("ip_address") or "").strip()

    # -----------------------------------------------------
    # STATUS
    # -----------------------------------------------------

    def status(self, probe: bool = False) -> dict:
        device = self._device()
        device_ip = self._device_ip(device)
        stream_url, stream_origin = self.config.resolve_stream_url(device_ip)
        snapshot_url, _ = self.config.resolve_snapshot_url(device_ip)

        reachable = self._reachable
        errors = []

        if probe and stream_url:
            ok, latency_ms, error = probe_host(*host_port_from_url(stream_url), timeout=self.config.timeout)

            with self._lock:
                self._reachable = ok
                self._last_checked_at = _now_iso()
                if not ok and error:
                    self._last_error = error

            reachable = ok

            if not ok:
                errors.append(error)
        elif probe and not stream_url:
            errors.append("no ESP32-CAM address is configured (set ESP32_CAM_IP or ESP32_CAM_STREAM_URL)")

        with self._lock:
            last_frame = self._last_frame.to_dict() if self._last_frame else None
            last_frame_age = (
                round(time.monotonic() - self._last_frame_at, 1) if self._last_frame is not None else None
            )
            payload = {
                "ok": True,
                "service": "visionary-nexus-camera",
                "source": {
                    "configured": self.config.source,
                    "effective": self._effective_source(),
                    "webcam_opt_in": self.config.webcam_allowed,
                },
                "configured": self.config.usable,
                "stream_url": stream_url,
                "snapshot_url": snapshot_url,
                "url_origin": stream_origin,
                "port": self.config.port,
                "timeout_seconds": self.config.timeout,
                "reachable": reachable,
                "last_error": self._last_error,
                "last_checked_at": self._last_checked_at,
                "frames_captured": self._frames_captured,
                "failures": self._failures,
                "last_frame": last_frame,
                "last_frame_age_seconds": last_frame_age,
                "opencv": {"available": opencv_available(), "version": opencv_version()},
                "device": device,
                "timestamp": _now_iso(),
            }

        notes = []

        if stream_origin == "device-registry":
            notes.append("address learned from the device registry (last heartbeat) - DHCP safe")
        elif stream_origin == "configured-ip":
            notes.append("address comes from ESP32_CAM_IP in the environment")
        elif stream_origin == "env":
            notes.append("address comes from an explicit *_URL override")
        else:
            notes.append("no address configured yet - set ESP32_CAM_IP or wait for a device heartbeat")

        if not opencv_available():
            notes.append("OpenCV is not installed: frames are served but not decoded")

        if errors:
            notes.extend(errors)

        payload["notes"] = notes
        return payload

    def _effective_source(self) -> str:
        if self.config.source == "none":
            return "none"

        if self.config.source == "webcam":
            return "webcam"

        return "esp32"

    # -----------------------------------------------------
    # HEALTH
    # -----------------------------------------------------

    def health(self, probe: bool = True) -> dict:
        """Live reachability + one real frame when the board answers."""

        device = self._device()
        device_ip = self._device_ip(device)
        stream_url, origin = self.config.resolve_stream_url(device_ip)
        snapshot_url, _ = self.config.resolve_snapshot_url(device_ip)

        payload = {
            "ok": False,
            "service": "visionary-nexus-camera",
            "checked_url": stream_url or snapshot_url,
            "url_origin": origin,
            "reachable": False,
            "latency_ms": 0,
            "error": "",
            "device": device,
            "timestamp": _now_iso(),
        }

        if self.config.source == "none":
            payload["error"] = "the camera is disabled (CAMERA_SOURCE=none)"
            payload["disabled"] = True
            return payload

        if self.config.source == "webcam":
            frame, error = capture_frame(self.config, opener=self._opener)

            if frame is None:
                payload["error"] = error
                self._record_failure(error)
                return payload

            payload.update(self._health_from_frame(frame))
            return payload

        if not stream_url and not snapshot_url:
            payload["error"] = "no ESP32-CAM address is configured (set ESP32_CAM_IP or ESP32_CAM_STREAM_URL)"
            return payload

        if probe and stream_url:
            ok, latency_ms, error = probe_host(*host_port_from_url(stream_url), timeout=self.config.timeout)

            payload["latency_ms"] = latency_ms

            if not ok:
                payload["error"] = error
                self._record_failure(error)
                return payload

        frame, error = capture_frame(self.config, device_ip=device_ip, opener=self._opener)

        if frame is None:
            payload["error"] = error
            self._record_failure(error)
            return payload

        payload.update(self._health_from_frame(frame))
        return payload

    def _health_from_frame(self, frame: CapturedFrame) -> dict:
        self._remember_frame(frame)
        return {
            "ok": True,
            "reachable": True,
            "error": "",
            "latency_ms": frame.latency_ms,
            "frame": frame.to_dict(),
        }

    # -----------------------------------------------------
    # SNAPSHOT
    # -----------------------------------------------------

    def snapshot(self, allow_stale: bool = True) -> Tuple[Optional[CapturedFrame], str, bool]:
        """Latest frame: live first, last good frame second (marked stale).

        Returns (frame, error, from_cache).
        """

        error = ""

        if self.config.source != "none":
            device = self._device()
            device_ip = self._device_ip(device)
            frame, error = capture_frame(self.config, device_ip=device_ip, opener=self._opener)

            if frame is not None:
                self._remember_frame(frame)
                return frame, "", False

            self._record_failure(error)

        if allow_stale:
            cached = self._cached_frame()

            if cached is not None:
                cached.stale = True
                return cached, error, True

        return None, error or "no camera frame is available", False

    def _cached_frame(self) -> Optional[CapturedFrame]:
        with self._lock:
            if self._last_frame is None:
                return None

            age = time.monotonic() - self._last_frame_at

            if age > self.config.frame_max_age:
                return None

            cached = CapturedFrame(
                jpeg=self._last_frame.jpeg,
                source=self._last_frame.source,
                captured_at=self._last_frame.captured_at,
                width=self._last_frame.width,
                height=self._last_frame.height,
                channels=self._last_frame.channels,
                decoded=self._last_frame.decoded,
                latency_ms=self._last_frame.latency_ms,
                url=self._last_frame.url,
            )
            return cached

    # -----------------------------------------------------
    # STREAM INFO
    # -----------------------------------------------------

    def stream_info(self) -> dict:
        device = self._device()
        device_ip = self._device_ip(device)
        stream_url, origin = self.config.resolve_stream_url(device_ip)
        snapshot_url, _ = self.config.resolve_snapshot_url(device_ip)

        with self._lock:
            last_frame = self._last_frame.to_dict() if self._last_frame else None
            fps = self._fps_estimate()
            frames = self._frames_captured

        notes = []

        if origin == "device-registry":
            notes.append("stream host taken from the device registry; it follows a new DHCP lease automatically")
        elif origin == "configured-ip":
            notes.append("stream host pinned by ESP32_CAM_IP")
        elif origin == "env":
            notes.append("stream URL supplied by ESP32_CAM_STREAM_URL")
        else:
            notes.append("no stream host known yet")

        notes.append(f"the ESP32-CAM CameraWebServer example serves /stream on port {self.config.port}")

        return {
            "ok": True,
            "service": "visionary-nexus-camera",
            "source": {"configured": self.config.source, "effective": self._effective_source()},
            "stream": {
                "url": stream_url,
                "content_type": STREAM_CONTENT_TYPE,
                "boundary": STREAM_BOUNDARY,
                "port": self.config.port,
                "url_origin": origin,
                "snapshot_url": snapshot_url,
                "format": "MJPEG (image/jpeg parts)",
            },
            "resolution": {
                "width": (last_frame or {}).get("width", 0),
                "height": (last_frame or {}).get("height", 0),
                "label": (last_frame or {}).get("resolution", "unknown"),
            },
            "fps_estimate": fps,
            "frames_captured": frames,
            "last_frame": last_frame,
            "opencv": {"available": opencv_available(), "version": opencv_version()},
            "device": device,
            "notes": notes,
            "timestamp": _now_iso(),
        }

    # -----------------------------------------------------
    # STATE
    # -----------------------------------------------------

    def _remember_frame(self, frame: CapturedFrame) -> None:
        with self._lock:
            self._last_frame = frame
            self._last_frame_at = time.monotonic()
            self._frames_captured += 1
            self._reachable = True
            self._last_error = ""
            self._last_checked_at = _now_iso()
            self._capture_times.append(self._last_frame_at)

    def _record_failure(self, error: str) -> None:
        with self._lock:
            self._failures += 1
            self._reachable = False
            self._last_checked_at = _now_iso()

            if error:
                self._last_error = error

    def _fps_estimate(self) -> float:
        if len(self._capture_times) < 2:
            return 0.0

        span = self._capture_times[-1] - self._capture_times[0]

        if span <= 0:
            return 0.0

        return round((len(self._capture_times) - 1) / span, 2)


# ---------------------------------------------------------
# MODULE-LEVEL SERVICE
# ---------------------------------------------------------

_service: Optional[CameraService] = None
_service_lock = threading.Lock()


def get_camera_service() -> CameraService:
    """Process-wide camera service, built from the environment on first use."""

    global _service

    with _service_lock:
        if _service is None:
            _service = CameraService()
        return _service


def configure_camera_service(
    config: Optional[CameraConfig] = None,
    device_lookup: Optional[Callable[[], Optional[dict]]] = None,
    opener: Optional[Callable] = None,
) -> CameraService:
    """Re-point the singleton (new .env values, a new device lookup, tests)."""

    global _service

    with _service_lock:
        if _service is None:
            _service = CameraService(config=config, device_lookup=device_lookup, opener=opener)
        else:
            _service.configure(config=config, device_lookup=device_lookup, opener=opener)

        return _service


def reset_camera_service() -> None:
    """Drop the singleton so the next call rebuilds it from the environment."""

    global _service

    with _service_lock:
        _service = None


def set_device_lookup(lookup: Callable[[], Optional[dict]]) -> CameraService:
    """Install the registry lookup used to learn the board's address."""

    return configure_camera_service(device_lookup=lookup)
