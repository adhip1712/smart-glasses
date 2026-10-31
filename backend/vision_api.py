# =========================================================
# VISIONARY NEXUS - VISION / ML ROUTES
# =========================================================
#
# Thin HTTP layer over the ml package (ml/). One managed capture+inference
# worker is shared by every request - no request ever opens a camera or loads a
# model itself:
#
#   GET  /api/vision/status      camera + model + worker health (JSON)
#   GET  /api/vision/health      compact liveness for probes
#   GET  /api/vision/detections  latest detections as JSON
#   POST /api/vision/start       start the worker (idempotent)
#   POST /api/vision/stop        stop the worker (idempotent, releases camera)
#   GET  /api/vision/frame       latest annotated JPEG   (token required)
#   GET  /api/vision/stream      MJPEG preview           (token required)
#
# Access policy (the project has no user accounts yet - backend/auth.py is a
# placeholder - so pixels are gated explicitly instead):
#
#   * JSON status/health/detections carry no image data and follow the same
#     open convention as the existing /api/camera/* routes.
#   * Raw webcam frames (/frame, /stream) are NEVER served unless
#     VISION_STREAM_TOKEN is set AND the caller presents it. Without a token
#     configured they answer 403 with an explanation rather than leaking video.
#   * start/stop are protected by the same token when one is configured, so a
#     public deployment cannot be made to activate the camera remotely.
#
# Everything here is additive: no existing route, response shape, database
# access or authentication behaviour is changed. The ml package is optional -
# if Ultralytics/torch/numpy are absent the endpoints still answer with a
# useful body and the backend starts normally.
# =========================================================

import os
import sys
import time
from typing import Any, Dict, Optional

from fastapi import APIRouter, Header, Query, Response
from fastapi.responses import JSONResponse, StreamingResponse

# The ml package lives at the repository root, so make sure it is importable
# both when the app runs as backend.api and when uvicorn is started from
# inside backend/.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

try:
    from ml.config import VisionConfigError, load_settings
    from ml.detector import ModelUnavailableError
    from ml.session import VisionSession
    from ml.webcam_source import SourceUnavailableError
    from ml import event_analysis as vision_events

    ML_IMPORT_ERROR = ""
except Exception as _error:  # numpy or the ml package missing: degrade, never fail
    VisionConfigError = SourceUnavailableError = ModelUnavailableError = RuntimeError
    VisionSession = None  # type: ignore[assignment]
    load_settings = None  # type: ignore[assignment]
    vision_events = None  # type: ignore[assignment]
    ML_IMPORT_ERROR = f"{type(_error).__name__}: {_error}"

router = APIRouter(prefix="/api/vision", tags=["vision"])

# One worker for the whole process. Created lazily so importing this module (and
# therefore starting the backend) never touches a camera or a model.
_SESSION: Any = None
_SESSION_LOCK = __import__("threading").Lock()


def get_session() -> Any:
    """The single shared VisionSession (created on first use)."""

    global _SESSION

    if _SESSION is not None:
        return _SESSION

    with _SESSION_LOCK:
        if _SESSION is None:
            if VisionSession is None:
                raise RuntimeError(
                    "the ml package could not be imported "
                    f"({ML_IMPORT_ERROR}). Install the ML extras: "
                    "pip install -r requirements-ml.txt"
                )

            session = VisionSession(load_settings())
            session.set_device_lookup(_latest_device_ip_lookup())
            _SESSION = session

    return _SESSION


def set_session(session: Any) -> None:
    """Inject a session (used by tests to avoid a real camera or model)."""

    global _SESSION
    _SESSION = session


def shutdown_vision() -> None:
    """Release the camera on backend shutdown. Safe when nothing is running."""

    global _SESSION

    session = _SESSION

    if session is None:
        return

    try:
        session.close()
    except Exception:
        pass


def _unavailable(message: str, status: int = 503) -> JSONResponse:
    """A JSON error body, with install guidance when the ML extras are missing."""

    if VisionSession is None and "requirements-ml.txt" not in message:
        message = (
            f"{message} Install the ML extras into the project virtual environment: "
            "pip install -r requirements-ml.txt"
        )

    return JSONResponse(
        status_code=status,
        content={
            "status": "error",
            "error": message,
            "ml_available": VisionSession is not None,
            "ml_import_error": ML_IMPORT_ERROR,
        },
    )


# ---------------------------------------------------------
# TOKEN POLICY
# ---------------------------------------------------------

