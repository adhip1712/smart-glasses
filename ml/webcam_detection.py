# =========================================================
# VISIONARY NEXUS - LIVE WEBCAM DETECTION DEMO
# =========================================================
#
# Standalone prototype: laptop webcam -> YOLO detection -> optional tracking ->
# annotated window (or a headless console report when there is no display).
#
#   Windows   .venv\\Scripts\\python -m ml.webcam_detection
#   Linux     .venv/bin/python -m ml.webcam_detection
#
#   --list-cameras              show which camera indices open
#   --camera 1                  use a different laptop camera
#   --conf 0.35 --imgsz 416     lighter, faster inference
#   --track                     keep object ids across frames
#   --source image photo.jpg    detect in one image and exit (no camera)
#   --no-display --frames 25    headless run, prints results, exits cleanly
#
# Press Q (window) or Ctrl+C (console) to stop. The camera is released either
# way; a missing camera or model prints an actionable message and exits 1
# instead of raising a traceback.
# =========================================================

from __future__ import annotations

import argparse
import time
from typing import Any, List, Optional

from .config import ModelSettings, VisionConfigError, VisionSettings, load_settings
from .detector import ModelUnavailableError, YoloDetector
from .overlay import annotate_frame, summary_lines
from .session import VisionSession
from .webcam_source import SourceUnavailableError, list_available_cameras, open_frame_source


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ml.webcam_detection",
        description="Visionary Nexus live object detection on a laptop webcam.",
    )

    parser.add_argument("--camera", type=int, default=None, help="camera index (default 0)")
    parser.add_argument("--width", type=int, default=None, help="capture width (default 640)")
    parser.add_argument("--height", type=int, default=None, help="capture height (default 480)")
    parser.add_argument("--fps", type=int, default=None, help="capture fps (default 30)")
    parser.add_argument("--backend", default=None, help="auto | dshow | msmf | any | v4l2")
    parser.add_argument("--source", default=None, help="webcam | esp32 | auto | image | video")
    parser.add_argument(
        "path",
        nargs="?",
        default=None,
        help="file to read with --source image or --source video",
    )
    parser.add_argument("--model", default=None, help="model weights path or name")
    parser.add_argument("--conf", type=float, default=None, help="confidence threshold 0..1")
    parser.add_argument("--iou", type=float, default=None, help="NMS IoU threshold 0..1")
    parser.add_argument("--imgsz", type=int, default=None, help="inference size (default 640)")
    parser.add_argument("--device", default=None, help="cpu | cuda | auto (default cpu)")
    parser.add_argument("--track", action="store_true", help="keep object ids across frames")
    parser.add_argument("--no-track", dest="track_off", action="store_true", help="disable tracking")
    parser.add_argument("--target-fps", type=float, default=None, help="inference rate (default 8)")
    parser.add_argument("--no-display", action="store_true", help="headless: no OpenCV window")
    parser.add_argument("--frames", type=int, default=None, help="stop after N frames")
    parser.add_argument("--save-video", default=None, help="write an annotated .mp4 here")
    parser.add_argument("--quiet", action="store_true", help="print one line every N frames only")
    parser.add_argument("--list-cameras", action="store_true", help="probe camera indices and exit")

    return parser


def settings_from_args(args: argparse.Namespace, settings: VisionSettings) -> VisionSettings:
    """Apply CLI flags over the loaded config (env > json > defaults)."""

    camera = settings.camera
    model = settings.model
    worker = settings.worker

    camera_kwargs = {
        key: value
        for key, value in (
            ("index", args.camera),
            ("width", args.width),
            ("height", args.height),
            ("fps", args.fps),
            ("backend", args.backend),
            ("source", args.source if args.source in ("webcam", "esp32", "auto") else None),
        )
        if value is not None
    }

    model_kwargs = {
        key: value
        for key, value in (
            ("path", args.model),
            ("confidence", args.conf),
            ("iou", args.iou),
            ("imgsz", args.imgsz),
            ("device", args.device),
        )
        if value is not None
    }

    if args.track:
        model_kwargs["tracking"] = True
    if args.track_off:
        model_kwargs["tracking"] = False

    worker_kwargs = {"target_fps": args.target_fps} if args.target_fps else {}

    return VisionSettings(
        enabled=settings.enabled,
        camera=camera.with_overrides(**camera_kwargs) if camera_kwargs else camera,
        model=model.with_overrides(**model_kwargs) if model_kwargs else model,
        worker=worker.with_overrides(**worker_kwargs) if worker_kwargs else worker,
    )


