# =========================================================
# VISIONARY NEXUS - CAMERA CONFIGURATION
# =========================================================
#
# Configuration follows the project convention: plain environment variables
# loaded from the repository .env (see .env.example), read with os.getenv and
# sane defaults, so the backend always starts - camera or no camera.
#
#   CAMERA_SOURCE              auto | esp32 | webcam | none     (default auto)
#   ESP32_CAM_IP               the board's address, e.g. 192.168.1.50
#   ESP32_CAM_PORT             CameraWebServer port             (default 81)
#   ESP32_CAM_STREAM_URL       full override for the MJPEG stream
#   ESP32_CAM_SNAPSHOT_URL     full override for the single-JPEG snapshot
#   ESP32_CAM_STREAM_PATH      path appended to <ip>:<port>     (default /stream)
#   ESP32_CAM_SNAPSHOT_PATH    path appended to <ip>:<port>     (default /capture)
#   ESP32_CAM_TIMEOUT          seconds for any camera HTTP call (default 4)
#   ESP32_CAM_MAX_FRAME_BYTES  hard cap on one frame read       (default 2000000)
#   ESP32_CAM_FRAME_MAX_AGE    seconds a cached frame stays     (default 10)
#   ESP32_CAM_WEBCAM_INDEX     OpenCV device index for webcam   (default 0)
#
# Address resolution is deliberately DHCP friendly. The stream URL is taken
# from, in order:
#
#   1. ESP32_CAM_STREAM_URL  - explicit, wins over everything
#   2. the device registry   - the ip_address the board reported in its last
#                              heartbeat (see backend/device_api.py), so a new
#                              DHCP lease needs no backend edit
#   3. ESP32_CAM_IP          - the value typed into .env
#
# The same order applies to the snapshot URL. The origin that was used is
# reported by /api/camera/status and /api/camera/stream-info.
# =========================================================

import os
from dataclasses import dataclass, field
from typing import Optional

VALID_SOURCES = ("auto", "esp32", "webcam", "none")


def _env_str(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


def _env_int(name: str, default: int) -> int:
    try:
        return int(_env_str(name, str(default)))
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(_env_str(name, str(default)))
    except ValueError:
        return default


def build_host_url(host: str, port: int, path: str) -> str:
    """http://<host>:<port><path>, tolerating a host that already has a scheme."""

    host = (host or "").strip().rstrip("/")

    if not host:
        return ""

    if host.startswith("http://") or host.startswith("https://"):
        base = host
    else:
        base = f"http://{host}"

    if port and f":{port}" not in base.split("/", 3)[2]:
        base = f"{base}:{port}"

    path = path if path.startswith("/") else f"/{path}"
    return base + path


@dataclass(frozen=True)
class CameraConfig:
    """Resolved camera configuration (immutable - build a new one to change it)."""

    source: str = "auto"
    esp32_ip: str = ""
    port: int = 81
    stream_url: str = ""
    snapshot_url: str = ""
    stream_path: str = "/stream"
    snapshot_path: str = "/capture"
    timeout: float = 4.0
    max_frame_bytes: int = 2_000_000
    frame_max_age: float = 10.0
    webcam_index: int = 0

    # Populated by CameraService when the registry supplies an address, so the
    # status payload can say where the URL came from.
    device_ip: str = field(default="", compare=False)

    @classmethod
    def from_env(cls, env: Optional[dict] = None) -> "CameraConfig":
        if env is not None:
            # Test/DI path: read from the supplied mapping only.
            get = lambda name, default="": str(env.get(name, default) or "").strip()  # noqa: E731
            def get_int(name, default):
                try:
                    return int(get(name, str(default)))
                except ValueError:
                    return default
            def get_float(name, default):
                try:
                    return float(get(name, str(default)))
                except ValueError:
                    return default
        else:
            get = _env_str
            get_int = _env_int
            get_float = _env_float

        source = get("CAMERA_SOURCE", "auto").lower()
        if source not in VALID_SOURCES:
            source = "auto"

        return cls(
            source=source,
            esp32_ip=get("ESP32_CAM_IP", ""),
            port=get_int("ESP32_CAM_PORT", 81),
            stream_url=get("ESP32_CAM_STREAM_URL", ""),
            snapshot_url=get("ESP32_CAM_SNAPSHOT_URL", ""),
            stream_path=get("ESP32_CAM_STREAM_PATH", "/stream") or "/stream",
            snapshot_path=get("ESP32_CAM_SNAPSHOT_PATH", "/capture") or "/capture",
            timeout=get_float("ESP32_CAM_TIMEOUT", 4.0),
            max_frame_bytes=get_int("ESP32_CAM_MAX_FRAME_BYTES", 2_000_000),
            frame_max_age=get_float("ESP32_CAM_FRAME_MAX_AGE", 10.0),
            webcam_index=get_int("ESP32_CAM_WEBCAM_INDEX", 0),
        )

    # -----------------------------------------------------
    # ADDRESS RESOLUTION  (env override -> device registry -> ESP32_CAM_IP)
    # -----------------------------------------------------

    def resolve_stream_url(self, device_ip: str = "") -> tuple:
        """Return (url, origin). origin tells the caller which source won."""

        if self.stream_url:
            return self.stream_url, "env"

        if device_ip:
            return build_host_url(device_ip, self.port, self.stream_path), "device-registry"

        if self.esp32_ip:
            return build_host_url(self.esp32_ip, self.port, self.stream_path), "configured-ip"

        return "", "none"

    def resolve_snapshot_url(self, device_ip: str = "") -> tuple:
        if self.snapshot_url:
            return self.snapshot_url, "env"

        if device_ip:
            return build_host_url(device_ip, self.port, self.snapshot_path), "device-registry"

        if self.esp32_ip:
            return build_host_url(self.esp32_ip, self.port, self.snapshot_path), "configured-ip"

        return "", "none"

    @property
    def usable(self) -> bool:
        """True when some ESP32-CAM address (or an explicit URL) is configured."""

        return bool(self.stream_url or self.snapshot_url or self.esp32_ip)

    @property
    def webcam_allowed(self) -> bool:
        """The PC webcam is opt-in only - it never silently replaces the ESP32-CAM."""

        return self.source == "webcam"


def from_env(env: Optional[dict] = None) -> CameraConfig:
    return CameraConfig.from_env(env)
