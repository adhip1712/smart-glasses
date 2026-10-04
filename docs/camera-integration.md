# ESP32-CAM → FastAPI camera pipeline

Visionary Nexus camera integration for the **AI Thinker ESP32-CAM + OV2640**
(not the ESP32-S3 Sense). The backend treats the board as optional: every
camera endpoint answers useful JSON when nothing is connected, and startup
never depends on it.

```text
ESP32-CAM (CameraWebServer, port 81)
   /stream   multipart/x-mixed-replace, boundary=frame
   /capture  one image/jpeg
        |
        v
camera/                     (repository root package)
   config.py          environment-driven configuration
   video_stream.py    bounded HTTP reads: MJPEG parts, single JPEG, TCP probe
   image_processing.py JPEG decode/encode through OpenCV (optional dependency)
   image_capture.py   one frame: stream → snapshot → (opt-in) PC webcam
   camera.py          CameraService: status / health / snapshot / stream-info
        |
        v
backend/camera_api.py       /api/camera/*  (router registered in backend/api.py)
        |
        v
React Vision screen (Frontend/src/api/camera.ts + components/Vision.tsx)
```

The `camera/` package previously existed as empty placeholders
(`camera.py`, `image_capture.py`, `image_processing.py`, `video_stream.py`)
and `tests/test_camera.py` was empty; those files are now the real
implementation and its tests. No existing route, response shape, service or
test was modified.

## Configuration

Everything is environment-driven and read once at startup (`.env` in the repo
root, see `.env.example`). Names follow the project convention.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CAMERA_SOURCE` | `auto` | `auto` \| `esp32` \| `webcam` \| `none` |
| `ESP32_CAM_IP` | *(empty)* | the board's address, e.g. `192.168.1.50` |
| `ESP32_CAM_PORT` | `81` | CameraWebServer port |
| `ESP32_CAM_STREAM_URL` | *(empty)* | full override for the MJPEG stream |
| `ESP32_CAM_SNAPSHOT_URL` | *(empty)* | full override for the single JPEG |
| `ESP32_CAM_STREAM_PATH` | `/stream` | appended to `<ip>:<port>` |
| `ESP32_CAM_SNAPSHOT_PATH` | `/capture` | appended to `<ip>:<port>` |
| `ESP32_CAM_TIMEOUT` | `4` | seconds for any camera HTTP call |
| `ESP32_CAM_MAX_FRAME_BYTES` | `2000000` | hard cap on one frame read |
| `ESP32_CAM_FRAME_MAX_AGE` | `10` | seconds a cached frame stays servable |
| `ESP32_CAM_WEBCAM_INDEX` | `0` | OpenCV device index, used only when `CAMERA_SOURCE=webcam` |

### Address resolution (DHCP-friendly)

The stream address is taken from, in order:

1. `ESP32_CAM_STREAM_URL` — explicit override, wins over everything
2. **the device registry** — the `ip_address` the board reported in its last
   heartbeat (`backend/device_api.py` stores it on the device row)
3. `ESP32_CAM_IP` — the value in `.env`

Because the registry is consulted first, a new DHCP lease is a non-event: the
next heartbeat moves the camera automatically, with no `.env` edit and no
restart. `/api/camera/status` reports which source won as `url_origin`
(`env`, `device-registry` or `configured-ip`).

The ESP32-CAM is never replaced by the PC webcam: that needs
`CAMERA_SOURCE=webcam` explicitly.

## Endpoints

| Endpoint | Purpose | Offline behaviour |
| --- | --- | --- |
| `GET /api/camera/status` | configuration, last frame, counters, OpenCV, device link | `200` JSON, `configured: false` |
| `GET /api/camera/health` | live TCP probe + one real frame | `200` JSON with `ok: false` and a readable `error` |
| `GET /api/camera/snapshot` | latest JPEG | `503` JSON, or the last good frame marked `X-Camera-Stale: true` |
| `GET /api/camera/stream-info` | stream URL, framing, resolution, measured fps | `200` JSON, empty URL |
| `GET /api/camera/device` | the device row the camera is bound to | `200` JSON, `linked: false` |

`/api/camera/snapshot` sets `Content-Type: image/jpeg` plus
`X-Camera-Source`, `X-Camera-Captured-At`, `X-Camera-Stale`,
`X-Camera-Resolution` and `X-Camera-Bytes`.

Nothing exists to duplicate: the project had no camera routes before.

## Running it

Backend (the port is environment-driven; this project's local convention is
8001):

```bash
# repository root
python -m venv .venv
.venv/bin/pip install -r backend/requirements.txt    # Windows: .venv\Scripts\pip
.venv/bin/pip install opencv-python-headless         # optional: frame decoding

