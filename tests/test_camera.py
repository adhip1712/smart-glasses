# =========================================================
# ESP32-CAM CAMERA PIPELINE TESTS
# =========================================================
#
# No ESP32-CAM hardware is required. The tests drive the real code paths with:
#
#   * a throw-away HTTP server that speaks the exact protocol the
#     CameraWebServer example speaks (multipart MJPEG on /stream, one JPEG on
#     /capture, plus a deliberately slow route for timeout coverage)
#   * fake urllib openers for the framings a socket test cannot produce
#     (MJPEG parts without Content-Length)
#   * fake OpenCV objects for the webcam path, so no PC camera is needed
#
# They also prove the requirement that matters most: with no board attached,
# every camera endpoint answers with useful JSON and the rest of the backend
# is unaffected.
# =========================================================

import io
import os
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

# Same throw-away database rule as the device lifecycle tests: force it before
# importing the app so the suite can never touch smartglasses.db.
_TMP_DIR = tempfile.mkdtemp(prefix="nexus-camera-tests-")

os.environ.setdefault("DATABASE_URL", f"sqlite:///{_TMP_DIR}/camera-tests.db")
os.environ.setdefault("DEVICE_TOKEN_PEPPER", "test-pepper-do-not-use-in-production")
os.environ.setdefault("DEVICE_TOKEN_KEY", "test-key-do-not-use-in-production")

from fastapi.testclient import TestClient  # noqa: E402

from backend.api import app  # noqa: E402
from backend.database import Base, SessionLocal, engine  # noqa: E402
from backend.models import Device  # noqa: E402

from camera import image_capture, image_processing  # noqa: E402
from camera.camera import CameraService, configure_camera_service, reset_camera_service  # noqa: E402
from camera.config import CameraConfig  # noqa: E402
from camera.image_processing import decode_jpeg, trim_to_jpeg  # noqa: E402
from camera.video_stream import http_get_bytes, read_mjpeg_frame  # noqa: E402

JPEG = pytest.importorskip("cv2", reason="OpenCV is needed to build test frames")
import numpy as np  # noqa: E402


# =========================================================
# FRAME FIXTURES
# =========================================================

def make_jpeg(width: int = 96, height: int = 64, colour=(30, 120, 200)) -> bytes:
    image = np.zeros((height, width, 3), dtype=np.uint8)
    image[:, :] = colour
    ok, buffer = JPEG.imencode(".jpg", image)
    assert ok
    return bytes(buffer.tobytes())


FRAME_A = make_jpeg(colour=(30, 120, 200))
FRAME_B = make_jpeg(colour=(200, 90, 20))


def mjpeg_body(frames, boundary: bytes = b"frame", with_length: bool = True) -> bytes:
    parts = []

    for frame in frames:
        parts.append(b"--" + boundary + b"\r\n")

        if with_length:
            parts.append(b"Content-Type: image/jpeg\r\nContent-Length: " + str(len(frame)).encode() + b"\r\n\r\n")
        else:
            parts.append(b"Content-Type: image/jpeg\r\n\r\n")

        parts.append(frame + b"\r\n")

    return b"".join(parts)


# =========================================================
# FAKE ESP32-CAM HTTP SERVER
# =========================================================

class CameraHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # keep the test output clean
        pass

    def do_GET(self):  # noqa: N802 - http.server API
        path = self.path.split("?")[0]

        if path == "/stream":
            body = mjpeg_body([FRAME_A, FRAME_B])
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/capture":
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(FRAME_A)))
            self.end_headers()
            self.wfile.write(FRAME_A)
            return

        if path == "/slow":
            time.sleep(2.0)  # longer than the configured timeout
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()


@pytest.fixture
def camera_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), CameraHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    yield base

    server.shutdown()
    server.server_close()


# =========================================================
# DATABASE / SERVICE FIXTURES
# =========================================================

@pytest.fixture(autouse=True)
def fresh_state():
    Base.metadata.create_all(bind=engine)

    with SessionLocal() as db:
        db.query(Device).delete()
        db.commit()

    reset_camera_service()
    yield
    reset_camera_service()


@pytest.fixture
def client():
    return TestClient(app)


def install_camera(**env) -> CameraService:
    """Point the API at a test configuration (no real environment needed)."""

    config = CameraConfig.from_env({k: str(v) for k, v in env.items()})
    return configure_camera_service(config=config)