def print_banner(settings: VisionSettings) -> None:
    print("=" * 68)
    print("  VISIONARY NEXUS - live object detection")
    print("=" * 68)
    print(f"  camera     index {settings.camera.index}, "
          f"{settings.camera.width}x{settings.camera.height}, source {settings.camera.source}")
    print(f"  model      {settings.model.path} @ {settings.model.imgsz}px, "
          f"conf >= {settings.model.confidence}, device {settings.model.resolve_device()}")
    print(f"  tracking   {'on (' + settings.model.tracker + ')' if settings.model.tracking else 'off'}")
    print(f"  rate       target {settings.worker.target_fps} FPS")
    print("=" * 68)


def run_offline_source(
    settings: VisionSettings,
    path: str,
    kind: str,
    detector: YoloDetector,
    args: argparse.Namespace,
) -> int:
    """Detect in an image or video file - useful with no camera at all."""

    try:
        import cv2
    except Exception:
        print("OpenCV is not installed, so file sources cannot be read.")
        return 1

    capture = cv2.VideoCapture(path)

    if not capture.isOpened():
        print(f"{kind} {path!r} could not be opened.")
        return 1

    writer = None
    frames = 0

    try:
        while True:
            ok, frame = capture.read()

            if not ok:
                break

            frames += 1
            result = detector.process(frame)
            annotated = annotate_frame(frame, result, inference_ms=result.inference_ms)

            print(f"frame {frames}:")
            for line in summary_lines(result):
                print(line)

            if args.save_video and writer is None:
                height, width = frame.shape[:2]
                writer = cv2.VideoWriter(
                    args.save_video, cv2.VideoWriter_fourcc(*"mp4v"), 15, (width, height)
                )

            if writer is not None:
                writer.write(annotated)

            if not args.no_display:
                cv2.imshow("Visionary Nexus", annotated)

                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break

            if args.frames and frames >= args.frames:
                break
    finally:
        capture.release()

        if writer is not None:
            writer.release()

        if not args.no_display:
            cv2.destroyAllWindows()

    print(f"\nprocessed {frames} frame(s) from {kind} {path!r}.")
    return 0