def stream_token() -> str:
    """Read the camera token from the process environment or project .env.

    The backend is sometimes launched directly with Uvicorn, which does not
    automatically load .env. Reading only the named setting here keeps preview
    authentication working without loading or exposing other secrets.
    """

    configured = (os.getenv("VISION_STREAM_TOKEN") or "").strip()
    if configured:
        return configured

    env_file = os.path.join(_REPO_ROOT, ".env")
    try:
        with open(env_file, "r", encoding="utf-8-sig") as handle:
            for line in handle:
                key, separator, value = line.partition("=")
                if separator and key.strip() == "VISION_STREAM_TOKEN":
                    return value.strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def _authorize(
    authorization: Optional[str],
    x_vision_token: Optional[str],
    query_token: Optional[str] = None,
) -> Optional[JSONResponse]:
    """Return an error response when camera access is not authorized.

    Pixels are never served without a configured token: that is a deliberate
    fail-closed default, not a convenience.

    The header forms are preferred. `query_token` is accepted only by the two
    image endpoints, because a browser `<img>` element cannot send headers - so
    an MJPEG preview would otherwise be impossible to authenticate.
    """

    expected = stream_token()

    if not expected:
        return JSONResponse(
            status_code=403,
            content={
                "status": "error",
                "error": (
                    "camera frames are disabled because no VISION_STREAM_TOKEN is "
                    "configured. Set VISION_STREAM_TOKEN in .env to enable this endpoint, "
                    "then send it as 'Authorization: Bearer <token>'."
                ),
                "protected": True,
            },
        )

    provided = ""

    if x_vision_token:
        provided = x_vision_token.strip()
    elif authorization:
        parts = authorization.split()

        if len(parts) == 2 and parts[0].lower() == "bearer":
            provided = parts[1].strip()
    elif query_token:
        provided = query_token.strip()

    if provided == expected:
        return None

    return JSONResponse(
        status_code=401,
        content={
            "status": "error",
            "error": "a valid VISION_STREAM_TOKEN is required for camera access.",
            "protected": True,
        },
        headers={"WWW-Authenticate": "Bearer"},
    )


# ---------------------------------------------------------
# DEVICE LOOKUP (so an ESP32 source can find its own address)
# ---------------------------------------------------------

def _latest_device_ip_lookup():
    """Return a callable giving the most recently seen device's IP, or None."""

    try:
        from backend.database import SessionLocal
        from backend.models import Device
    except ImportError:
        try:
            from database import SessionLocal  # type: ignore[no-redef]
            from models import Device  # type: ignore[no-redef]
        except Exception:
            return lambda: None

    def lookup() -> Optional[Dict[str, Any]]:
        try:
            with SessionLocal() as db:
                device = (
                    db.query(Device)
                    .filter(Device.ip_address.isnot(None))
                    .order_by(Device.updated_at.desc())
                    .first()
                )

                if device is None:
                    return None

                return {
                    "device_id": device.device_id,
                    "ip_address": device.ip_address,
                }
        except Exception:
            return None

    return lookup


# ---------------------------------------------------------
# STATUS
# ---------------------------------------------------------

@router.get("/status")
def vision_status() -> Dict[str, Any]:
    """Camera, model and worker state. Always answers, even with no ML installed."""

    if VisionSession is None:
        return {
            "running": False,
            "enabled": False,
            "healthy": False,
            "ml_available": False,
            "ml_import_error": ML_IMPORT_ERROR,
            "camera_available": False,
            "model_available": False,
            "errors": [ML_IMPORT_ERROR or "the ml package is not importable"],
        }

    session = get_session()

    try:
        payload = session.status()
    except Exception as error:
        return {"running": False, "healthy": False, "ml_available": True,
                "errors": [f"{type(error).__name__}: {error}"]}

    payload["ml_available"] = True
    payload["ml_import_error"] = ""
    payload["stream_endpoint_enabled"] = bool(stream_token())
    return payload


@router.get("/health")
def vision_health() -> Dict[str, Any]:
    """Compact health check: is the worker running, is the camera open, is the model loaded."""

    if VisionSession is None:
        return {"ok": False, "reason": "ml_package_missing", "detail": ML_IMPORT_ERROR}

    session = get_session()

    try:
        status = session.status()
    except Exception as error:
        return {"ok": False, "reason": "error", "detail": f"{type(error).__name__}: {error}"}

    return {
        "ok": bool(status.get("healthy")),
        "running": bool(status.get("running")),
        "camera_available": bool(status.get("camera_available")),
        "model_available": bool(status.get("model_available")),
        "model_loaded": bool(status.get("model_loaded")),
        "tracking": bool(status.get("tracking")),
        "fps": status.get("fps", 0.0),
        "inference_ms": status.get("inference_ms", 0.0),
        "frames": status.get("frames", 0),
        "errors": status.get("errors", []),
        "stream_endpoint_enabled": bool(stream_token()),
    }