def add_device(ip_address="10.20.30.40", status="online", camera_ready=True):
    with SessionLocal() as db:
        device = Device(
            device_id="SG-CAM0-0001",
            hardware_uid="A0:B1:C2:03:04:05",
            name="Visionary Nexus Glasses",
            model="ESP32-CAM",
            status=status,
            ip_address=ip_address,
            camera_ready=camera_ready,
            camera_sensor="0x26",
            registered=True,
        )
        db.add(device)
        db.commit()
        db.refresh(device)
        return device.device_id


# =========================================================
# OFFLINE BEHAVIOUR - THE BACKEND MUST NOT NEED THE BOARD
# =========================================================

def test_status_is_useful_with_no_camera_configured(client):
    install_camera(CAMERA_SOURCE="auto")

    response = client.get("/api/camera/status")

    assert response.status_code == 200
    body = response.json()

    assert body["ok"] is True
    assert body["configured"] is False
    assert body["stream_url"] == ""
    assert body["url_origin"] == "none"
    assert body["reachable"] is None            # nothing checked yet
    assert body["opencv"]["available"] is True  # OpenCV is installed here
    assert any("no address configured" in note for note in body["notes"])


def test_health_reports_a_refused_connection_instead_of_crashing(client):
    install_camera(CAMERA_SOURCE="esp32", ESP32_CAM_IP="127.0.0.1", ESP32_CAM_PORT=9, ESP32_CAM_TIMEOUT=1)

    response = client.get("/api/camera/health")

    assert response.status_code == 200
    body = response.json()

    assert body["ok"] is False
    assert body["reachable"] is False
    assert "refused" in body["error"].lower() or "unreachable" in body["error"].lower()
    assert body["checked_url"].startswith("http://127.0.0.1:9")


def test_snapshot_returns_503_json_when_the_camera_is_offline(client):
    install_camera(CAMERA_SOURCE="esp32", ESP32_CAM_IP="127.0.0.1", ESP32_CAM_PORT=9, ESP32_CAM_TIMEOUT=1)

    response = client.get("/api/camera/snapshot")

    assert response.status_code == 503
    body = response.json()

    assert body["ok"] is False
    assert body["error"] == "camera_unavailable"
    assert body["detail"]


def test_snapshot_never_hangs_longer_than_the_timeout(client, camera_server):
    install_camera(
        CAMERA_SOURCE="esp32",
        ESP32_CAM_STREAM_URL=f"{camera_server}/slow",
        ESP32_CAM_SNAPSHOT_URL=f"{camera_server}/slow",
        ESP32_CAM_TIMEOUT=0.5,
    )

    started = time.monotonic()
    response = client.get("/api/camera/snapshot")
    elapsed = time.monotonic() - started

    assert response.status_code == 503
    assert elapsed < 1.6, f"snapshot took {elapsed:.2f}s, the timeout was not honoured"


def test_stream_info_reports_a_missing_host_cleanly(client):
    install_camera(CAMERA_SOURCE="auto")

    response = client.get("/api/camera/stream-info")

    assert response.status_code == 200
    body = response.json()

    assert body["ok"] is True
    assert body["stream"]["url"] == ""
    assert body["stream"]["port"] == 81
    assert body["stream"]["boundary"] == "frame"
    assert "multipart/x-mixed-replace" in body["stream"]["content_type"]


# =========================================================
# LIVE ESP32-CAM (fake server, real protocol)
# =========================================================

def test_snapshot_returns_a_real_jpeg_from_the_mjpeg_stream(client, camera_server):
    install_camera(
        CAMERA_SOURCE="esp32",
        ESP32_CAM_IP="127.0.0.1",
        ESP32_CAM_PORT=81,
        ESP32_CAM_STREAM_URL=f"{camera_server}/stream",
        ESP32_CAM_SNAPSHOT_URL=f"{camera_server}/capture",
        ESP32_CAM_TIMEOUT=2,
    )

    response = client.get("/api/camera/snapshot")

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    assert response.headers["X-Camera-Source"] == "esp32-stream"
    assert response.headers["X-Camera-Stale"] == "false"

    decoded = decode_jpeg(response.content)
    assert decoded is not None
    assert decoded.resolution == "96x64"
    assert response.headers["X-Camera-Resolution"] == "96x64"
    assert int(response.headers["X-Camera-Bytes"]) == len(FRAME_A)


