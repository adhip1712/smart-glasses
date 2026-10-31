"""Computer vision pipeline for Visionary Nexus.

Frame flow::

    ESP32-CAM --JPEG--> FastAPI --> CameraService --> local CV --> AI vision

Design rules:

* Local engines (``pytesseract`` for OCR, ``ultralytics`` YOLO for object
  detection) are imported lazily and loaded **once**, never per frame.
* AI vision (OpenAI / Groq) is only used when a local engine cannot answer or
  when scene understanding is requested. Frames are never streamed to the AI
  provider automatically.
* When nothing is configured the API returns an honest ``success: false``
  response that explains what has to be installed or configured. Mock results
  are never presented as real detections.
"""

from __future__ import annotations

import base64
import os
import threading
from typing import Any

import httpx

CAMERA_REQUEST_TIMEOUT = 6.0
DEFAULT_OPENAI_VISION_MODEL = "gpt-4o-mini"
DEFAULT_GROQ_VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"

_lock = threading.Lock()
_detector: Any = None
_detector_loaded = False
_ocr_ready: bool | None = None


def _env(*names: str) -> str:
    for name in names:
        value = (os.getenv(name) or "").strip()
        if value:
            return value
    return ""


def configured_ai_keys() -> dict[str, bool]:
    return {
        "openai": bool(_env("OPENAI_API_KEY")),
        "groq": bool(_env("GROQ_API_KEY")),
    }


# --------------------------------------------------------------------------- #
# Frame acquisition
# --------------------------------------------------------------------------- #

def fetch_frame(device_ip: str | None = None) -> tuple[bytes | None, dict[str, Any]]:
    """Fetch one JPEG frame from the configured camera source.

    Sources, in order:

    1. ``CAMERA_STREAM_URL`` (any snapshot/JPEG URL on the LAN)
    2. an online registered ESP32-CAM (``http://<ip>/capture.jpg``)

    Returns ``(frame_bytes, info)``. ``frame_bytes`` is ``None`` when no
    camera could be reached; ``info`` always explains the outcome.
    """
    candidates: list[tuple[str, str]] = []
    stream_url = _env("CAMERA_STREAM_URL")
    if stream_url:
        candidates.append((stream_url, "configured_stream"))
    if device_ip:
        clean_ip = device_ip.strip().rstrip("/")
        if clean_ip and not clean_ip.startswith("/"):
            if clean_ip.startswith("http"):
                candidates.append((f"{clean_ip}/capture.jpg", "esp32"))
            else:
                candidates.append((f"http://{clean_ip}/capture.jpg", "esp32"))

    if not candidates:
        return None, {
            "available": False,
            "source": "none",
            "message": (
                "No camera source is configured. Register an ESP32-CAM on the LAN "
                "or set CAMERA_STREAM_URL in the backend environment."
            ),
        }

    last_error = "no source attempted"
    for url, source in candidates:
        try:
            response = httpx.get(url, timeout=CAMERA_REQUEST_TIMEOUT)
            if response.status_code != 200:
                last_error = f"{url} returned HTTP {response.status_code}"
                continue
            content_type = response.headers.get("content-type", "")
            if "jpeg" not in content_type and "image" not in content_type and len(response.content) < 128:
                last_error = f"{url} did not return an image"
                continue
            if not response.content:
                last_error = f"{url} returned an empty frame"
                continue
            return response.content, {"available": True, "source": source, "url": url, "message": "Frame captured."}
        except Exception as error:  # httpx.HTTPError and friends
            last_error = f"{url}: {error}"

    return None, {
        "available": False,
        "source": candidates[0][1],
        "message": f"Camera is unreachable ({last_error}).",
    }


def frame_to_base64(frame: bytes) -> str:
    return base64.b64encode(frame).decode("ascii")


def decode_image(image_base64: str | None, fallback: bytes | None = None) -> bytes | None:
    if image_base64:
        payload = image_base64.split(",", 1)[-1]
        try:
            decoded = base64.b64decode(payload, validate=True)
        except Exception:
            return None
        if decoded:
            return decoded
    return fallback