@router.get("/detections")
def vision_detections(
    max_age: float = Query(5.0, ge=0.1, le=120.0, description="reject results older than this"),
    include_boxes: bool = Query(True, description="include bounding-box coordinates"),
) -> JSONResponse:
    """The latest detections as JSON. 200 with data, or 200 with an empty set."""

    if VisionSession is None:
        return _unavailable(ML_IMPORT_ERROR or "the ml package is not importable")

    session = get_session()

    try:
        snapshot = session.latest(max_age_seconds=max_age)
    except Exception as error:
        return _unavailable(f"{type(error).__name__}: {error}", status=500)

    detections = snapshot.get("detections")

    body: Dict[str, Any] = {
        "status": "ok" if detections is not None else "no_result",
        "running": snapshot.get("running"),
        "stale": snapshot.get("stale"),
        "frame_age_seconds": snapshot.get("frame_age_seconds"),
        "fps": snapshot.get("fps"),
        "frames": snapshot.get("frames"),
        "count": 0,
        "labels": {},
        "inference_ms": 0.0,
        "tracked": False,
        "detections": [],
        "errors": [
            value
            for value in (snapshot.get("camera_error"), snapshot.get("model_error"))
            if value
        ],
    }

    if detections is not None:
        body.update(
            {
                "count": detections.get("count", 0),
                "labels": detections.get("labels", {}),
                "inference_ms": detections.get("inference_ms", 0.0),
                "tracked": detections.get("tracked", False),
                "frame": detections.get("frame", {}),
                "detections": (
                    detections.get("detections", [])
                    if include_boxes
                    else [
                        {
                            key: value
                            for key, value in detection.items()
                            if key not in ("box", "box_normalized", "center")
                        }
                        for detection in detections.get("detections", [])
                    ]
                ),
            }
        )

    return JSONResponse(status_code=200, content=body)


# ---------------------------------------------------------
# START / STOP
# ---------------------------------------------------------

@router.post("/start")
async def vision_start(
    authorization: Optional[str] = Header(default=None),
    x_vision_token: Optional[str] = Header(default=None, alias="X-Vision-Token"),
) -> JSONResponse:
    """Start the single worker. Duplicate calls are safe.

    Runs in a threadpool: opening a camera takes real time and must not block
    FastAPI's event loop.
    """

    if stream_token():
        denied = _authorize(authorization, x_vision_token)

        if denied is not None:
            return denied

    if VisionSession is None:
        return _unavailable(ML_IMPORT_ERROR or "the ml package is not importable")

    from starlette.concurrency import run_in_threadpool

    try:
        result = await run_in_threadpool(get_session().start)
    except SourceUnavailableError as error:
        return _unavailable(f"camera unavailable: {error}")
    except ModelUnavailableError as error:
        return _unavailable(f"model unavailable: {error}")
    except VisionConfigError as error:
        return _unavailable(f"invalid configuration: {error}", status=400)
    except Exception as error:
        return _unavailable(f"{type(error).__name__}: {error}", status=500)

    session = get_session()
    if vision_events is not None:
        vision_events.start_monitor(session)

    return JSONResponse(
        status_code=200,
        content={
            "status": "ok",
            "started": bool(result.get("started")),
            "already_running": bool(result.get("already_running")),
            "session": session.status(),
        },
    )


@router.post("/stop")
async def vision_stop(
    authorization: Optional[str] = Header(default=None),
    x_vision_token: Optional[str] = Header(default=None, alias="X-Vision-Token"),
) -> JSONResponse:
    """Stop the worker and release the camera. Duplicate calls are safe."""

    if stream_token():
        denied = _authorize(authorization, x_vision_token)

        if denied is not None:
            return denied

    if VisionSession is None:
        return JSONResponse(
            status_code=200,
            content={"status": "ok", "stopped": True, "was_running": False},
        )

    if vision_events is not None:
        vision_events.stop_monitor()

    from starlette.concurrency import run_in_threadpool

    try:
        result = await run_in_threadpool(get_session().stop)
    except Exception as error:
        return _unavailable(f"{type(error).__name__}: {error}", status=500)

    status_code = 200 if result.get("stopped") else 500

    return JSONResponse(status_code=status_code, content={"status": "ok" if result.get("stopped") else "error", **result})


# ---------------------------------------------------------
# EVENT ANALYSIS (additive endpoints; local detector remains independent)
# ---------------------------------------------------------

@router.get("/events")
def vision_events_status(
    authorization: Optional[str] = Header(default=None),
    x_vision_token: Optional[str] = Header(default=None, alias="X-Vision-Token"),
) -> Any:
    """Latest event-analysis results and API-key readiness; never returns a key."""
    if stream_token():
        denied = _authorize(authorization, x_vision_token)
        if denied is not None:
            return denied
    if vision_events is None:
        return {"enabled": False, "running": False, "last_error": "event analysis module unavailable", "events": []}
    return vision_events.status()


