# Visionary Nexus — ML / Computer Vision

Real-time object detection on a **laptop webcam** using Python, OpenCV and
Ultralytics YOLO. No ESP32, ESP32-CAM or ESP32-S3 Sense required.

This package is **optional**: the FastAPI backend, database, authentication and
every other feature work without any of it installed. The `ml/` package only
adds frame acquisition and inference; `backend/vision_api.py` exposes it over
HTTP.

---

## 1. What is here

```
ml/
├── config.py              camera / model / worker settings (env + JSON)
├── webcam_source.py       frame sources: laptop webcam, ESP32 HTTP camera
├── detector.py            Ultralytics YOLO detection + optional tracking
├── overlay.py             bounding boxes, labels, confidence, FPS/latency
├── display.py             GUI window + a real "can this build open a window?" probe
├── doctor.py              `python -m ml.doctor` - what is ACTUALLY installed
├── session.py             ONE managed capture+inference worker
├── webcam_detection.py    standalone live demo (CLI)
└── config/ml_config.json  default settings (env vars override these)

backend/vision_api.py      /api/vision/* routes over the ml package
requirements-ml.txt        the ML dependencies (separate from the backend's)
tests/test_vision.py       123 tests, no camera and no download needed
tests/test_vision_integration.py   real Ultralytics path, auto-skipped
```

Frame acquisition is separated from inference: the detector never touches a
camera API, it receives frames from anything satisfying `FrameSource`. That is
what keeps the laptop webcam replaceable later.

---

## 2. Installation

```powershell
# from the project root, using the existing virtual environment
.venv\Scripts\pip install -r requirements-ml.txt
```

**CPU-only laptop (recommended, saves ~2 GB) — install torch first:**

```powershell
.venv\Scripts\pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
.venv\Scripts\pip install -r requirements-ml.txt
```

