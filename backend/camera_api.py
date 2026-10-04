# =========================================================
# VISIONARY NEXUS - CAMERA ROUTES
# =========================================================
#
# Thin HTTP layer over the camera package (camera/):
#
#   GET /api/camera/status       what is configured + last known state
#   GET /api/camera/health       live reachability probe (and a real frame)
#   GET /api/camera/snapshot     the latest JPEG (503 JSON when offline)
#   GET /api/camera/stream-info  stream URLs, framing and measured rate
#
# Design rules:
#
#   * the ESP32-CAM is optional - every endpoint answers with a useful JSON
#     body when the board is absent, and nothing here blocks startup
#   * the board's address comes from the device registry (the ip_address of
#     its last heartbeat) unless ESP32_CAM_STREAM_URL / ESP32_CAM_IP override
#     it, so a DHCP change needs no code change
#   * this module adds routes only: no existing route, response shape or
#     authentication behaviour is touched
#
# Registered in backend/api.py next to the device router.
# =========================================================

from datetime import datetime
import os
import sys

from fastapi import APIRouter, Query, Response
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

# The camera package lives at the repository root (camera/), so make sure it is
# importable both when the app runs as backend.api and when uvicorn is started
# from inside backend/.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from camera.camera import get_camera_service  # noqa: E402

try:
    from backend.database import SessionLocal
    from backend.models import Device
except ImportError:  # running from inside backend/
    from database import SessionLocal
    from models import Device

router = APIRouter(prefix="/api/camera", tags=["camera"])


# ---------------------------------------------------------
# DEVICE REGISTRY LOOKUP
# ---------------------------------------------------------
#
# The board reports its IP on every heartbeat (device_api.py stores it on the
# device row). The camera service reads the most useful row: an online device
# with an address first, then any device that has ever reported one.

def _device_snapshot(db: Session) -> dict:
    """Return the device whose address the camera should use (or None)."""

    try:
        candidates = (
            db.query(Device)
            .filter(Device.ip_address.isnot(None))
            .order_by(Device.last_seen_at.desc().nullslast(), Device.updated_at.desc().nullslast())
            .all()
        )

        if not candidates:
            return None

        online = [device for device in candidates if device.status == "online"]
        device = online[0] if online else candidates[0]

        return {
            "device_id": device.device_id,
            "hardware_uid": device.hardware_uid,
            "name": device.name,
            "model": device.model,
            "status": device.status,
            "ip_address": device.ip_address,
            "camera_ready": bool(device.camera_ready),
            "camera_sensor": device.camera_sensor,
            "camera_initialized_at": (
                device.camera_initialized_at.isoformat() if device.camera_initialized_at else None
            ),
            "last_heartbeat_at": device.last_heartbeat_at.isoformat() if device.last_heartbeat_at else None,
            "last_seen_at": device.last_seen_at.isoformat() if device.last_seen_at else None,
        }

    except Exception:
        # A camera endpoint must never fail because the device table is
        # missing or empty (fresh checkout, tests, migrated database).
        return None


def _device_lookup() -> dict:
    """Callable handed to the camera service (opens its own short session)."""

    try:
        with SessionLocal() as db:
            return _device_snapshot(db)
    except Exception:
        return None


def _camera_service():
    """The process-wide camera service, wired to the device registry."""

    service = get_camera_service()
    service.configure(device_lookup=_device_lookup)
    return service


# ---------------------------------------------------------
# STATUS
# ---------------------------------------------------------

@router.get("/status")
def camera_status(probe: bool = Query(default=False, description="also try to reach the board now")):
    """Configuration + last known state. Never fails when the camera is absent."""

    return _camera_service().status(probe=probe)


# ---------------------------------------------------------
# HEALTH
# ---------------------------------------------------------

@router.get("/health")
def camera_health(probe: bool = Query(default=True, description="run a live TCP + frame check")):
    """Live connectivity check: TCP probe, then one real frame when it answers."""

    return _camera_service().health(probe=probe)


# ---------------------------------------------------------
# SNAPSHOT
# ---------------------------------------------------------

@router.get("/snapshot")
def camera_snapshot():
    """The latest JPEG frame.

    200 image/jpeg   - a live frame, or the last good frame inside
                       ESP32_CAM_FRAME_MAX_AGE (then X-Camera-Stale: true)
    503 application/json - nothing available; the backend stays healthy
    """

    service = _camera_service()
    frame, error, from_cache = service.snapshot()

    if frame is None:
        return JSONResponse(
            status_code=503,
            content={
                "ok": False,
                "error": "camera_unavailable",
                "detail": error or "no camera frame is available",
                "stream_url": service.status().get("stream_url", ""),
                "snapshot_url": service.status().get("snapshot_url", ""),
                "timestamp": datetime.utcnow().isoformat(),
            },
        )

    headers = {
        "Cache-Control": "no-store, max-age=0",
        "X-Camera-Source": frame.source,
        "X-Camera-Captured-At": frame.captured_at,
        "X-Camera-Stale": "true" if (frame.stale or from_cache) else "false",
        "X-Camera-Resolution": frame.resolution,
        "X-Camera-Bytes": str(frame.size_bytes),
    }

    return Response(content=frame.jpeg, media_type="image/jpeg", headers=headers)


# ---------------------------------------------------------
# STREAM INFO
# ---------------------------------------------------------

@router.get("/stream-info")
def camera_stream_info():
    """Where the stream lives and how it is framed - for a player or the UI."""

    return _camera_service().stream_info()


# ---------------------------------------------------------
# DEVICE LINK (provisioning integration)
# ---------------------------------------------------------

@router.get("/device")
def camera_device():
    """The registry view of the board the camera is bound to.

    Lets the frontend show camera state next to the device card without
    duplicating the device endpoints.
    """

    device = _device_snapshot(SessionLocal())

    return {
        "ok": True,
        "linked": device is not None,
        "device": device,
        "timestamp": datetime.utcnow().isoformat(),
    }
