# =========================================================
# VISIONARY NEXUS - VIDEO STREAM READER
# =========================================================
#
# Bounded HTTP reads against the ESP32-CAM (or any MJPEG source). Everything
# here returns a result object with an error string instead of raising, and
# every read is capped in time (timeout) and size (max_frame_bytes) so a
# misbehaving device can never exhaust backend memory or hang a request.
#
#   http_get_bytes(url, timeout, max_bytes)  -> HttpResult
#   read_mjpeg_frame(url, timeout, max_bytes)-> (jpeg_bytes | None, error)
#
# The MJPEG reader understands both framings a real ESP32-CAM sends:
#
#   * multipart/x-mixed-replace with a Content-Length per part
#     (the CameraWebServer example on port 81 /stream)
#   * parts without a length, where the frame ends at the JPEG EOI marker
#
# Supported schemes are whatever urllib supports (http, https, file), which is
# also what lets the tests drive this code without a socket.
# =========================================================

import socket
import time
from dataclasses import dataclass
from typing import Callable, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .image_processing import trim_to_jpeg

DEFAULT_USER_AGENT = "VisionaryNexus-Camera/1.0"

BOUNDARY_HINTS = (b"boundary=",)
JPEG_SOI = b"\xff\xd8"


@dataclass
class HttpResult:
    """Outcome of one HTTP read. `ok` is False when `error` is set."""

    ok: bool
    url: str
    status: int = 0
    content_type: str = ""
    body: bytes = b""
    latency_ms: int = 0
    error: str = ""


def _describe_exception(url: str, error: Exception) -> str:
    """Turn an exception into a short, useful, user-facing sentence."""

    if isinstance(error, HTTPError):
        return f"{url} answered HTTP {error.code} {error.reason}".strip()

    if isinstance(error, ConnectionRefusedError):
        return f"{url} refused the connection (is the ESP32-CAM on and on the same network?)"

    if isinstance(error, socket.gaierror):
        return f"{url} could not be resolved (unknown host)"

    if isinstance(error, (socket.timeout, TimeoutError)):
        return f"{url} timed out"

    if isinstance(error, URLError):
        reason = error.reason
        if isinstance(reason, socket.timeout):
            return f"{url} timed out"
        if isinstance(reason, ConnectionRefusedError):
            return f"{url} refused the connection (is the ESP32-CAM on and on the same network?)"
        if isinstance(reason, socket.gaierror):
            return f"{url} could not be resolved (unknown host)"
        return f"{url} is unreachable: {reason}"

    if isinstance(error, ValueError):
        return f"{url} is not a valid URL: {error}"

    return f"{url} failed: {type(error).__name__}: {error}"


def http_get_bytes(
    url: str,
    timeout: float = 4.0,
    max_bytes: int = 2_000_000,
    opener: Optional[Callable] = None,
    read_until: int = 0,
) -> HttpResult:
    """GET `url` and read at most `max_bytes` (or up to `read_until` bytes).

    `opener` lets tests (or a future async transport) replace urlopen.
    Never raises: failures come back as HttpResult(ok=False, error=...).
    """

    if not url:
        return HttpResult(ok=False, url=url, error="no camera URL configured")

    started = time.monotonic()
    open_url = opener or urlopen
    request = Request(url, headers={"User-Agent": DEFAULT_USER_AGENT})

    response = None

    try:
        response = open_url(request, timeout=timeout)
        status = int(getattr(response, "status", 200) or 200)
        content_type = str(response.headers.get("Content-Type", "")) if response.headers else ""

        limit = max_bytes

        if read_until:
            limit = min(limit, read_until) if limit else read_until

        body = response.read(limit) if limit else response.read()

        return HttpResult(
            ok=True,
            url=url,
            status=status,
            content_type=content_type,
            body=body or b"",
            latency_ms=int((time.monotonic() - started) * 1000),
        )

    except Exception as error:  # noqa: BLE001 - deliberately total: never crash a request
        return HttpResult(
            ok=False,
            url=url,
            latency_ms=int((time.monotonic() - started) * 1000),
            error=_describe_exception(url, error),
        )

    finally:
        # Release the socket even when the body read failed halfway through.
        if response is not None:
            try:
                response.close()
            except Exception:
                pass


def _boundary_from_content_type(content_type: str) -> bytes:
    for hint in BOUNDARY_HINTS:
        index = content_type.encode("latin-1", "ignore").find(hint)

        if index >= 0:
            return content_type[index + len(hint):].strip().strip('"').encode("latin-1", "ignore")

    return b""