Linux/macOS: replace `.venv\Scripts\` with `.venv/bin/`.

Verified working versions: Ultralytics 8.4.177, torch 2.14.1, OpenCV 5.0.0,
numpy 2.4.6, lap 0.5.13.

### OpenCV must be the DESKTOP build, not the headless one

The demo opens a window with `cv2.imshow`. `opencv-python-headless` is built
with `GUI: NONE`, so **the function exists but raises when called**:

```
cv2.error: OpenCV(5.0.0) ... The function is not implemented.
Rebuild the library with Windows, GTK+ 2.x or Cocoa support.
```

`hasattr(cv2, "imshow")` returns `True` even on that build, so this cannot be
detected by checking for the function. Ultralytics itself requires
`opencv-python`, which is what `requirements-ml.txt` now installs.

Both packages install into the same `cv2` directory, so **exactly one** may be
present. If a headless build is already installed, remove it first:

```powershell
.venv\Scripts\pip uninstall -y opencv-python-headless opencv-contrib-python-headless
.venv\Scripts\pip install -r requirements-ml.txt
```

Then confirm what Python actually imports — the distribution name, the module
path, the version and real GUI support:

```powershell
.venv\Scripts\python -m ml.doctor
```

`ml.doctor` also reports the ML stack, whether the model weights are present and
which cameras open, and exits non-zero when something must be fixed.

### Headless server / CI

The backend only ever uses `cv2.imencode`, so a server may deliberately swap in
the headless build:

```bash
.venv/bin/pip uninstall -y opencv-python
.venv/bin/pip install opencv-python-headless
```

The demo then prints `NO WINDOW` with the fix and keeps running headless instead
of crashing, and `/api/vision/*` is unaffected.

### If `import cv2` fails with a missing `libGL` (Linux only)

The desktop OpenCV build needs GUI system libraries. On Debian/Ubuntu:

```bash
sudo apt-get install -y libgl1 libglib2.0-0
```

On a machine with no display at all, use the headless swap above instead.

### Model weights

`yolov8n.pt` (~6 MB, 80 COCO classes) is downloaded **once** on first run by
Ultralytics into the working directory. It is never committed (`.gitignore`
excludes `*.pt`).

Offline machine: download it elsewhere, then either drop it in the project root
or point at it:

```powershell
VISION_MODEL_PATH=C:\models\yolov8n.pt
```

Set `VISION_ALLOW_MODEL_DOWNLOAD=false` to forbid any network fetch — a missing
model then reports a clear error instead of hanging on a download.

---

## 3. Running the standalone webcam demo

```powershell
# simplest form: camera 0, yolov8n, confidence 0.4, CPU
.venv\Scripts\python -m ml.webcam_detection
```

Press **Q** in the window or **Ctrl+C** in the console. The camera is released
either way.

```powershell
# see which cameras your laptop exposes
.venv\Scripts\python -m ml.webcam_detection --list-cameras

# second camera, lighter model settings
.venv\Scripts\python -m ml.webcam_detection --camera 1 --imgsz 416 --conf 0.35

# with object tracking (stable ids across frames)
.venv\Scripts\python -m ml.webcam_detection --track

# headless: no window, prints results, exits after 25 frames
.venv\Scripts\python -m ml.webcam_detection --no-display --frames 25

# no camera at all - detect in one image or a video file
.venv\Scripts\python -m ml.webcam_detection --source image photo.jpg
.venv\Scripts\python -m ml.webcam_detection --source video clip.mp4 --frames 60
```

A missing camera or model prints an actionable message and exits `1` — it does
not raise a traceback.

---

## 4. Configuration

Settings resolve **defaults → `ml/config/ml_config.json` → environment
variables** (environment wins). Full list in `.env.example`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `VISION_ENABLED` | `true` | master switch for the vision worker |
| `VISION_SOURCE` | `webcam` | `webcam` \| `esp32` \| `auto` |
| `VISION_CAMERA_INDEX` | `0` | laptop camera index |
| `VISION_CAMERA_WIDTH` / `HEIGHT` | `640` / `480` | requested capture size |
| `VISION_CAMERA_FPS` | `30` | requested capture rate |
| `VISION_CAMERA_BACKEND` | `auto` | `auto` \| `dshow` \| `msmf` \| `any` \| `v4l2` |
| `VISION_MODEL_PATH` | `yolov8n.pt` | weights name or path |
| `VISION_CONFIDENCE` | `0.4` | detection threshold |
| `VISION_IOU` | `0.5` | NMS IoU threshold |
| `VISION_IMGSZ` | `640` | inference size (416 is faster on a laptop) |
| `VISION_DEVICE` | `cpu` | `cpu` \| `cuda` \| `auto` (falls back to CPU) |
| `VISION_MAX_DETECTIONS` | `25` | boxes kept per frame |
| `VISION_TARGET_FPS` | `8` | worker inference rate |
| `VISION_TRACKING` | `false` | keep object ids across frames |
| `VISION_TRACKER` | `bytetrack.yaml` | Ultralytics tracker config |
| `VISION_ALLOW_MODEL_DOWNLOAD` | `true` | allow fetching weights |
| `VISION_JPEG_QUALITY` | `75` | preview frame quality |
| `VISION_CAPTURE_FRAMES` | `true` | keep the latest annotated JPEG |
| `VISION_STREAM_TOKEN` | *(empty)* | **required** to serve raw frames |

On Windows `VISION_CAMERA_BACKEND=auto` tries **DirectShow → Media Foundation →
default**, because laptop cameras are unreliable through a single backend. All
failures are collected into one message instead of a generic "camera not found".

Invalid values (negative index, confidence > 1, unknown backend, …) raise
`VisionConfigError` rather than being silently ignored.

---

## 5. Backend integration

Registered in `backend/api.py` next to the existing routers. **Additive only** —
no existing route, response shape or authentication behaviour changed.

| Endpoint | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/api/vision/status` | GET | open | camera + model + worker health |
| `/api/vision/health` | GET | open | compact liveness for probes |
| `/api/vision/detections` | GET | open | latest detections as JSON |
| `/api/vision/start` | POST | token¹ | start the worker (idempotent) |
| `/api/vision/stop` | POST | token¹ | stop it, release the camera |
| `/api/vision/frame` | GET | **token** | latest annotated JPEG |
| `/api/vision/stream` | GET | **token** | MJPEG preview |

¹ enforced only when `VISION_STREAM_TOKEN` is set.

**Access policy.** The project has no user accounts yet (`backend/auth.py` is a
placeholder), so pixels are gated explicitly and **fail closed**:

- `/frame` and `/stream` answer **403** until `VISION_STREAM_TOKEN` is set, and
  **401** for a wrong token. Raw webcam frames are never served to an
  unauthenticated client.
- JSON status/health/detections contain no image data and follow the same open
  convention as the existing `/api/camera/*` routes.
- `<img>` elements cannot send headers, so the two image endpoints also accept
  `?token=`. Prefer HTTPS if you enable this.

```bash
VISION_STREAM_TOKEN=change-me   # in .env
```

```bash
# start / stop
curl -X POST localhost:8001/api/vision/start -H "Authorization: Bearer change-me"
curl -X POST localhost:8001/api/vision/stop  -H "Authorization: Bearer change-me"

# detections (no token needed, no pixels)
curl -s localhost:8001/api/vision/detections

# annotated frame
curl -o frame.jpg localhost:8001/api/vision/frame -H "Authorization: Bearer change-me"
```

### Design guarantees

- **One worker for the whole process.** No request opens a camera or loads a
  model. `start`/`stop` are idempotent and safe under concurrent calls.
- **The event loop is never blocked.** Camera opening and inference run on the
  worker thread; `start`/`stop` are dispatched through
  `run_in_threadpool`.
- **Clean shutdown.** A lifespan wrapper releases the camera when the backend
  stops; the worker thread is joined and the source closed.
- **Survives hardware trouble.** Read failures are counted, the camera is
  reopened after `reopen_after_failures`, and one bad frame never kills the
  worker.
- **Optional dependency.** If the ML extras are missing, every endpoint still
  answers with a useful body and the backend starts normally.

---

## 6. Frontend

The existing **Vision** screen was extended, not redesigned. It now shows real
camera/model/worker state, real detected labels with confidence bars, real
bounding boxes drawn from `box_normalized`, live FPS and inference latency,
**START/STOP DETECTION** controls, and clear error messages. When the worker is
off it keeps its existing simulated visuals and labels them as a preview.

`Frontend/src/api/vision.ts` is the typed client (reads never throw).

To show the annotated **video** preview, set both tokens:

```
# backend .env
VISION_STREAM_TOKEN=change-me
# Frontend/.env.local
VITE_VISION_TOKEN=change-me
```

Without `VITE_VISION_TOKEN` the screen says so explicitly and shows real
detections over its existing visuals instead of video.

Run the frontend as usual:

```powershell
cd Frontend
npm install
npm run dev
```

---

## 7. Tests

No physical camera and no model download are required:

```powershell
# the ML suite (123 tests)
.venv\Scripts\python -m pytest tests/test_vision.py -v

# everything
.venv\Scripts\python -m pytest tests/ -q
```

Coverage: config validation, camera open/read/reopen/release failures, model
load failures and missing Ultralytics, inference on mocked frames, box
clamping and sorting, detection serialization, tracking and `track_id` parsing,
overlay drawing and JPEG encoding, worker lifecycle (duplicate/concurrent
start, idempotent stop, cleanup, failures survived), API response shapes,
token policy, and the standalone CLI.

`tests/test_vision_integration.py` exercises the **real** Ultralytics path and
is skipped unless weights already exist on disk. It never downloads:

```powershell
# after placing yolov8n.pt in the project root
.venv\Scripts\python -m pytest tests/test_vision_integration.py -v
```

---

## 8. What it can and cannot recognise

The pretrained model detects the **80 COCO classes**: person, bicycle, car,
motorcycle, bus, truck, traffic light, chair, sofa, bed, dining table, laptop,
keyboard, mouse, remote, cell phone, bottle, cup, fork, knife, spoon, bowl,
banana, apple, sandwich, pizza, cake, backpack, umbrella, handbag, tie,
suitcase, book, clock, vase, scissors, toothbrush, and the rest of that set.

It does **not** recognise arbitrary objects, brand names, text, or faces
(there is a separate empty `ml/vision/face_*.py` placeholder in this
repository). A low confidence means "unsure", not "found". Raise
`VISION_CONFIDENCE` to reduce false positives.

---

## 9. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `cv2.error: The function is not implemented` | `opencv-python-headless` is installed; it has no GUI. Run `python -m ml.doctor`, then `pip uninstall -y opencv-python-headless` and `pip install opencv-python`. The demo no longer crashes on this - it prints `NO WINDOW` and continues headless. |
| No window appears, but results print | Same cause. The demo says so explicitly; install the desktop OpenCV build for a window. |
| `camera index 0 could not be opened` | Another app holds the camera, or it is the wrong index. Run `--list-cameras`; on Windows check Settings → Privacy → Camera → "Allow desktop apps". Try `VISION_CAMERA_INDEX=1` or `VISION_CAMERA_BACKEND=msmf`. |
| `returned no frames` | The device opened but delivers nothing (driver/privacy shutter). Try another backend. |
| Model download hangs | GitHub release assets unreachable. Download `yolov8n.pt` manually and set `VISION_MODEL_PATH`. |
| `Ultralytics is not installed` | `pip install -r requirements-ml.txt`. |
| Tracking fails offline with a `lap` error | Ultralytics tries to install `lap` at run time. It is listed in `requirements-ml.txt`; install it once. |
| Very low FPS | Lower `VISION_IMGSZ` to 416 or 320, raise `VISION_CONFIDENCE`, or reduce `VISION_TARGET_FPS`. |
| `/api/vision/frame` → 403 | `VISION_STREAM_TOKEN` is not set on the backend. That is intentional. |
| `/api/vision/frame` → 401 | Wrong token, or the browser has no `VITE_VISION_TOKEN`. |
| Video preview off in the UI | `VITE_VISION_TOKEN` is unset; detections are still real. |
| Boxes look shifted | The frame is letterboxed by `object-cover`; the JSON `box` values are true pixel coordinates for the reported `frame` size. |

---

## 10. Connecting a future ESP32-S3 Sense camera

The seam is `FrameSource`. Two implementations exist:

1. `WebcamSource` — the laptop camera. **Implemented and usable.**
2. `Esp32CameraSource` — frames over HTTP from an ESP32 camera server, reusing
   the existing `camera/` package (`/stream` MJPEG and `/capture`). **The HTTP
   path is implemented and tested; a physical ESP32-S3 Sense board has NOT been
   tested with it, so it is not claimed to work.** Its `describe()` reports
   `hardware_verified: false` for exactly that reason.

To use the HTTP source today:

```ini
VISION_SOURCE=esp32          # or auto: webcam first, then the HTTP camera
ESP32_CAM_IP=192.0.2.20      # or leave empty to learn it from a device heartbeat
ESP32_CAM_PORT=81
```

To add a genuinely new source (for example an RTSP or S3-Sense-specific driver):

1. Write a class with `open()`, `read()`, `close()`, `is_open`, `describe()`.
   Raise `SourceUnavailableError` if it cannot start and `FrameReadError` for a
   bad frame.
2. Register it in `open_frame_source()` in `ml/webcam_source.py`.
3. Nothing else changes: the detector, session, worker, API and UI all keep
   working, because none of them know what produced the frame.

Until an S3 Sense has actually been tested, do not describe it as supported.

---

## 11. Known limitations

- Detection quality depends on the pretrained weights; `yolov8n` is the fast,
  small model. Use `yolov8s`/`yolov8m` via `VISION_MODEL_PATH` for better
  accuracy at lower FPS.
- A single worker thread does capture **and** inference. At `VISION_TARGET_FPS=8`
  that is smooth on a laptop CPU; it is not a multi-stream design.
- Tracking ids come from ByteTrack and are only as reliable as the detections
  feeding it. A detection's position is never treated as proof of identity —
  `track_id` is `null` when the tracker has not assigned one.
- The MJPEG preview re-encodes the latest frame; it is a monitoring view, not a
  low-latency video pipeline.