# --------------------------------------------------------------------------- #
# Local engines (loaded once)
# --------------------------------------------------------------------------- #

def _load_detector() -> Any | None:
    """Load the local object detector once; ``None`` when unavailable."""
    global _detector, _detector_loaded
    with _lock:
        if _detector_loaded:
            return _detector
        try:
            from ultralytics import YOLO  # type: ignore

            _detector = YOLO(os.getenv("YOLO_MODEL", "yolov8n.pt"))
        except Exception:
            _detector = None
        _detector_loaded = True
        return _detector


def _ocr_available() -> bool:
    global _ocr_ready
    with _lock:
        if _ocr_ready is not None:
            return _ocr_ready
        try:
            import pytesseract  # type: ignore
            from PIL import Image  # noqa: F401

            pytesseract.get_tesseract_version()
            _ocr_ready = True
        except Exception:
            _ocr_ready = False
        return _ocr_ready


def status() -> dict[str, Any]:
    """Report which vision engines are usable right now (no model loading)."""
    keys = configured_ai_keys()
    return {
        "local_ocr": _ocr_available() if _ocr_ready is not None else "pytesseract" in _list_modules(),
        "local_detector": _detector is not None or "ultralytics" in _list_modules(),
        "ai_vision": any(keys.values()),
        "ai_provider": "openai" if keys["openai"] else "groq" if keys["groq"] else None,
        "camera_stream_configured": bool(_env("CAMERA_STREAM_URL")),
    }


def _list_modules() -> set[str]:
    import importlib.util

    return {
        name
        for name in ("pytesseract", "ultralytics", "cv2", "PIL")
        if importlib.util.find_spec(name) is not None
    }


# --------------------------------------------------------------------------- #
# AI vision helper
# --------------------------------------------------------------------------- #

def _ai_vision_request(image: bytes, prompt: str) -> tuple[bool, str, str]:
    """Ask the configured AI provider about an image.

    Returns ``(success, engine, text)``.
    """
    encoded = frame_to_base64(image)
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{encoded}"},
                },
            ],
        }
    ]

    openai_key = _env("OPENAI_API_KEY")
    groq_key = _env("GROQ_API_KEY")

    if openai_key:
        model = _env("OPENAI_VISION_MODEL") or DEFAULT_OPENAI_VISION_MODEL
        base_url = _env("OPENAI_BASE_URL") or "https://api.openai.com/v1"
        try:
            response = httpx.post(
                f"{base_url.rstrip('/')}/chat/completions",
                headers={"Authorization": f"Bearer {openai_key}"},
                json={"model": model, "messages": messages, "max_tokens": 800},
                timeout=60.0,
            )
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            return True, "openai_vision", (content or "").strip()
        except Exception as error:
            if not groq_key:
                return False, "openai_vision", f"OpenAI vision request failed: {error}"

    if groq_key:
        model = _env("GROQ_VISION_MODEL") or DEFAULT_GROQ_VISION_MODEL
        try:
            response = httpx.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {groq_key}"},
                json={"model": model, "messages": messages, "max_tokens": 800},
                timeout=60.0,
            )
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            return True, "groq_vision", (content or "").strip()
        except Exception as error:
            return False, "groq_vision", f"Groq vision request failed: {error}"

    return False, "unavailable", (
        "AI vision is not configured. Set OPENAI_API_KEY (or GROQ_API_KEY) in the backend .env."
    )


# --------------------------------------------------------------------------- #
# Public operations
# --------------------------------------------------------------------------- #

