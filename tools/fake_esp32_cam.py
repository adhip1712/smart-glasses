#!/usr/bin/env python3
"""A fake ESP32-CAM, for developing and testing the camera pipeline with no board.

It speaks the protocol the ESP32 CameraWebServer example speaks:

    GET /stream    multipart/x-mixed-replace; boundary=frame   (MJPEG)
    GET /capture   image/jpeg                                  (one frame)
    GET /health    text/plain "ok"

Frames are generated with OpenCV (a moving colour bar plus a frame counter), so
the backend decodes a real JPEG and the UI has something that visibly moves.

Usage:

    python tools/fake_esp32_cam.py                 # 0.0.0.0:8899
    python tools/fake_esp32_cam.py --port 81       # pretend to be the board
    python tools/fake_esp32_cam.py --width 640 --height 480 --fps 10

Then point the backend at it, either:

    ESP32_CAM_STREAM_URL=http://127.0.0.1:8899/stream
    ESP32_CAM_SNAPSHOT_URL=http://127.0.0.1:8899/capture

or simply set ESP32_CAM_IP=127.0.0.1 and ESP32_CAM_PORT=8899.

This tool is development-only: it exists so the camera pipeline can be verified
end to end without the ESP32-CAM attached.
"""

import argparse
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BOUNDARY = "frame"
FRAME_INTERVAL = 0.0


def build_frame(width: int, height: int, index: int):
    """One BGR frame: a colour ramp that moves with the frame index."""

    try:
        import cv2
        import numpy as np
    except ImportError:  # pragma: no cover - dev tool
        raise SystemExit("OpenCV is required: pip install opencv-python-headless")

    image = np.zeros((height, width, 3), dtype=np.uint8)
    image[:, :] = (24, 18, 12)

    offset = (index * 8) % max(width, 1)
    image[:, :] = (40, 30, 20)

    # Moving vertical bar + a counter strip so frames are distinguishable.
    bar_width = max(width // 12, 4)
    left = offset
    image[:, left:left + bar_width] = (255, 200, 40)

    # A few static "scene" blocks.
    image[int(height * 0.15):int(height * 0.45), int(width * 0.1):int(width * 0.3)] = (60, 120, 220)
    image[int(height * 0.55):int(height * 0.85), int(width * 0.6):int(width * 0.85)] = (80, 200, 120)

    cv2.putText(
        image,
        f"FAKE ESP32-CAM  frame {index}",
        (10, height - 12),
        cv2.FONT_HERSHEY_SIMPLEX,
        max(min(width, height) / 400, 0.4),
        (230, 230, 230),
        1,
        cv2.LINE_AA,
    )

    ok, buffer = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), 80])

    if not ok:
        raise SystemExit("could not encode a JPEG frame")

    return bytes(buffer.tobytes())


class FakeCameraHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    width = 640
    height = 480
    fps = 8

    def log_message(self, fmt, *args):  # keep the console readable
        print(f"[fake-esp32-cam] {self.address_string()} {fmt % args}")

    def _jpeg(self, index: int) -> bytes:
        return build_frame(self.width, self.height, index)

    def do_GET(self):  # noqa: N802 - http.server API
        path = self.path.split("?")[0]

        if path in ("/", "/stream"):
            return self._stream()

        if path in ("/capture", "/snapshot", "/jpg"):
            frame = self._jpeg(int(time.time() * self.fps) % 1000)
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(frame)))
            self.end_headers()
            self.wfile.write(frame)
            return

        if path == "/health":
            body = b"ok"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _stream(self):
        interval = 1.0 / max(self.fps, 1)

        self.send_response(200)
        self.send_header("Content-Type", f"multipart/x-mixed-replace; boundary={BOUNDARY}")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        index = 0

        try:
            while True:
                frame = self._jpeg(index)
                part = (
                    f"--{BOUNDARY}\r\n"
                    f"Content-Type: image/jpeg\r\n"
                    f"Content-Length: {len(frame)}\r\n\r\n"
                ).encode()

                self.wfile.write(part)
                self.wfile.write(frame)
                self.wfile.write(b"\r\n")
                self.wfile.flush()

                index += 1
                time.sleep(interval)
        except (BrokenPipeError, ConnectionResetError):
            # The client took one frame and left - exactly what /snapshot does.
            return


def main():
    parser = argparse.ArgumentParser(description="Fake ESP32-CAM MJPEG server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8899)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--fps", type=int, default=8)
    args = parser.parse_args()

    FakeCameraHandler.width = args.width
    FakeCameraHandler.height = args.height
    FakeCameraHandler.fps = args.fps

    server = ThreadingHTTPServer((args.host, args.port), FakeCameraHandler)
    server.daemon_threads = True

    print(f"[fake-esp32-cam] streaming http://{args.host}:{args.port}/stream")
    print(f"[fake-esp32-cam] snapshot  http://{args.host}:{args.port}/capture")
    print("[fake-esp32-cam] Ctrl+C to stop")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
