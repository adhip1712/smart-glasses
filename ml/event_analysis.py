"""Local-first event analysis for Visionary Nexus.

All routine event analysis uses local YOLO detections only. Cloud vision is
strictly opt-in via VISION_OPENAI_ENABLED=true plus OPENAI_API_KEY.
"""
from __future__ import annotations

import base64
import json
import os
import threading
import time
from collections import deque
from typing import Any, Dict, Optional

import httpx

_LOCK = threading.RLock()
_STOP = threading.Event()
_THREAD: Optional[threading.Thread] = None
_SESSION: Any = None
_EVENTS = deque(maxlen=30)
_LAST_ERROR = ""
_LAST_ANALYSIS_AT = 0.0
_LAST_ATTEMPT_AT = 0.0
_COOLDOWN_SECONDS = 12.0
_CLOUD_COOLDOWN_SECONDS = 30.0


def cloud_enabled() -> bool:
    return (os.getenv("VISION_OPENAI_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}
            and bool((os.getenv("OPENAI_API_KEY") or "").strip()))


def configured() -> bool:
    """Local event analysis is available without an API key."""
    return True


def status() -> Dict[str, Any]:
    with _LOCK:
        return {
            "enabled": True,
            "mode": "local+ollama",
            "running": bool(_THREAD and _THREAD.is_alive()),
            "cloud_enabled": False,
            "model": os.getenv("VISION_LOCAL_MODEL", "qwen3-vl:8b"),
            "cooldown_seconds": _COOLDOWN_SECONDS,
            "last_analysis_at": _LAST_ANALYSIS_AT or None,
            "last_error": _LAST_ERROR,
            "events": list(_EVENTS),
        }


def _detections(snapshot: Dict[str, Any]) -> list[dict]:
    result = snapshot.get("detections") or {}
    return result.get("detections") or []


def _local_event(snapshot: Dict[str, Any], reason: str = "manual snapshot") -> Dict[str, Any]:
    global _LAST_ANALYSIS_AT, _LAST_ERROR
    detections = _detections(snapshot)
    labels: Dict[str, int] = {}
    for detection in detections:
        label = str(detection.get("label", "object")).strip().lower() or "object"
        labels[label] = labels.get(label, 0) + 1

    person_count = labels.get("person", 0)
    if reason == "manual snapshot":
        event_type = "scene_snapshot"
        summary = (f"Local detector currently sees {person_count} person(s) and "
                   f"{len(detections)} object(s) across {len(labels)} object classes."
                   if detections else "The local detector did not detect objects above its current confidence threshold.")
    elif "person count changed" in reason:
        event_type = "person_count_changed"
        summary = f"Detected person count changed; the latest frame contains {person_count} person(s)."
    elif "object classes changed" in reason:
        event_type = "visible_objects_changed"
        summary = "The set of detected object classes changed between recent frames."
    elif "prolonged presence" in reason:
        event_type = "prolonged_presence_review"
        summary = f"A person has remained in view across multiple checks ({person_count} currently detected). This is a neutral presence notice, not a threat assessment."
    else:
        event_type = "scene_change"
        summary = "A change in locally detected objects was observed."

    event = {
        "status": "ok",
        "event_type": event_type,
        "summary": summary,
        "observable_details": [f"{label}: {count}" for label, count in sorted(labels.items())[:6]],
        "confidence": round(sum(float(d.get("confidence", 0.0) or 0.0) for d in detections) / len(detections), 3) if detections else 0.0,
        "needs_attention": False,
        "reason": reason[:160],
        "timestamp": time.time(),
        "model": "local YOLO event rules",
        "mode": "local",
    }
    with _LOCK:
        _EVENTS.appendleft(event)
        _LAST_ANALYSIS_AT = event["timestamp"]
        _LAST_ERROR = ""
    return event


def analyze_jpeg(jpeg: bytes, reason: str = "manual user request", detail: str = "high") -> Dict[str, Any]:
    """Analyze a requested photo with a local Ollama vision model (no API billing)."""
    global _LAST_ERROR
    if not jpeg:
        return {"status": "unavailable", "error": "No recent camera frame is available."}

    model = (os.getenv("VISION_LOCAL_MODEL") or "qwen3-vl:8b").strip()
    endpoint = (os.getenv("OLLAMA_HOST") or "http://127.0.0.1:11434").rstrip("/")
    encoded = base64.b64encode(jpeg).decode("ascii")
    prompt = (
        "Inspect the whole photograph carefully. Identify visible objects using distinguishing visual features, not just general outline. Do not assign a specific label unless its defining tip, head, texture, or other feature is visible. Compare plausible categories before choosing. If categories remain visually indistinguishable, say uncertain object instead of guessing. Do not invent brand, material, function, or fine detail unsupported by pixels. Report approximate position, visible color, shape, and supported features. If resolution or blur prevents reliable identification, say so. Do not identify people or infer personal traits, identity, intent, or safety "
        "threats. Return JSON only with keys event_type, summary, observable_details (array), confidence "
        "(0 to 1), and needs_attention (boolean). Keep needs_attention false unless an obvious concrete "
        "safety issue is visible. User request: " + reason
    )
    try:
        fallback_reason = ""
        candidates = [model]
        if model == "qwen3-vl:8b":
            candidates.append("qwen2.5vl:3b")
        response = None
        for candidate in candidates:
            try:
                response = httpx.post(
                    f"{endpoint}/api/chat",
                    json={
                        "model": candidate,
                        "messages": [{"role": "user", "content": prompt, "images": [encoded]}],
                        "format": "json",
                        "stream": False,
                        "keep_alive": 0,
                        "options": {"temperature": 0.1, "num_ctx": 4096},
                    },
                    timeout=httpx.Timeout(120.0, connect=3.0),
                )
                response.raise_for_status()
                model = candidate
                break
            except httpx.HTTPStatusError as exc:
                if candidate == candidates[-1]:
                    raise
                fallback_reason = f"{candidate} could not load ({exc.response.status_code}); used {candidates[-1]} instead"
        if response is None:
            raise RuntimeError("No local vision model could be started.")
        output_text = response.json().get("message", {}).get("content", "")
        parsed = json.loads(output_text)
        details = parsed.get("observable_details", [])
        event = {
            "status": "ok",
            "event_type": str(parsed.get("event_type", "scene_description"))[:48],
            "summary": str(parsed.get("summary", "Scene analysis was inconclusive."))[:500],
            "observable_details": [str(x)[:200] for x in details[:12]] if isinstance(details, list) else [],
            "confidence": max(0.0, min(1.0, float(parsed.get("confidence", 0.0)))),
            "needs_attention": bool(parsed.get("needs_attention", False)),
            "reason": reason[:160],
            "timestamp": time.time(),
            "model": model,
            "fallback_reason": fallback_reason,
            "mode": "local",
        }
        with _LOCK:
            _EVENTS.appendleft(event)
            _LAST_ANALYSIS_AT = event["timestamp"]
            _LAST_ERROR = ""
        return event
    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}"
        with _LOCK:
            _LAST_ERROR = message[:500]
        return {"status": "error", "error": message[:500],
                "hint": "Check that Ollama is running and the configured vision model is installed."}