def test_health_confirms_the_stream_with_a_real_frame(client, camera_server):
    install_camera(
        CAMERA_SOURCE="esp32",
        ESP32_CAM_STREAM_URL=f"{camera_server}/stream",
        ESP32_CAM_SNAPSHOT_URL=f"{camera_server}/capture",
        ESP32_CAM_TIMEOUT=2,
    )

    body = client.get("/api/camera/health").json()

    assert body["ok"] is True
    assert body["reachable"] is True
    assert body["frame"]["source"] == "esp32-stream"
    assert body["frame"]["width"] == 96
    assert body["frame"]["height"] == 64


def test_snapshot_falls_back_to_the_single_jpeg_route(client, camera_server):
    """No /stream at all: only the /capture snapshot route answers."""

    install_camera(
        CAMERA_SOURCE="esp32",
        ESP32_CAM_STREAM_URL=f"{camera_server}/missing",
        ESP32_CAM_SNAPSHOT_URL=f"{camera_server}/capture",
        ESP32_CAM_TIMEOUT=2,
    )

    response = client.get("/api/camera/snapshot")

    assert response.status_code == 200
    assert response.headers["X-Camera-Source"] == "esp32-snapshot"
    assert response.content == FRAME_A


def test_status_probes_the_board_and_reports_it_reachable(client, camera_server):
    install_camera(
        CAMERA_SOURCE="esp32",
        ESP32_CAM_STREAM_URL=f"{camera_server}/stream",
        ESP32_CAM_SNAPSHOT_URL=f"{camera_server}/capture",
        ESP32_CAM_TIMEOUT=2,
    )

    body = client.get("/api/camera/status?probe=true").json()

    assert body["reachable"] is True
    assert body["last_error"] == ""
    assert body["last_checked_at"]


def test_stream_info_reports_resolution_and_rate_after_a_capture(client, camera_server):
    install_camera(
        CAMERA_SOURCE="esp32",
        ESP32_CAM_STREAM_URL=f"{camera_server}/stream",
        ESP32_CAM_SNAPSHOT_URL=f"{camera_server}/capture",
        ESP32_CAM_TIMEOUT=2,
    )

    client.get("/api/camera/snapshot")
    client.get("/api/camera/snapshot")

    body = client.get("/api/camera/stream-info").json()

    assert body["ok"] is True
    assert body["stream"]["url"] == f"{camera_server}/stream"
    assert body["resolution"]["width"] == 96
    assert body["resolution"]["label"] == "96x64"
    assert body["frames_captured"] == 2
    assert body["fps_estimate"] > 0


def test_last_good_frame_is_served_when_the_camera_disappears(client, camera_server):
    install_camera(
        CAMERA_SOURCE="esp32",
        ESP32_CAM_STREAM_URL=f"{camera_server}/stream",
        ESP32_CAM_SNAPSHOT_URL=f"{camera_server}/capture",
        ESP32_CAM_TIMEOUT=2,
        ESP32_CAM_FRAME_MAX_AGE=60,
    )

    first = client.get("/api/camera/snapshot")
    assert first.status_code == 200
    assert first.headers["X-Camera-Stale"] == "false"

    # The board goes away: the stream stops answering.
    configure_camera_service(
        config=CameraConfig.from_env(
            {
                "CAMERA_SOURCE": "esp32",
                "ESP32_CAM_STREAM_URL": "http://127.0.0.1:9/stream",
                "ESP32_CAM_SNAPSHOT_URL": "http://127.0.0.1:9/capture",
                "ESP32_CAM_TIMEOUT": "1",
                "ESP32_CAM_FRAME_MAX_AGE": "60",
            }
        )
    )

    second = client.get("/api/camera/snapshot")

    assert second.status_code == 200
    assert second.headers["X-Camera-Stale"] == "true"
    assert second.content == FRAME_A


def test_cached_frame_expires_and_then_reports_unavailable(client, camera_server):
    install_camera(
        CAMERA_SOURCE="esp32",
        ESP32_CAM_STREAM_URL=f"{camera_server}/stream",
        ESP32_CAM_SNAPSHOT_URL=f"{camera_server}/capture",
        ESP32_CAM_TIMEOUT=2,
        ESP32_CAM_FRAME_MAX_AGE=0.2,
    )

    assert client.get("/api/camera/snapshot").status_code == 200

    configure_camera_service(
        config=CameraConfig.from_env(
            {
                "CAMERA_SOURCE": "esp32",
                "ESP32_CAM_STREAM_URL": "http://127.0.0.1:9/stream",
                "ESP32_CAM_SNAPSHOT_URL": "http://127.0.0.1:9/capture",
                "ESP32_CAM_TIMEOUT": "1",
                "ESP32_CAM_FRAME_MAX_AGE": "0.2",
            }
        )
    )

    time.sleep(0.3)

    response = client.get("/api/camera/snapshot")
    assert response.status_code == 503