def run_live(settings: VisionSettings, args: argparse.Namespace) -> int:
    """Run the managed session against a live camera source."""

    session = VisionSession(settings)

    print_banner(settings)

    try:
        session.start()
    except SourceUnavailableError as error:
        print(f"\nCAMERA UNAVAILABLE\n  {error}\n")
        print("  Try: python -m ml.webcam_detection --list-cameras")
        return 1
    except ModelUnavailableError as error:
        print(f"\nMODEL UNAVAILABLE\n  {error}\n")
        return 1
    except VisionConfigError as error:
        print(f"\nINVALID CONFIGURATION\n  {error}\n")
        return 1

    display = not args.no_display
    writer = None

    try:
        import cv2

        if display:
            print("\n  Press Q in the window, or Ctrl+C in the console, to stop.\n")
        else:
            print("\n  Headless mode: printing results, no window.\n")
    except Exception:
        display = False

    frames = 0
    last_report = 0.0
    stopped = False

    try:
        while not stopped:
            if session.stop_requested or not session.is_running:
                break

            snapshot = session.latest()
            detections = snapshot.get("detections")

            if detections is not None:
                frames = snapshot.get("frames", 0)

                if args.frames and frames >= args.frames:
                    stopped = True

                if display and not args.quiet:
                    jpeg = session.latest_jpeg()

                    if jpeg is not None:
                        import numpy as np

                        frame = cv2.imdecode(np.frombuffer(jpeg, dtype="uint8"), cv2.IMREAD_COLOR)

                        if frame is not None:
                            cv2.imshow("Visionary Nexus", frame)

                            if cv2.waitKey(1) & 0xFF == ord("q"):
                                stopped = True

                if args.save_video:
                    jpeg = session.latest_jpeg()

                    if jpeg is not None:
                        import numpy as np

                        frame = cv2.imdecode(np.frombuffer(jpeg, dtype="uint8"), cv2.IMREAD_COLOR)

                        if frame is not None:
                            if writer is None:
                                height, width = frame.shape[:2]
                                writer = cv2.VideoWriter(
                                    args.save_video,
                                    cv2.VideoWriter_fourcc(*"mp4v"),
                                    15,
                                    (width, height),
                                )
                            writer.write(frame)

                now = time.monotonic()

                if not args.quiet and now - last_report >= 1.0:
                    last_report = now
                    print(
                        f"  frames {frames:>5} | {snapshot['fps']:5.2f} FPS | "
                        f"{snapshot['detections']['inference_ms']:6.1f} ms | "
                        f"{snapshot['detections']['count']} objects"
                    )
                    for line in summary_lines_from_payload(snapshot):
                        print(line)

            time.sleep(0.05)

    except KeyboardInterrupt:
        print("\n  stopping (Ctrl+C)...")
    finally:
        if writer is not None:
            writer.release()

        if display:
            try:
                import cv2

                cv2.destroyAllWindows()
            except Exception:
                pass

        result = session.stop()
        print(
            f"\n  stopped. camera released: {result.get('stopped')} | "
            f"frames processed: {session.latest()['frames']}"
        )

    return 0


def summary_lines_from_payload(snapshot: dict, limit: int = 5) -> List[str]:
    payload = snapshot.get("detections") or {}
    detections = payload.get("detections") or []

    if not detections:
        return ["    no objects above threshold"]

    lines = []

    for detection in detections[:limit]:
        box = detection.get("box", {})
        identity = detection.get("track_id")
        identity = f"#{identity}" if identity is not None else "--"

        lines.append(
            f"    {detection.get('label','?'):<12} {detection.get('confidence',0):5.2f}  "
            f"id {identity:<5} box ({box.get('x1',0):6.1f},{box.get('y1',0):6.1f})"
            f"-({box.get('x2',0):6.1f},{box.get('y2',0):6.1f})"
        )

    if len(detections) > limit:
        lines.append(f"    ... and {len(detections) - limit} more")

    return lines


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)

    if args.list_cameras:
        print("probing camera indices (this can take a few seconds)...")
        found = list_available_cameras()

        if not found:
            print("  no camera could be opened. Is one connected and not in use?")
            return 1

        for entry in found:
            print(f"  index {entry['index']}  backend {entry['backend']}  {entry['resolution']}")

        return 0

    try:
        settings = settings_from_args(args, load_settings())
    except VisionConfigError as error:
        print(f"invalid configuration: {error}")
        return 1

    if args.source in ("image", "video"):
        # No camera involved: useful for testing on a machine without one.
        path = args.path

        if not path:
            print(
                f"--source {args.source} needs a file path, "
                "e.g. python -m ml.webcam_detection --source image photo.jpg"
            )
            return 1

        detector = YoloDetector(settings.model)

        try:
            detector.load()
        except ModelUnavailableError as error:
            print(f"model unavailable: {error}")
            return 1

        return run_offline_source(settings, path, args.source, detector, args)

    return run_live(settings, args)


if __name__ == "__main__":
    raise SystemExit(main())
