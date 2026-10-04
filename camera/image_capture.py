# =========================================================
# VISIONARY NEXUS - FRAME CAPTURE
# =========================================================
#
# One captured frame, from whichever source the configuration allows:
#
#   1. one MJPEG frame from the ESP32-CAM stream  (http://<ip>:81/stream)
#   2. one JPEG from the ESP32-CAM snapshot route  (http://<ip>:81/capture)
#   3. the PC webcam through OpenCV - ONLY when CAMERA_SOURCE=webcam
#
# The webcam never silently replaces the ESP32-CAM: it is a development
# fallback that has to be asked for, so a missing board cannot be mistaken for
# a working hardware pipeline.
#
# Every path releases what it opened (HTTP response, VideoCapture) and returns
# (None, error) rather than raising.
# =========================================================

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Optional, Tuple

from .config import CameraConfig
from .image_processing import decode_jpeg, encode_jpeg, opencv_available
from .video_stream import http_get_bytes, read_mjpeg_frame

SOURCE_STREAM = "esp32-stream"
SOURCE_SNAPSHOT = "esp32-snapshot"
SOURCE_WEBCAM = "webcam"


@dataclass
class CapturedFrame:
    """A JPEG frame plus the metadata the API reports about it."""

    jpeg: bytes
    source: str
    captured_at: str = ""
    width: int = 0
    height: int = 0
    channels: int = 0
    decoded: bool = False
    latency_ms: int = 0
    stale: bool = False
    url: str = ""

    def __post_init__(self):
        if not self.captured_at:
            self.captured_at = datetime.now(timezone.utc).isoformat()

    @property
    def size_bytes(self) -> int:
        return len(self.jpeg or b"")

    @property
    def resolution(self) -> str:
        return f"{self.width}x{self.height}" if self.width and self.height else "unknown"

    def to_dict(self) -> dict:
        return {
            "source": self.source,
            "captured_at": self.captured_at,
            "width": self.width,
            "height": self.height,
            "resolution": self.resolution,
            "bytes": self.size_bytes,
            "decoded": self.decoded,
            "latency_ms": self.latency_ms,
            "stale": self.stale,
            "url": self.url,
        }


def frame_from_jpeg(jpeg: bytes, source: str, latency_ms: int = 0, url: str = "") -> Tuple[Optional[CapturedFrame], str]:
    """Wrap JPEG bytes in a CapturedFrame, decoding when OpenCV is available."""

    if not jpeg:
        return None, "empty frame"

    frame = CapturedFrame(jpeg=bytes(jpeg), source=source, latency_ms=latency_ms, url=url)
    decoded = decode_jpeg(frame.jpeg)

    if decoded is not None:
        frame.width = decoded.width
        frame.height = decoded.height
        frame.channels = decoded.channels
        frame.decoded = True

    return frame, ""


def capture_from_esp32(
    config: CameraConfig,
    device_ip: str = "",
    opener: Optional[Callable] = None,
) -> Tuple[Optional[CapturedFrame], str]:
    """One frame: MJPEG stream first, snapshot route second."""

    stream_url, _ = config.resolve_stream_url(device_ip)
    snapshot_url, _ = config.resolve_snapshot_url(device_ip)

    errors = []

    if stream_url:
        jpeg, error = read_mjpeg_frame(
            stream_url,
            timeout=config.timeout,
            max_frame_bytes=config.max_frame_bytes,
            opener=opener,
        )

        if jpeg:
            return frame_from_jpeg(jpeg, SOURCE_STREAM, url=stream_url)

        errors.append(f"stream: {error}")

    if snapshot_url:
        result = http_get_bytes(
            snapshot_url,
            timeout=config.timeout,
            max_bytes=config.max_frame_bytes,
            opener=opener,
        )

        if result.ok and result.body:
            frame, _ = frame_from_jpeg(result.body, SOURCE_SNAPSHOT, latency_ms=result.latency_ms, url=snapshot_url)

            if frame is not None:
                return frame, ""

            errors.append(f"snapshot: {snapshot_url} did not return a JPEG")

        else:
            errors.append(f"snapshot: {result.error or 'no data'}")

    if not errors:
        return None, "no ESP32-CAM address is configured (set ESP32_CAM_IP or ESP32_CAM_STREAM_URL)"

    return None, "; ".join(errors)


def capture_from_webcam(index: int = 0, quality: int = 80) -> Tuple[Optional[CapturedFrame], str]:
    """One frame from the PC webcam through OpenCV (opt-in source)."""

    if not opencv_available():
        return None, "OpenCV is not installed, the webcam source is unavailable"

    try:
        import cv2  # type: ignore
    except Exception:
        return None, "OpenCV is not installed, the webcam source is unavailable"

    capture = None

    try:
        capture = cv2.VideoCapture(index)

        if not capture.isOpened():
            return None, f"the PC webcam at index {index} could not be opened"

        ok, image = capture.read()

        if not ok or image is None:
            return None, f"the PC webcam at index {index} returned no frame"

        jpeg = encode_jpeg(image, quality)

        if not jpeg:
            return None, "the webcam frame could not be encoded as JPEG"

        frame, error = frame_from_jpeg(jpeg, SOURCE_WEBCAM)
        return frame, error

    except Exception as error:  # noqa: BLE001
        return None, f"the PC webcam failed: {type(error).__name__}: {error}"

    finally:
        # Always release the device, even when reading failed.
        if capture is not None:
            try:
                capture.release()
            except Exception:
                pass


def capture_frame(
    config: CameraConfig,
    device_ip: str = "",
    opener: Optional[Callable] = None,
    webcam_index: Optional[int] = None,
) -> Tuple[Optional[CapturedFrame], str]:
    """Capture according to CAMERA_SOURCE.

    auto   - ESP32-CAM when an address resolves; otherwise a clear error
             (it does NOT fall through to the webcam)
    esp32  - ESP32-CAM only
    webcam - PC webcam only
    none   - camera disabled by configuration
    """

    if config.source == "none":
        return None, "the camera is disabled (CAMERA_SOURCE=none)"

    if config.source == "webcam":
        return capture_from_webcam(index=config.webcam_index if webcam_index is None else webcam_index)

    frame, error = capture_from_esp32(config, device_ip=device_ip, opener=opener)

    if frame is not None:
        return frame, ""

    return None, error