# =========================================================
# PROVISIONING INTEGRATION (DHCP-SAFE ADDRESS)
# =========================================================

def test_stream_address_is_learned_from_the_device_registry(client):
    add_device(ip_address="10.20.30.40")

    install_camera(CAMERA_SOURCE="esp32", ESP32_CAM_PORT=81)  # no IP in the environment

    body = client.get("/api/camera/stream-info").json()

    assert body["stream"]["url"] == "http://10.20.30.40:81/stream"
    assert body["stream"]["url_origin"] == "device-registry"
    assert body["device"]["device_id"] == "SG-CAM0-0001"
    assert body["device"]["camera_ready"] is True
    assert any("DHCP" in note or "dhcp" in note for note in body["notes"])


def test_a_new_dhcp_lease_is_picked_up_without_any_code_change(client):
    device_id = add_device(ip_address="10.20.30.40")
    install_camera(CAMERA_SOURCE="esp32")

    assert client.get("/api/camera/status").json()["stream_url"] == "http://10.20.30.40:81/stream"

    # The board comes back on a different address and heartbeats again.
    with SessionLocal() as db:
        device = db.query(Device).filter(Device.device_id == device_id).one()
        device.ip_address = "10.20.30.99"
        db.commit()

    assert client.get("/api/camera/status").json()["stream_url"] == "http://10.20.30.99:81/stream"


def test_explicit_url_overrides_the_registry(client):
    add_device(ip_address="10.20.30.40")

    install_camera(CAMERA_SOURCE="esp32", ESP32_CAM_STREAM_URL="http://192.0.2.10:8080/live")

    body = client.get("/api/camera/status").json()

    assert body["stream_url"] == "http://192.0.2.10:8080/live"
    assert body["url_origin"] == "env"


def test_camera_endpoint_exposes_the_device_link(client):
    add_device(ip_address="10.20.30.40")

    body = client.get("/api/camera/device").json()

    assert body["linked"] is True
    assert body["device"]["camera_ready"] is True
    assert body["device"]["camera_sensor"] == "0x26"
    assert body["device"]["ip_address"] == "10.20.30.40"


def test_device_endpoint_reports_camera_state_too(client):
    """The provisioning payload keeps carrying camera truth (unchanged shape)."""

    add_device(ip_address="10.20.30.40")

    devices = client.get("/api/devices").json()["devices"]
    device = devices[0]

    assert device["camera_ready"] is True
    assert device["camera_sensor"] == "0x26"


# =========================================================
# FRAMING / DECODING EDGE CASES
# =========================================================

class FakeResponse:
    def __init__(self, body: bytes, content_type: str):
        self._body = io.BytesIO(body)
        self.headers = {"Content-Type": content_type}
        self.status = 200

    def read(self, size=-1):
        return self._body.read(size)

    def close(self):
        pass


def test_mjpeg_parts_without_content_length_are_parsed(camera_server=None):
    body = mjpeg_body([FRAME_B], with_length=False)

    def opener(request, timeout=None):
        return FakeResponse(body, "multipart/x-mixed-replace; boundary=frame")

    frame, error = read_mjpeg_frame("http://example.invalid/stream", timeout=2, opener=opener)

    assert error == ""
    assert frame == FRAME_B


def test_a_single_jpeg_response_is_accepted_as_a_frame():
    def opener(request, timeout=None):
        return FakeResponse(FRAME_A, "image/jpeg")

    frame, error = read_mjpeg_frame("http://example.invalid/stream", timeout=2, opener=opener)

    assert error == ""
    assert frame == FRAME_A


def test_a_garbage_stream_returns_an_error_not_an_exception():
    def opener(request, timeout=None):
        return FakeResponse(b"not jpeg data at all", "multipart/x-mixed-replace; boundary=frame")

    frame, error = read_mjpeg_frame("http://example.invalid/stream", timeout=2, opener=opener)

    assert frame is None
    assert error