def read_mjpeg_frame(
    url: str,
    timeout: float = 4.0,
    max_frame_bytes: int = 2_000_000,
    opener: Optional[Callable] = None,
) -> Tuple[Optional[bytes], str]:
    """Read exactly one JPEG frame from an MJPEG stream.

    Returns (jpeg_bytes, "") on success or (None, error) on failure. The
    connection is always closed before returning - one frame per call keeps the
    snapshot endpoint stateless and safe for a device that drops connections.
    """

    if not url:
        return None, "no camera stream URL configured"

    started = time.monotonic()
    open_url = opener or urlopen
    request = Request(url, headers={"User-Agent": DEFAULT_USER_AGENT})

    response = None
    deadline = started + max(timeout, 0.1)

    try:
        response = open_url(request, timeout=timeout)
        content_type = str(response.headers.get("Content-Type", "")) if response.headers else ""

        if "image/jpeg" in content_type.lower():
            # Some builds answer /stream with a single JPEG instead of MJPEG.
            body = response.read(max_frame_bytes)
            frame = trim_to_jpeg(body or b"")

            if frame:
                return frame, ""

            if body and body[:2] == JPEG_SOI:
                return bytes(body), ""

            return None, f"{url} did not return a JPEG frame"

        boundary = _boundary_from_content_type(content_type)
        buffer = b""

        while time.monotonic() < deadline:
            # Read a small chunk at a time so one huge part cannot overrun the cap.
            chunk = response.read(4096)

            if not chunk:
                break

            buffer += chunk

            if len(buffer) > max_frame_bytes * 2:
                buffer = buffer[-max_frame_bytes:]

            if boundary:
                index = buffer.find(b"--" + boundary)

                if index < 0:
                    continue

                header_end = buffer.find(b"\r\n\r\n", index)

                if header_end < 0:
                    continue

                part_header = buffer[index:header_end].decode("latin-1", "ignore")
                body_start = header_end + 4
                content_length = 0

                for line in part_header.split("\r\n"):
                    if line.lower().startswith("content-length:"):
                        try:
                            content_length = int(line.split(":", 1)[1].strip())
                        except ValueError:
                            content_length = 0

                if content_length:
                    body = buffer[body_start:body_start + content_length]

                    # Make sure the whole part really arrived.
                    while len(body) < content_length and time.monotonic() < deadline:
                        more = response.read(min(4096, content_length - len(body)))

                        if not more:
                            break

                        body += more

                    frame = bytes(body[:content_length])

                    if frame[:2] == JPEG_SOI:
                        return frame, ""

                    return None, f"{url} sent a part that is not JPEG data ({len(frame)} bytes)"
                else:
                    frame = trim_to_jpeg(buffer[body_start:])

                    if frame:
                        return frame, ""

                    continue

            # No boundary advertised: fall back to JPEG markers.
            frame = trim_to_jpeg(buffer)

            if frame:
                return frame, ""

        if buffer and buffer[:2] == JPEG_SOI:
            frame = trim_to_jpeg(buffer)

            if frame:
                return frame, ""

        if len(buffer) >= max_frame_bytes:
            return None, f"{url} sent more than {max_frame_bytes} bytes without a complete frame"

        return None, f"{url} closed the stream before a full frame arrived"

    except Exception as error:  # noqa: BLE001 - never crash a request
        return None, _describe_exception(url, error)

    finally:
        if response is not None:
            try:
                response.close()
            except Exception:
                pass


def probe_host(host: str, port: int, timeout: float = 2.0) -> Tuple[bool, int, str]:
    """Cheap TCP reachability check. Returns (reachable, latency_ms, error)."""

    if not host:
        return False, 0, "no host to probe"

    started = time.monotonic()

    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True, int((time.monotonic() - started) * 1000), ""
    except Exception as error:  # noqa: BLE001
        return False, int((time.monotonic() - started) * 1000), _describe_exception(f"{host}:{port}", error)


def host_port_from_url(url: str) -> Tuple[str, int]:
    """Extract (host, port) from a URL for the TCP probe; ("", 0) when unknown."""

    if not url:
        return "", 0

    from urllib.parse import urlsplit

    try:
        parts = urlsplit(url)
    except ValueError:
        return "", 0

    host = parts.hostname or ""
    port = parts.port or (443 if parts.scheme == "https" else 80)

    return host, port
