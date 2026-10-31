"""Read-only smoke tests for the already-running Visionary Nexus Vision API.

These tests query JSON endpoints only. They do NOT open a camera, start/stop the
vision worker, request image frames, or modify preview/configuration.
Run from the repository root:
    .venv/Scripts/python.exe tests/test_live_vision_smoke.py -v
Optional API base override:
    VISION_TEST_BASE_URL=http://127.0.0.1:8000
"""
import json
import os
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

BASE_URL = os.environ.get("VISION_TEST_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
TIMEOUT_SECONDS = 4


def get_json(path):
    url = BASE_URL + path
    try:
        with urlopen(url, timeout=TIMEOUT_SECONDS) as response:
            body = response.read().decode("utf-8")
            return response.status, json.loads(body)
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise AssertionError(f"{url} returned HTTP {exc.code}: {body[:500]}") from exc
    except URLError as exc:
        raise AssertionError(
            f"Cannot reach Vision API at {url}. Is the existing backend running? ({exc})"
        ) from exc


class LiveVisionSmokeTests(unittest.TestCase):
    """Validate current API/pipeline health without touching the camera."""

    def test_health_endpoint_reports_live_pipeline(self):
        status_code, payload = get_json("/api/vision/health")
        self.assertEqual(status_code, 200)
        self.assertTrue(payload.get("ok"), f"Health endpoint not OK: {payload}")
        self.assertTrue(payload.get("running"), f"Vision worker is not running: {payload}")
        self.assertTrue(
            payload.get("camera_open", payload.get("camera_available")),
            f"Camera is not available: {payload}",
        )
        self.assertTrue(payload.get("model_loaded"), f"Model is not loaded: {payload}")
        self.assertEqual(payload.get("errors") or [], [], f"Pipeline errors: {payload}")

    def test_detections_endpoint_returns_fresh_json_snapshot(self):
        status_code, payload = get_json("/api/vision/detections")
        self.assertEqual(status_code, 200)
        self.assertEqual(payload.get("status"), "ok", f"Detection endpoint not OK: {payload}")
        self.assertTrue(payload.get("running"), f"Vision worker is not running: {payload}")
        self.assertFalse(payload.get("stale", True), f"Latest snapshot is stale: {payload}")
        self.assertIsInstance(payload.get("detections"), list)
        for item in payload["detections"]:
            self.assertIsInstance(item, dict)
            self.assertTrue(item.get("label"), f"Detection missing label: {item}")
            confidence = item.get("confidence")
            self.assertIsInstance(confidence, (int, float), f"Bad confidence: {item}")
            self.assertGreaterEqual(confidence, 0.0)
            self.assertLessEqual(confidence, 1.0)

    def test_status_endpoint_confirms_model_and_camera_state(self):
        status_code, payload = get_json("/api/vision/status")
        self.assertEqual(status_code, 200)
        self.assertIsInstance(payload, dict)
        self.assertTrue(payload.get("running"), f"Vision worker is not running: {payload}")
        self.assertTrue(
            payload.get("camera") or payload.get("camera_open") is not None,
            f"Camera status field missing: {payload}",
        )
        self.assertTrue(
            payload.get("model") or payload.get("model_loaded") is not None,
            f"Model status field missing: {payload}",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