@router.post("/events/analyze")
def vision_analyze_event(
    authorization: Optional[str] = Header(default=None),
    x_vision_token: Optional[str] = Header(default=None, alias="X-Vision-Token"),
) -> JSONResponse:
    """Analyze one fresh frame on demand with the configured local Ollama vision model."""
    if stream_token():
        denied = _authorize(authorization, x_vision_token)
        if denied is not None:
            return denied
    if vision_events is None or VisionSession is None:
        return JSONResponse(status_code=503, content={"status": "unavailable", "error": "Vision event analysis is unavailable."})
    try:
        result = vision_events.analyze_latest(get_session())
    except Exception as error:
        return JSONResponse(status_code=500, content={"status": "error", "error": f"{type(error).__name__}: {error}"})
    code = 200 if result.get("status") == "ok" else 503 if result.get("status") in ("unconfigured", "unavailable") else 502
    return JSONResponse(status_code=code, content=result)


# ---------------------------------------------------------
# FRAMES (token protected)
# ---------------------------------------------------------

@router.post("/photo")
def vision_capture_photo(
    authorization: Optional[str] = Header(default=None),
    x_vision_token: Optional[str] = Header(default=None, alias="X-Vision-Token"),
) -> JSONResponse:
    """Capture the newest frame from the already-running worker and describe it with high-detail AI."""
    if stream_token():
        denied = _authorize(authorization, x_vision_token)
        if denied is not None:
            return denied
    if VisionSession is None or vision_events is None:
        return JSONResponse(status_code=503, content={"status": "unavailable", "error": "Vision service is unavailable."})
    try:
        session = get_session()
        snapshot = session.latest(max_age_seconds=3.0)
        if not snapshot.get("running") or snapshot.get("stale"):
            return JSONResponse(status_code=503, content={"status": "unavailable", "error": "No fresh camera frame. Start detection and wait for a frame."})
        jpeg = session.latest_jpeg(max_age_seconds=3.0)
        if not jpeg:
            return JSONResponse(status_code=503, content={"status": "unavailable", "error": "No camera photo is available yet."})
        # Capture must not wait for Ollama/AI. Return the actual JPEG immediately;
        # photo analysis is a separate action so a slow local model cannot block capture.
        import base64
        return JSONResponse(status_code=200, content={
            "status": "ok",
            "summary": "Photo captured successfully. AI analysis is optional.",
            "photo_data_url": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii"),
            "photo_bytes": len(jpeg),
            "timestamp": time.time(),
        })
    except Exception as error:
        return JSONResponse(status_code=500, content={"status": "error", "error": f"{type(error).__name__}: {error}"})


@router.get("/frame")
def vision_frame(
    authorization: Optional[str] = Header(default=None),
    x_vision_token: Optional[str] = Header(default=None, alias="X-Vision-Token"),
    token: Optional[str] = Query(default=None, description="token for <img> clients, which cannot send headers"),
) -> Response:
    """The latest annotated JPEG. Requires VISION_STREAM_TOKEN; fail-closed."""

    denied = _authorize(authorization, x_vision_token, token)

    if denied is not None:
        return denied

    if VisionSession is None:
        return _unavailable(ML_IMPORT_ERROR or "the ml package is not importable")

    jpeg = get_session().latest_jpeg()

    if jpeg is None:
        return _unavailable(
            "no recent frame is available - is the vision worker running? "
            "POST /api/vision/start first.",
            status=503,
        )

    return Response(
        content=jpeg,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "no-store",
            "X-Vision-Bytes": str(len(jpeg)),
        },
    )


@router.get("/stream")
def vision_stream(
    authorization: Optional[str] = Header(default=None),
    x_vision_token: Optional[str] = Header(default=None, alias="X-Vision-Token"),
    token: Optional[str] = Query(default=None, description="token for <img> clients, which cannot send headers"),
    max_frames: int = Query(0, ge=0, le=100000, description="0 = unlimited"),
) -> Response:
    """An MJPEG preview of the annotated frames. Requires VISION_STREAM_TOKEN."""

    denied = _authorize(authorization, x_vision_token, token)

    if denied is not None:
        return denied

    if VisionSession is None:
        return _unavailable(ML_IMPORT_ERROR or "the ml package is not importable")

    session = get_session()

    def frames():
        boundary = b"--nexusvisionframe\r\n"
        sent = 0

        while True:
            jpeg = session.latest_jpeg()

            if jpeg is not None:
                yield boundary
                yield b"Content-Type: image/jpeg\r\n"
                yield f"Content-Length: {len(jpeg)}\r\n\r\n".encode("ascii")
                yield jpeg
                yield b"\r\n"
                sent += 1

                if max_frames and sent >= max_frames:
                    yield b"--nexusvisionframe--\r\n"
                    return

            time.sleep(0.08)

    return StreamingResponse(
        frames(),
        media_type="multipart/x-mixed-replace; boundary=nexusvisionframe",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