# 8001, as used locally
.venv/bin/python -m uvicorn backend.api:app --host 0.0.0.0 --port 8001
```

Frontend (proxies `/api` to the backend):

```bash
cd Frontend
npm install
VITE_BACKEND_URL=http://127.0.0.1:8001 npm run dev
```

### Test without hardware (recommended first)

The repository ships a fake ESP32-CAM that speaks the real protocol:

```bash
.venv/bin/python tools/fake_esp32_cam.py --port 8899 --fps 5
```

Then, in a second terminal — either point the backend at it directly:

```bash
ESP32_CAM_STREAM_URL=http://127.0.0.1:8899/stream \
ESP32_CAM_SNAPSHOT_URL=http://127.0.0.1:8899/capture \
.venv/bin/python -m uvicorn backend.api:app --port 8001
```

or exercise the DHCP path exactly as a real board would (no camera env at all):

```bash
ESP32_CAM_PORT=8899 .venv/bin/python -m uvicorn backend.api:app --port 8001
.venv/bin/python tools/device_sim.py --backend http://127.0.0.1:8001 --claim --ip 127.0.0.1
```

### Exact commands to test the ESP32-CAM

Replace `192.168.1.50` with the board's address. First, the board itself:

```bash
# 1. is the CameraWebServer reachable on port 81?
curl -s -o /dev/null -w "%{http_code}\n" --max-time 4 http://192.168.1.50:81/health

# 2. does it stream MJPEG?  (-N = no buffering; Ctrl+C to stop)
curl -N --max-time 10 http://192.168.1.50:81/stream -o /tmp/esp32.mjpeg

# 3. does it answer with one JPEG?
curl --max-time 4 http://192.168.1.50:81/capture -o /tmp/esp32.jpg && file /tmp/esp32.jpg
```

Then the backend pipeline (with `ESP32_CAM_IP=192.168.1.50` in `.env`, or the
board heartbeating its address):

```bash
curl -s http://127.0.0.1:8001/api/camera/status
curl -s http://127.0.0.1:8001/api/camera/health
curl -s http://127.0.0.1:8001/api/camera/stream-info
curl -s -D - http://127.0.0.1:8001/api/camera/snapshot -o /tmp/backend.jpg
python -c "import cv2; print(cv2.imread('/tmp/backend.jpg').shape)"
```

A healthy board gives `/api/camera/health` → `"ok": true` with a real frame,
and `/api/camera/snapshot` → `200 image/jpeg`.

## Tests

```bash
.venv/bin/python -m pytest tests/test_camera.py -q     # 29 camera tests
.venv/bin/python -m pytest tests/ -q                   # whole suite
```

The camera tests need no hardware. They use a throw-away HTTP server that
speaks the board's exact protocol (MJPEG `/stream`, single JPEG `/capture`,
plus a slow route for timeout coverage), fake urllib openers for the framings a
socket test cannot produce (MJPEG parts without `Content-Length`), a fake
`cv2.VideoCapture` for the webcam path, and a temporary database — so they
cover: the offline paths, timeouts, stale-frame fallback and expiry, registry
and DHCP address changes, the OpenCV-optional path, the webcam opt-in rule, and
that the existing endpoints still answer.

## Troubleshooting

| Symptom | Meaning / fix |
| --- | --- |
| `refused the connection (is the ESP32-CAM on and on the same network?)` | nothing listening on `<ip>:<port>`; check the board's serial output and `ESP32_CAM_PORT` (CameraWebServer uses **81**) |
| `timed out` | wrong address, or the board is busy/rebooting; confirm with `curl --max-time 4` |
| `could not be resolved (unknown host)` | `ESP32_CAM_IP` holds a hostname the backend DNS cannot resolve |
| `503 camera_unavailable` | no frame yet and no cached frame; check `/api/camera/health` for the real reason |
| `X-Camera-Stale: true` | the board dropped out; the last good frame is being served until `ESP32_CAM_FRAME_MAX_AGE` passes |
| `OpenCV is not installed` | frames are served but not decoded; `pip install opencv-python-headless` |
| `camera not ready` (from the board's own `/capture`) | the OV2640 did not initialise — see `docs/device-lifecycle.md` and the firmware camera section |

## Still hardware-dependent

1. Flash the board (CameraWebServer example or the project firmware) and note
   the IP it prints on the serial console.
2. Confirm `/stream` and `/capture` from the machine running the backend
   (commands above) — the PC must be on the same network as the board.
3. Either set `ESP32_CAM_IP` (or `ESP32_CAM_STREAM_URL`) or let the device
   heartbeat register the address automatically.
4. Point the React Vision screen at it: it reads `/api/camera/status` and
   shows `LIVE FEED` with real frames when the board answers, and keeps the
   simulated visuals with a `SIMULATED FEED` badge otherwise.