def test_http_get_bytes_reports_errors_instead_of_raising():
    result = http_get_bytes("http://127.0.0.1:9/capture", timeout=1)

    assert result.ok is False
    assert result.error
    assert result.body == b""


def test_trim_to_jpeg_cuts_at_the_end_marker():
    padded = b"\x00\x01" + FRAME_A + b"trailing garbage"

    assert trim_to_jpeg(padded) == FRAME_A
    assert trim_to_jpeg(b"no markers here") == b""


def test_decode_jpeg_returns_none_for_non_jpeg():
    assert decode_jpeg(b"\x00\x01\x02") is None
    assert decode_jpeg(b"") is None


# =========================================================
# OPENCV IS OPTIONAL
# =========================================================

def test_frames_are_still_served_when_opencv_is_missing(client, camera_server, monkeypatch):
    monkeypatch.setattr(image_processing, "cv2", None)
    monkeypatch.setattr(image_processing, "np", None)

    install_camera(
        CAMERA_SOURCE="esp32",
        ESP32_CAM_STREAM_URL=f"{camera_server}/stream",
        ESP32_CAM_TIMEOUT=2,
    )

    status = client.get("/api/camera/status").json()
    response = client.get("/api/camera/snapshot")

    assert status["opencv"]["available"] is False
    assert any("OpenCV is not installed" in note for note in status["notes"])
    assert response.status_code == 200
    assert response.headers["X-Camera-Resolution"] == "unknown"


# =========================================================
# PC WEBCAM - OPT-IN ONLY, NEVER A SILENT REPLACEMENT
# =========================================================

def test_auto_source_never_falls_back_to_the_webcam(client):
    install_camera(CAMERA_SOURCE="auto", ESP32_CAM_IP="127.0.0.1", ESP32_CAM_PORT=9, ESP32_CAM_TIMEOUT=1)

    body = client.get("/api/camera/health").json()

    assert body["ok"] is False
    assert "webcam" not in body["error"].lower()
    assert client.get("/api/camera/status").json()["source"]["effective"] == "esp32"


class FakeVideoCapture:
    """Stands in for cv2.VideoCapture so the webcam path runs without a camera."""

    def __init__(self, index):
        self.index = index
        self.released = False
        self._frame = np.zeros((48, 64, 3), dtype=np.uint8)
        self._frame[:, :] = (10, 200, 10)

    def isOpened(self):  # noqa: N802 - OpenCV API
        return True

    def read(self):
        return True, self._frame

    def release(self):
        self.released = True


def test_webcam_source_is_opt_in_and_releases_the_device(client, monkeypatch):
    fake = FakeVideoCapture(0)

    # camera.image_capture does `import cv2` inside the function, which returns
    # the same cached module object, so patching it here covers that path too.
    monkeypatch.setattr(image_processing.cv2, "VideoCapture", lambda index: fake)

    install_camera(CAMERA_SOURCE="webcam", ESP32_CAM_WEBCAM_INDEX=0)

    body = client.get("/api/camera/health").json()
    response = client.get("/api/camera/snapshot")

    assert body["ok"] is True
    assert response.status_code == 200
    assert response.headers["X-Camera-Source"] == "webcam"
    assert response.headers["X-Camera-Resolution"] == "64x48"
    assert fake.released is True, "the VideoCapture device must always be released"


def test_webcam_reports_a_useful_error_when_it_cannot_open(client, monkeypatch):
    class ClosedCapture:
        def __init__(self, index):
            pass

        def isOpened(self):  # noqa: N802
            return False

        def release(self):
            pass

    monkeypatch.setattr(image_processing.cv2, "VideoCapture", ClosedCapture)

    install_camera(CAMERA_SOURCE="webcam")

    response = client.get("/api/camera/snapshot")

    assert response.status_code == 503
    assert "webcam" in response.json()["detail"].lower()


def test_disabled_camera_is_reported_as_disabled(client):
    install_camera(CAMERA_SOURCE="none")

    assert client.get("/api/camera/health").json()["disabled"] is True
    assert client.get("/api/camera/snapshot").status_code == 503


# =========================================================
# REGRESSION - NOTHING ELSE MOVED
# =========================================================

def test_existing_endpoints_still_answer(client):
    for path in ["/api/health", "/api/devices", "/api/conversations", "/api/music/config", "/api/camera/status"]:
        assert client.get(path).status_code == 200, path