def detect_objects(image: bytes) -> dict[str, Any]:
    """Object detection: local YOLO first, AI vision as an explicit fallback."""
    detector = _load_detector()
    if detector is not None:
        try:
            predictions = detector.predict(image, verbose=False, imgsz=416, conf=0.35, max_det=20)
            objects = []
            for prediction in predictions:
                names = prediction.names
                for box in prediction.boxes:
                    label = names.get(int(box.cls[0]), "object") if hasattr(names, "get") else str(names[int(box.cls[0])])
                    xyxy = [round(float(value), 1) for value in box.xyxy[0].tolist()]
                    objects.append(
                        {
                            "label": label,
                            "confidence": round(float(box.conf[0]) * 100, 1),
                            "box": {"x1": xyxy[0], "y1": xyxy[1], "x2": xyxy[2], "y2": xyxy[3]},
                        }
                    )
            return {
                "success": True,
                "engine": "yolo",
                "objects": objects,
                "count": len(objects),
                "message": f"Detected {len(objects)} object(s) with the local YOLO model.",
            }
        except Exception as error:
            return {
                "success": False,
                "engine": "yolo",
                "objects": [],
                "count": 0,
                "message": f"Local object detection failed: {error}",
            }

    success, engine, text = _ai_vision_request(
        image,
        "List every distinct object you can see in this image. For each object give a "
        "short label and an estimated confidence percentage. Format each line as: "
        "label - confidence%",
    )
    if not success:
        return {
            "success": False,
            "engine": engine,
            "objects": [],
            "count": 0,
            "message": text,
        }

    objects = []
    for line in text.splitlines():
        if "-" not in line:
            continue
        label, _, confidence = line.rpartition("-")
        digits = "".join(ch for ch in confidence if ch.isdigit() or ch == ".")
        if not label.strip():
            continue
        objects.append(
            {
                "label": label.strip(" *•\t").lstrip("-").strip(),
                "confidence": float(digits) if digits else 0.0,
                "box": None,
            }
        )
    return {
        "success": True,
        "engine": engine,
        "objects": objects,
        "count": len(objects),
        "description": text,
        "message": f"Detected {len(objects)} object(s) with {engine}.",
    }


def read_text(image: bytes) -> dict[str, Any]:
    """OCR: local tesseract first, AI vision as an explicit fallback."""
    if _ocr_available():
        try:
            import io

            import pytesseract  # type: ignore
            from PIL import Image  # type: ignore

            text = pytesseract.image_to_string(Image.open(io.BytesIO(image)))
            text = (text or "").strip()
            return {
                "success": bool(text),
                "engine": "tesseract",
                "text": text,
                "message": "Text recognised with the local OCR engine." if text else "No readable text was found in the frame.",
            }
        except Exception as error:
            return {"success": False, "engine": "tesseract", "text": "", "message": f"Local OCR failed: {error}"}

    success, engine, text = _ai_vision_request(
        image,
        "Transcribe all readable text in this image exactly as written. "
        "If there is no text, reply with NOTHING.",
    )
    if not success:
        return {"success": False, "engine": engine, "text": "", "message": text}

    cleaned = text.strip()
    if cleaned.upper() == "NOTHING" or not cleaned:
        return {"success": True, "engine": engine, "text": "", "message": "No readable text was found in the frame."}
    return {"success": True, "engine": engine, "text": cleaned, "message": "Text transcribed with AI vision."}


def understand_scene(image: bytes, prompt: str | None = None) -> dict[str, Any]:
    """Higher-level scene understanding (uses AI vision when configured)."""
    question = (
        prompt
        or "Describe this scene for a smart-glasses assistant: what is visible, any text, "
        "and anything the wearer should be aware of. Keep it under 120 words."
    )
    if _load_detector() is None and not _ocr_available() and not any(configured_ai_keys().values()):
        return {
            "success": False,
            "engine": "unavailable",
            "description": "",
            "message": (
                "Scene understanding is not configured. Install a local model "
                "(pip install ultralytics / pytesseract) or set OPENAI_API_KEY in the backend .env."
            ),
        }

    success, engine, text = _ai_vision_request(image, question)
    if not success:
        return {"success": False, "engine": engine, "description": "", "message": text}
    return {"success": True, "engine": engine, "description": text, "message": "Scene analyzed."}
