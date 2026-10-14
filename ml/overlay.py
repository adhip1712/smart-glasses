# =========================================================
# VISIONARY NEXUS - DETECTION OVERLAY
# =========================================================
#
# Drawing only. Takes a BGR frame and an InferenceResult, returns a BGR frame
# with boxes, labels, confidence and - when tracking is on - the track id.
#
# Shared by the standalone demo and the backend preview stream so the two can
# never drift apart. OpenCV is imported lazily and every call degrades to "no
# overlay" rather than raising: a drawing problem must never stop detection.
# =========================================================

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from .detector import Detection, InferenceResult

# Visionary Nexus palette: one stable colour per class id, so an object keeps
# its colour from frame to frame.
PALETTE: List[Tuple[int, int, int]] = [
    (0, 229, 255),    # cyan       - the Visionary Nexus accent
    (255, 176, 32),   # amber
    (146, 120, 255),  # lilac
    (96, 255, 168),   # mint
    (255, 121, 198),  # pink
    (128, 216, 255),  # sky
    (200, 255, 120),  # lime
    (255, 145, 120),  # coral
]

FONT_SCALE = 0.5
THICKNESS = 2
LABEL_HEIGHT = 18


def colour_for(class_id: int) -> Tuple[int, int, int]:
    return PALETTE[int(class_id) % len(PALETTE)]


def label_text(detection: Detection) -> str:
    """`person 0.87`, or `person #3 0.87` when a track id is known."""

    label = detection.label or f"class_{detection.class_id}"

    if detection.track_id is not None:
        return f"{label} #{detection.track_id} {detection.confidence:.2f}"

    return f"{label} {detection.confidence:.2f}"


def annotate_frame(
    frame: Any,
    result: Optional[InferenceResult] = None,
    fps: float = 0.0,
    inference_ms: float = 0.0,
    show_stats: bool = True,
) -> Any:
    """Return a copy of `frame` with detections (and optional stats) drawn."""

    try:
        import cv2
    except Exception:
        return frame

    if frame is None or not hasattr(frame, "shape"):
        return frame

    canvas = frame.copy()
    height, width = canvas.shape[:2]

    if result is not None:
        for detection in result.detections:
            _draw_detection(cv2, canvas, detection, width, height)

    if show_stats:
        _draw_stats(
            cv2,
            canvas,
            fps=fps,
            inference_ms=inference_ms or (result.inference_ms if result else 0.0),
            count=result.count if result else 0,
            width=width,
        )

    return canvas


def _draw_detection(cv2: Any, canvas: Any, detection: Detection, width: int, height: int) -> None:
    colour = colour_for(detection.class_id)

    x1 = int(max(0, min(detection.x1, width - 1)))
    y1 = int(max(0, min(detection.y1, height - 1)))
    x2 = int(max(0, min(detection.x2, width - 1)))
    y2 = int(max(0, min(detection.y2, height - 1)))

    cv2.rectangle(canvas, (x1, y1), (x2, y2), colour, THICKNESS)

    text = label_text(detection)
    (text_width, text_height), baseline = cv2.getTextSize(
        text, cv2.FONT_HERSHEY_SIMPLEX, FONT_SCALE, 1
    )

    # Put the label above the box, or inside it when there is no room above.
    label_top = y1 - text_height - baseline - 4

    if label_top < 0:
        label_top = y1 + 2

    cv2.rectangle(
        canvas,
        (x1, label_top),
        (x1 + text_width + 8, label_top + text_height + baseline + 4),
        colour,
        -1,
    )
    cv2.putText(
        canvas,
        text,
        (x1 + 4, label_top + text_height + 1),
        cv2.FONT_HERSHEY_SIMPLEX,
        FONT_SCALE,
        (12, 16, 20),
        1,
        cv2.LINE_AA,
    )


def _draw_stats(cv2: Any, canvas: Any, fps: float, inference_ms: float, count: int, width: int) -> None:
    """Draw the FPS / latency / object-count strip along the top edge."""

    text = f"{fps:4.1f} FPS   {inference_ms:6.1f} ms   {count} objects"

    (text_width, text_height), baseline = cv2.getTextSize(
        text, cv2.FONT_HERSHEY_SIMPLEX, FONT_SCALE, 1
    )

    cv2.rectangle(
        canvas,
        (0, 0),
        (text_width + 12, text_height + baseline + 10),
        (18, 22, 28),
        -1,
    )
    cv2.putText(
        canvas,
        text,
        (6, text_height + 5),
        cv2.FONT_HERSHEY_SIMPLEX,
        FONT_SCALE,
        (0, 229, 255),
        1,
        cv2.LINE_AA,
    )

    brand = "VISIONARY NEXUS"

    (brand_width, brand_height), _ = cv2.getTextSize(
        brand, cv2.FONT_HERSHEY_SIMPLEX, FONT_SCALE, 1
    )
    cv2.putText(
        canvas,
        brand,
        (max(0, width - brand_width - 8), 16),
        cv2.FONT_HERSHEY_SIMPLEX,
        FONT_SCALE,
        (0, 229, 255),
        1,
        cv2.LINE_AA,
    )


def encode_jpeg(frame: Any, quality: int = 75) -> Optional[bytes]:
    """Encode a BGR frame as JPEG bytes, or None when OpenCV is unavailable."""

    try:
        import cv2
    except Exception:
        return None

    if frame is None or not hasattr(frame, "shape"):
        return None

    quality = max(1, min(int(quality), 100))
    ok, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])

    if not ok:
        return None

    return buffer.tobytes()


def summary_lines(result: Optional[InferenceResult], limit: int = 6) -> List[str]:
    """Human-readable lines for the headless demo and the API text mode."""

    if result is None:
        return ["no inference result yet"]

    if not result.detections:
        return [f"no objects above threshold ({result.count} detections)"]

    lines: List[str] = []

    for detection in result.detections[:limit]:
        identity = f"#{detection.track_id}" if detection.track_id is not None else "--"
        lines.append(
            f"  {detection.label:<12} {detection.confidence:5.2f}  id {identity:<5} "
            f"box ({detection.x1:6.1f},{detection.y1:6.1f})-({detection.x2:6.1f},{detection.y2:6.1f})"
        )

    if result.count > limit:
        lines.append(f"  ... and {result.count - limit} more")

    return lines