def _monitor() -> None:
    global _LAST_ATTEMPT_AT
    previous_count: Optional[int] = None
    previous_labels: set[str] = set()
    person_seen_since: Optional[float] = None
    last_presence_event = 0.0
    last_cloud_analysis = 0.0
    while not _STOP.wait(1.0):
        session = _SESSION
        if session is None:
            continue
        try:
            snapshot = session.latest(max_age_seconds=3.0)
            if not snapshot.get("running") or snapshot.get("stale"):
                continue
            detections = _detections(snapshot)
            labels: Dict[str, int] = {}
            for detection in detections:
                label = str(detection.get("label", "object")).strip().lower() or "object"
                labels[label] = labels.get(label, 0) + 1
            count = labels.get("person", 0)
            label_set = set(labels)
            reason = ""
            now = time.time()
            if previous_count is not None and count != previous_count:
                reason = f"person count changed from {previous_count} to {count}"
            elif previous_count is not None and label_set != previous_labels:
                reason = "object classes changed"
            if count:
                if person_seen_since is None:
                    person_seen_since = now
                elif now - person_seen_since >= 30 and now - last_presence_event >= 60:
                    reason = reason or "prolonged presence review"
                    last_presence_event = now
            else:
                person_seen_since = None
            previous_count, previous_labels = count, label_set
            with _LOCK:
                due = now - _LAST_ATTEMPT_AT >= _COOLDOWN_SECONDS
                if reason and due:
                    _LAST_ATTEMPT_AT = now
            if reason and due:
                _local_event(snapshot, reason)
                if cloud_enabled() and now - last_cloud_analysis >= _CLOUD_COOLDOWN_SECONDS:
                    jpeg = session.latest_jpeg(max_age_seconds=3.0)
                    if jpeg:
                        last_cloud_analysis = now
                        analyze_jpeg(jpeg, reason)
        except Exception as exc:
            with _LOCK:
                _LAST_ERROR = f"{type(exc).__name__}: {exc}"[:500]


def start_monitor(session: Any) -> None:
    global _THREAD, _SESSION
    with _LOCK:
        _SESSION = session
        if _THREAD and _THREAD.is_alive():
            return
        _STOP.clear()
        _THREAD = threading.Thread(target=_monitor, name="nexus-vision-events", daemon=True)
        _THREAD.start()


def stop_monitor() -> None:
    global _THREAD, _SESSION
    _STOP.set()
    thread = _THREAD
    if thread and thread.is_alive():
        thread.join(timeout=2.0)
    with _LOCK:
        _THREAD = None
        _SESSION = None


def analyze_latest(session: Any, reason: str = "manual snapshot") -> Dict[str, Any]:
    """Run Qwen3-VL on one fresh frame, with YOLO detections as supporting context.

    The real-time YOLO worker remains independent and continues to own live
    detection, tracking, boxes, and FPS. This function is only called on demand.
    """
    snapshot = session.latest(max_age_seconds=3.0)
    if not snapshot.get("running") or snapshot.get("stale"):
        return {"status": "unavailable", "error": "No fresh detection result. Start detection and wait for a frame."}
    jpeg = session.latest_jpeg(max_age_seconds=3.0)
    if not jpeg:
        return {"status": "unavailable", "error": "No fresh camera image is available for Qwen3-VL."}
    detections = _detections(snapshot)
    context = []
    for item in detections[:20]:
        context.append({
            "label": str(item.get("label", "unknown"))[:80],
            "confidence": round(float(item.get("confidence", 0.0) or 0.0), 3),
            "box": item.get("box_normalized") or item.get("box"),
        })
    context_text = json.dumps(context, ensure_ascii=True)
    enriched_reason = (
        f"{reason}. YOLOv8 real-time detector context (may be incorrect; verify visually): "
        f"{context_text}. Independently inspect the pixels. Correct any mistaken YOLO labels, "
        "identify objects outside the 80 COCO classes when visually supported, and explicitly "
        "say uncertain when the image does not distinguish an object's category."
    )
    result = analyze_jpeg(jpeg, enriched_reason)
    if result.get("status") == "ok":
        result["yolo_detections"] = context
        result["fusion"] = "qwen3-vl visual analysis + YOLOv8 context; YOLO live pipeline unchanged"
    return result
