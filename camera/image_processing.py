# =========================================================
# VISIONARY NEXUS - IMAGE PROCESSING
# =========================================================
#
# JPEG decode / encode through OpenCV. OpenCV is optional at runtime: the
# backend must keep working (and keep serving camera bytes) on a machine where
# it is not installed, so every function degrades to "not available" instead of
# raising ImportError at import time.
#
#   decode_jpeg(bytes)  -> DecodedFrame | None
#   encode_jpeg(image)  -> bytes | None
#
# A DecodedFrame keeps both the numpy array (for later processing) and the
# original JPEG bytes, so a caller can always answer with an image even when
# OpenCV is missing.
# =========================================================

from dataclasses import dataclass
from typing import Any, Optional

try:  # OpenCV is optional - see module docstring.
    import cv2  # type: ignore
    import numpy as np  # type: ignore
except Exception:  # pragma: no cover - depends on the machine
    cv2 = None  # type: ignore
    np = None  # type: ignore


JPEG_SOI = b"\xff\xd8"   # start of image
JPEG_EOI = b"\xff\xd9"   # end of image


@dataclass
class DecodedFrame:
    """One decoded JPEG frame plus the bytes it came from."""

    image: Any                 # numpy array (H, W, 3), BGR
    width: int
    height: int
    channels: int
    jpeg: bytes

    @property
    def resolution(self) -> str:
        return f"{self.width}x{self.height}"


def opencv_available() -> bool:
    return cv2 is not None


def opencv_version() -> str:
    if cv2 is None:
        return ""
    return str(getattr(cv2, "__version__", ""))


def looks_like_jpeg(data: bytes) -> bool:
    return bool(data) and data[:2] == JPEG_SOI


def decode_jpeg(data: bytes) -> Optional[DecodedFrame]:
    """Decode JPEG bytes to BGR pixels. Returns None when undecodable/unavailable."""

    if not data or cv2 is None or np is None:
        return None

    if not looks_like_jpeg(data):
        return None

    buffer = np.frombuffer(data, dtype=np.uint8)

    try:
        image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    except Exception:
        return None

    if image is None:
        return None

    height, width = image.shape[:2]
    channels = image.shape[2] if image.ndim == 3 else 1

    return DecodedFrame(
        image=image,
        width=int(width),
        height=int(height),
        channels=int(channels),
        jpeg=bytes(data),
    )


def encode_jpeg(image: Any, quality: int = 80) -> Optional[bytes]:
    """Encode a BGR numpy image to JPEG bytes (None when OpenCV is absent)."""

    if image is None or cv2 is None:
        return None

    try:
        ok, buffer = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
    except Exception:
        return None

    if not ok:
        return None

    return bytes(buffer.tobytes())


def trim_to_jpeg(data: bytes) -> bytes:
    """Cut a byte blob down to the first complete JPEG (SOI..EOI).

    Used when a device sends no Content-Length for a frame: we take what the
    marker pair says instead of trusting the socket to end.
    """

    if not data:
        return b""

    start = data.find(JPEG_SOI)

    if start < 0:
        return b""

    end = data.find(JPEG_EOI, start + 2)

    if end < 0:
        return b""

    return data[start:end + 2]
