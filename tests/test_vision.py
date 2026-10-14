# =========================================================
# VISIONARY NEXUS - ML / WEBCAM VISION TESTS
# =========================================================
#
# No physical camera and no model download are required anywhere in this file:
#
#   * camera opens/reads are faked at the OpenCV VideoCapture boundary
#   * the detector is driven by a fake model object that mimics the
#     Ultralytics Results/Boxes API, so box, label, confidence and track-id
#     parsing are covered without torch or weights
#   * the API is exercised through TestClient with an injected session
#
# A separate file (tests/test_vision_integration.py) covers the real Ultralytics
# path and is skipped unless the weights are present.
# =========================================================

import os
import tempfile
import threading
import time

import pytest

# Same throw-away database rule as the other suites: force it before importing
# the app so nothing here can touch smartglasses.db.
_TMP_DIR = tempfile.mkdtemp(prefix="nexus-vision-tests-")

os.environ.setdefault("DATABASE_URL", f"sqlite:///{_TMP_DIR}/vision-tests.db")
os.environ.setdefault("DEVICE_TOKEN_PEPPER", "test-pepper-do-not-use-in-production")
os.environ.setdefault("DEVICE_TOKEN_KEY", "test-key-do-not-use-in-production")

import numpy as np  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.api import app  # noqa: E402
from backend import vision_api  # noqa: E402

from ml.config import (  # noqa: E402
    CameraSettings,
    ModelSettings,
    VisionConfigError,
    VisionSettings,
    WorkerSettings,
    load_settings,
)
from ml.detector import (  # noqa: E402
    Detection,
    InferenceResult,
    ModelUnavailableError,
    YoloDetector,
)
from ml.overlay import annotate_frame, encode_jpeg, label_text, summary_lines  # noqa: E402
from ml.session import VisionSession  # noqa: E402
from ml.webcam_source import (  # noqa: E402
    Esp32CameraSource,
    FrameReadError,
    SourceUnavailableError,
    WebcamSource,
    list_available_cameras,
    open_frame_source,
)


# =========================================================
# FAKES
# =========================================================

def make_frame(width: int = 640, height: int = 480, seed: int = 0):
    return np.random.default_rng(seed).integers(0, 255, (height, width, 3), dtype=np.uint8)


class FakeCapture:
    """Stands in for cv2.VideoCapture."""

    def __init__(self, opened: bool = True, frames: int = 10, raises: bool = False, blank: bool = False):
        self.opened = opened
        self.remaining = frames
        self.raises = raises
        self.blank = blank
        self.released = 0
        self.props = {}

    def isOpened(self) -> bool:
        return self.opened

    def read(self):
        if self.raises:
            raise RuntimeError("driver exploded")

        if self.remaining <= 0:
            return False, None

        self.remaining -= 1

        if self.blank:
            return True, np.zeros((0, 0, 3), dtype=np.uint8)

        return True, make_frame()

    def set(self, prop, value):
        self.props[prop] = value
        return True

    def release(self):
        self.released += 1
        self.opened = False


class FakeBoxes:
    """Mimics ultralytics.engine.results.Boxes."""

    def __init__(self, xyxy, conf, cls, ids=None):
        self.xyxy = np.asarray(xyxy, dtype=np.float32)
        self.conf = np.asarray(conf, dtype=np.float32)
        self.cls = np.asarray(cls, dtype=np.float32)
        self.id = None if ids is None else np.asarray(ids, dtype=np.float32)


class FakeResult:
    """Mimics ultralytics.engine.results.Results."""

    names = {0: "person", 1: "bicycle", 2: "car", 63: "laptop"}

    def __init__(self, boxes):
        self.boxes = boxes


class FakeModel:
    """Mimics the subset of YOLO the detector uses, with no torch involved."""

    names = {0: "person", 1: "bicycle", 2: "car", 63: "laptop"}

    def __init__(self, boxes=None, raises=False, path=None):
        self.boxes = boxes if boxes is not None else FakeBoxes(
            [[10, 20, 100, 200], [150, 30, 300, 400]],
            [0.91, 0.42],
            [0, 63],
        )
        self.raises = raises
        self.calls = []
        self.loaded_from = path

    #: a stand-in inference cost, so latency assertions are deterministic
    WORK_SECONDS = 0.001

    def predict(self, **kwargs):
        self.calls.append(("predict", kwargs))

        if self.raises:
            raise RuntimeError("inference exploded")

        time.sleep(self.WORK_SECONDS)
        return [FakeResult(self.boxes)]

    def track(self, **kwargs):
        self.calls.append(("track", kwargs))

        if self.raises:
            raise RuntimeError("tracking exploded")

        time.sleep(self.WORK_SECONDS)
        return [FakeResult(self.boxes)]


class FakeSource:
    """Frame source with controllable failures; counts close() calls."""

    def __init__(self, fail_after=None, raise_on_open=False):
        self.is_open = False
        self.reads = 0
        self.closed = 0
        self.fail_after = fail_after
        self.raise_on_open = raise_on_open

    def open(self):
        if self.raise_on_open:
            raise SourceUnavailableError("camera index 0 could not be opened (fake)")

        self.is_open = True

    def read(self):
        self.reads += 1

        if self.fail_after is not None and self.reads > self.fail_after:
            raise FrameReadError("the camera returned no frame (fake unplug)")

        return make_frame(seed=self.reads)

    def close(self):
        self.closed += 1
        self.is_open = False

    def describe(self):
        return {"type": "fake", "is_open": self.is_open, "width": 640, "height": 480}


def fake_detector(boxes=None, **model_kwargs):
    model = FakeModel(boxes=boxes)
    settings = ModelSettings(warmup=False, **model_kwargs)
    detector = YoloDetector(settings, model_loader=lambda path: model)
    detector._model = model
    detector._classes = dict(FakeModel.names)
    return detector, model


def session_with(source=None, detector=None, **settings_kwargs):
    source = source if source is not None else FakeSource()
    settings = VisionSettings(
        enabled=True,
        camera=CameraSettings(),
        model=ModelSettings(warmup=False, **settings_kwargs.get("model", {})),
        worker=WorkerSettings(**settings_kwargs.get("worker", {})),
    )
    det = detector if detector is not None else fake_detector()[0]
    return VisionSession(settings, source_factory=lambda cfg, **k: source,
                         detector_factory=lambda: det), source, det


# =========================================================
# 1. CONFIGURATION
# =========================================================

class TestConfig:
    def test_defaults_are_laptop_friendly(self):
        settings = load_settings(env={})

        assert settings.camera.index == 0
        assert settings.camera.source == "webcam"
        assert (settings.camera.width, settings.camera.height) == (640, 480)
        assert settings.model.confidence == 0.4
        assert settings.model.tracking is False
        assert settings.worker.target_fps == 8.0

    def test_environment_overrides_json_defaults(self):
        config = {"camera": {"index": 3}, "model": {"confidence": 0.9}}
        settings = load_settings(env={"VISION_CAMERA_INDEX": "1"}, config=config)

        # env wins over the JSON file
        assert settings.camera.index == 1
        # JSON wins over the built-in default
        assert settings.model.confidence == 0.9

    def test_tracking_can_be_switched_by_env(self):
        assert load_settings(env={"VISION_TRACKING": "true"}).model.tracking is True
        assert load_settings(env={"VISION_TRACKING": "no"}).model.tracking is False

    @pytest.mark.parametrize(
        "env",
        [
            {"VISION_CAMERA_INDEX": "-1"},
            {"VISION_CAMERA_WIDTH": "0"},
            {"VISION_CAMERA_WIDTH": "abc"},
            {"VISION_CONFIDENCE": "1.5"},
            {"VISION_CONFIDENCE": "-0.1"},
            {"VISION_IOU": "2"},
            {"VISION_IMGSZ": "8"},
            {"VISION_MAX_DETECTIONS": "0"},
            {"VISION_TARGET_FPS": "0.01"},
            {"VISION_JPEG_QUALITY": "999"},
            {"VISION_SOURCE": "smart-fridge"},
            {"VISION_CAMERA_BACKEND": "carrier-pigeon"},
        ],
    )
    def test_invalid_configuration_is_rejected_not_ignored(self, env):
        with pytest.raises(VisionConfigError):
            load_settings(env=env)

    def test_malformed_json_file_is_reported(self, tmp_path):
        bad = tmp_path / "ml_config.json"
        bad.write_text("{ not json", encoding="utf-8")

        with pytest.raises(VisionConfigError):
            load_settings(env={}, config_path=bad)

    def test_windows_prefers_directshow_then_msmf(self, monkeypatch):
        monkeypatch.setattr(os, "name", "nt")

        names = [name for name, _ in CameraSettings(backend="auto").backend_candidates()]

        assert names[0] == "dshow"
        assert "msmf" in names

    def test_named_backend_is_used_alone(self):
        candidates = CameraSettings(backend="msmf").backend_candidates()

        assert len(candidates) == 1
        assert candidates[0][0] == "msmf"

    def test_resolve_device_falls_back_to_cpu(self):
        assert ModelSettings(device="cuda:0").resolve_device() == "cpu"
        assert ModelSettings(device="auto").resolve_device() == "cpu"
        assert ModelSettings(device="cpu").resolve_device() == "cpu"

    def test_model_path_may_be_a_name_or_a_file(self):
        assert ModelSettings(path="yolov8n.pt").is_weights_file is True
        assert ModelSettings(path="models/yolo11n.pt").is_weights_file is True
        assert ModelSettings(path="yolov8n").is_weights_file is False

    def test_tracking_requires_a_tracker(self):
        with pytest.raises(VisionConfigError):
            ModelSettings(tracking=True, tracker="")

    def test_settings_are_immutable(self):
        settings = load_settings(env={})

        with pytest.raises(Exception):
            settings.camera.index = 5  # type: ignore[misc]

    def test_to_dict_shape(self):
        payload = load_settings(env={}).to_dict()

        assert set(payload) == {"enabled", "camera", "model", "worker"}
        assert payload["camera"]["index"] == 0
        assert payload["model"]["confidence"] == 0.4


# =========================================================
# 2. WEBCAM SOURCE
# =========================================================

class TestWebcamSource:
    def test_opens_and_reads_a_frame(self):
        capture = FakeCapture()
        source = WebcamSource(CameraSettings(warmup_frames=1),
                              capture_factory=lambda index, flag: capture)
        source.open()

        frame = source.read()

        assert source.is_open
        assert frame.shape == (480, 640, 3)
        assert source.describe()["is_open"] is True

    def test_requests_the_configured_size(self):
        capture = FakeCapture()
        source = WebcamSource(CameraSettings(width=1280, height=720, fps=15, warmup_frames=1),
                              capture_factory=lambda index, flag: capture)
        source.open()

        assert set(capture.props.values()) >= {1280.0, 720.0, 15.0}

    def test_missing_camera_raises_a_helpful_error(self):
        source = WebcamSource(CameraSettings(), capture_factory=lambda index, flag: FakeCapture(opened=False))

        with pytest.raises(SourceUnavailableError) as info:
            source.open()

        message = str(info.value)

        assert "could not be opened" in message
        assert "VISION_CAMERA_INDEX" in message  # actionable advice

    def test_camera_that_opens_but_yields_no_frames(self):
        source = WebcamSource(
            CameraSettings(warmup_frames=2),
            capture_factory=lambda index, flag: FakeCapture(frames=0),
        )

        with pytest.raises(SourceUnavailableError) as info:
            source.open()

        assert "returned no frames" in str(info.value)

    def test_driver_exception_is_collected_not_fatal(self):
        def factory(index, flag):
            raise OSError("device busy")

        source = WebcamSource(CameraSettings(), capture_factory=factory)

        with pytest.raises(SourceUnavailableError) as info:
            source.open()

        assert "device busy" in str(info.value)

    def test_read_failure_raises_frame_read_error(self):
        # warm-up consumes one frame, so two are available: one for the
        # warm-up, one for the explicit read below.
        source = WebcamSource(CameraSettings(warmup_frames=1),
                              capture_factory=lambda index, flag: FakeCapture(frames=2))
        source.open()
        source.read()  # the last available frame

        with pytest.raises(FrameReadError):
            source.read()

    def test_read_on_a_closed_camera(self):
        source = WebcamSource(CameraSettings(), capture_factory=lambda index, flag: FakeCapture())

        with pytest.raises(FrameReadError):
            source.read()

    def test_camera_is_released_after_repeated_failures(self):
        capture = FakeCapture(frames=2)
        source = WebcamSource(
            CameraSettings(warmup_frames=1, reopen_after_failures=2),
            capture_factory=lambda index, flag: capture,
        )
        source.open()
        source.read()

        for _ in range(2):
            with pytest.raises(FrameReadError):
                source.read()

        assert capture.released == 1
        assert source.is_open is False

    def test_close_is_idempotent(self):
        capture = FakeCapture()
        source = WebcamSource(CameraSettings(warmup_frames=1),
                              capture_factory=lambda index, flag: capture)
        source.open()
        source.close()
        source.close()

        assert capture.released == 1
        assert source.is_open is False

    def test_context_manager_releases_the_camera(self):
        capture = FakeCapture()

        with WebcamSource(CameraSettings(warmup_frames=1),
                          capture_factory=lambda index, flag: capture) as source:
            source.read()

        assert capture.released == 1

    def test_measured_fps_is_computed(self):
        capture = FakeCapture(frames=20)
        source = WebcamSource(CameraSettings(warmup_frames=1),
                              capture_factory=lambda index, flag: capture)
        source.open()

        for _ in range(5):
            source.read()

        assert source.measured_fps >= 0.0

    def test_describe_reports_resolution_and_backend(self):
        source = WebcamSource(CameraSettings(warmup_frames=1, backend="any"),
                              capture_factory=lambda index, flag: FakeCapture())
        source.open()
        source.read()
        info = source.describe()

        assert info["type"] == "webcam"
        assert info["resolution"] == "640x480"
        assert info["backend"] == "any"
        assert info["index"] == 0

    def test_list_available_cameras_with_fakes(self):
        found = list_available_cameras(
            max_index=2,
            capture_factory=lambda index, flag: FakeCapture(opened=index == 1),
        )

        assert [entry["index"] for entry in found] == [1]
        assert found[0]["resolution"] == "640x480"

    def test_list_available_cameras_when_none_exist(self):
        found = list_available_cameras(max_index=1,
                                       capture_factory=lambda index, flag: FakeCapture(opened=False))

        assert found == []


# =========================================================
# 3. DETECTOR
# =========================================================

class TestDetector:
    def test_successful_inference_on_a_mocked_frame(self):
        detector, model = fake_detector()
        result = detector.detect(make_frame())

        assert result.count == 2
        assert result.tracked is False
        assert result.inference_ms > 0
        assert [d.label for d in result.detections] == ["person", "laptop"]
        assert model.calls[0][0] == "predict"

    def test_model_is_loaded_once_not_per_frame(self):
        detector, model = fake_detector()

        for _ in range(5):
            detector.detect(make_frame())

        # the loader ran zero extra times: the model object was preinstalled
        assert detector.is_loaded
        assert len(model.calls) == 5

    def test_confidence_and_settings_reach_the_model(self):
        detector, model = fake_detector(confidence=0.77, iou=0.33, imgsz=416, max_detections=7)
        detector.detect(make_frame())
        kwargs = model.calls[0][1]

        assert kwargs["conf"] == 0.77
        assert kwargs["iou"] == 0.33
        assert kwargs["imgsz"] == 416
        assert kwargs["max_det"] == 7
        assert kwargs["device"] == "cpu"
        assert kwargs["verbose"] is False

    def test_boxes_are_clamped_inside_the_frame(self):
        boxes = FakeBoxes([[-50, -20, 5000, 5000]], [0.8], [0])
        detector, _ = fake_detector(boxes=boxes)
        detection = detector.detect(make_frame(width=640, height=480)).detections[0]

        assert detection.x1 == 0
        assert detection.y1 == 0
        assert detection.x2 == 640
        assert detection.y2 == 480

    def test_detections_are_sorted_by_confidence(self):
        boxes = FakeBoxes([[0, 0, 10, 10], [0, 0, 10, 10], [0, 0, 10, 10]],
                          [0.2, 0.95, 0.5], [0, 1, 2])
        detector, _ = fake_detector(boxes=boxes)
        confidences = [d.confidence for d in detector.detect(make_frame()).detections]

        assert confidences == sorted(confidences, reverse=True)

    def test_unknown_class_id_does_not_crash(self):
        boxes = FakeBoxes([[0, 0, 10, 10]], [0.5], [999])
        detector, _ = fake_detector(boxes=boxes)
        detection = detector.detect(make_frame()).detections[0]

        assert detection.label == "class_999"

    def test_empty_result_is_valid(self):
        boxes = FakeBoxes(np.zeros((0, 4)), np.zeros((0,)), np.zeros((0,)))
        detector, _ = fake_detector(boxes=boxes)
        result = detector.detect(make_frame())

        assert result.count == 0
        assert result.labels() == {}
        assert result.to_dict()["detections"] == []

    def test_model_load_failure_raises_model_unavailable(self):
        detector = YoloDetector(ModelSettings(path="/nope/missing.pt", allow_download=False, warmup=False))

        with pytest.raises(ModelUnavailableError) as info:
            detector.load()

        assert "not found" in str(info.value)
        assert "VISION_ALLOW_MODEL_DOWNLOAD" in str(info.value)
        assert detector.is_loaded is False

    def test_loader_exception_becomes_model_unavailable(self):
        def boom(path):
            raise RuntimeError("weights are corrupt")

        detector = YoloDetector(ModelSettings(path="yolov8n.pt", warmup=False), model_loader=boom)

        with pytest.raises(ModelUnavailableError) as info:
            detector.load()

        assert "corrupt" in str(info.value)

    def test_missing_ultralytics_explains_how_to_install(self, monkeypatch):
        """Drive the real loader with the Ultralytics import made to fail."""

        import builtins

        real_import = builtins.__import__

        def blocking_import(name, *args, **kwargs):
            if name == "ultralytics" or name.startswith("ultralytics."):
                raise ImportError("No module named 'ultralytics'")

            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", blocking_import)

        detector = YoloDetector(ModelSettings(path="yolov8n.pt", warmup=False))

        with pytest.raises(ModelUnavailableError) as info:
            detector.load()

        message = str(info.value)

        assert "requirements-ml.txt" in message
        assert "Ultralytics is not installed" in message
        assert detector.is_loaded is False

    def test_second_load_call_reuses_the_model(self):
        detector, model = fake_detector()
        detector.load()
        detector.load()

        assert detector.is_loaded
        assert len(model.calls) == 0

    def test_inference_exception_is_reported_not_raised_raw(self):
        detector, model = fake_detector()
        model.raises = True

        with pytest.raises(ModelUnavailableError) as info:
            detector.detect(make_frame())

        assert "inference exploded" in str(info.value)

    def test_frame_without_dimensions_is_rejected(self):
        detector, _ = fake_detector()

        with pytest.raises(ValueError):
            detector.detect(np.zeros((0, 0, 3), dtype=np.uint8))

    def test_warmup_failure_does_not_break_loading(self):
        calls = {"n": 0}

        class WarmupModel(FakeModel):
            def predict(self, **kwargs):
                calls["n"] += 1

                if calls["n"] == 1:
                    raise RuntimeError("warm-up boom")

                return super().predict(**kwargs)

        model = WarmupModel()
        detector = YoloDetector(ModelSettings(warmup=True), model_loader=lambda path: model)
        detector.load()

        assert detector.is_loaded
        assert "warm-up" in detector.describe()["warning"]
        assert detector.detect(make_frame()).count == 2

    def test_tracking_calls_track_and_parses_ids(self):
        boxes = FakeBoxes([[0, 0, 10, 10], [20, 20, 40, 40]], [0.9, 0.8], [0, 63], [3, 7])
        detector, model = fake_detector(boxes=boxes, tracking=True)
        result = detector.track(make_frame())

        assert result.tracked is True
        assert model.calls[0][0] == "track"
        assert [d.track_id for d in result.detections] == [3, 7]
        assert all(d.tracked for d in result.detections)
        assert model.calls[0][1]["persist"] is True

    def test_detection_without_ids_reports_untracked(self):
        boxes = FakeBoxes([[0, 0, 10, 10]], [0.9], [0], None)
        detector, _ = fake_detector(boxes=boxes)
        detection = detector.track(make_frame()).detections[0]

        assert detection.track_id is None
        assert detection.tracked is False

    def test_process_follows_the_tracking_setting(self):
        detection_only, model_a = fake_detector()
        detection_only.process(make_frame())
        assert model_a.calls[0][0] == "predict"

        tracking, model_b = fake_detector(tracking=True)
        tracking.process(make_frame())
        assert model_b.calls[0][0] == "track"

    def test_reset_tracking_forces_a_fresh_persist_flag(self):
        detector, model = fake_detector(tracking=True)
        detector.track(make_frame())
        detector.reset_tracking()
        detector.track(make_frame())

        assert model.calls[0][1]["persist"] is True
        assert model.calls[1][1]["persist"] is False

    def test_average_inference_ms_is_tracked(self):
        detector, _ = fake_detector()

        for _ in range(3):
            detector.detect(make_frame())

        # the fake model does 1 ms of work, so the measurement must show it
        assert detector.average_inference_ms >= 1.0
        assert detector.last_inference_ms >= 1.0
        assert detector.describe()["inference_count"] == 3

    def test_close_releases_the_model_reference(self):
        detector, _ = fake_detector()
        detector.close()

        assert detector.is_loaded is False

    def test_describe_reports_availability_without_importing_torch(self):
        payload = fake_detector()[0].describe()

        assert set(payload) >= {
            "loaded", "available", "ultralytics_version", "path", "weights_present",
            "device", "confidence", "iou", "imgsz", "tracking", "class_count",
            "inference_count", "error", "warning",
        }
        assert payload["device"] == "cpu"
        assert payload["class_count"] == 4

    def test_weights_path_resolves_a_real_file(self, tmp_path):
        weights = tmp_path / "model.pt"
        weights.write_bytes(b"fake")
        detector = YoloDetector(ModelSettings(path=str(weights), warmup=False))

        assert detector.weights_present() is True
        assert detector.weights_path() == weights

    def test_missing_weights_are_reported(self):
        detector = YoloDetector(ModelSettings(path="/nope/absent.pt", warmup=False))

        assert detector.weights_present() is False


# =========================================================
# 4. SERIALIZATION
# =========================================================

class TestSerialization:
    def test_detection_to_dict_has_every_field_the_frontend_needs(self):
        detection = Detection(label="person", class_id=0, confidence=0.8731,
                              x1=10.5, y1=20.25, x2=110.75, y2=220.5,
                              track_id=4, frame_width=640, frame_height=480)
        payload = detection.to_dict()

        assert payload["label"] == "person"
        assert payload["confidence"] == 0.8731
        assert payload["box"] == {"x1": 10.5, "y1": 20.25, "x2": 110.75, "y2": 220.5}
        assert payload["box_normalized"] == {"x": 0.0164, "y": 0.0422, "width": 0.1566, "height": 0.4172}
        assert payload["center"] == {"x": 60.62, "y": 120.38}  # 60.625 -> banker's rounding
        assert payload["track_id"] == 4
        assert payload["tracked"] is True
        assert payload["width"] == 100.25
        assert payload["height"] == 200.25

    def test_normalized_box_is_omitted_without_frame_size(self):
        detection = Detection(label="car", class_id=2, confidence=0.5, x1=0, y1=0, x2=10, y2=10)

        assert "box_normalized" not in detection.to_dict()

    def test_inference_result_to_dict(self):
        result = InferenceResult(
            detections=[Detection(label="person", class_id=0, confidence=0.9,
                                  x1=0, y1=0, x2=10, y2=10, frame_width=640, frame_height=480)],
            inference_ms=42.123,
            frame_width=640,
            frame_height=480,
            tracked=True,
        )
        payload = result.to_dict()

        assert payload["count"] == 1
        assert payload["labels"] == {"person": 1}
        assert payload["inference_ms"] == 42.12
        assert payload["tracked"] is True
        assert payload["frame"] == {"width": 640, "height": 480}
        assert len(payload["detections"]) == 1

    def test_labels_count_repeats(self):
        result = InferenceResult(detections=[
            Detection(label="person", class_id=0, confidence=0.9, x1=0, y1=0, x2=1, y2=1),
            Detection(label="person", class_id=0, confidence=0.8, x1=0, y1=0, x2=1, y2=1),
            Detection(label="car", class_id=2, confidence=0.7, x1=0, y1=0, x2=1, y2=1),
        ])

        assert result.labels() == {"person": 2, "car": 1}

    def test_result_serializes_to_json(self):
        import json

        detector, _ = fake_detector()
        payload = detector.detect(make_frame()).to_dict()

        assert json.loads(json.dumps(payload))["count"] == 2

    def test_label_text_includes_the_track_id_when_tracked(self):
        tracked = Detection(label="person", class_id=0, confidence=0.87,
                            x1=0, y1=0, x2=1, y2=1, track_id=12)
        plain = Detection(label="person", class_id=0, confidence=0.87, x1=0, y1=0, x2=1, y2=1)

        assert label_text(tracked) == "person #12 0.87"
        assert label_text(plain) == "person 0.87"


# =========================================================
# 5. OVERLAY
# =========================================================

class TestOverlay:
    def test_annotate_returns_a_frame_of_the_same_size(self):
        detector, _ = fake_detector()
        frame = make_frame()
        annotated = annotate_frame(frame, detector.detect(frame), fps=12.5, inference_ms=30.0)

        assert annotated.shape == frame.shape

    def test_annotate_does_not_mutate_the_input(self):
        detector, _ = fake_detector()
        frame = make_frame()
        before = frame.copy()
        annotate_frame(frame, detector.detect(frame))

        assert np.array_equal(frame, before)

    def test_encode_jpeg_produces_decodable_bytes(self):
        cv2 = pytest.importorskip("cv2")
        detector, _ = fake_detector()
        frame = make_frame()
        jpeg = encode_jpeg(annotate_frame(frame, detector.detect(frame)), quality=70)

        assert jpeg is not None and len(jpeg) > 100
        assert jpeg[:2] == b"\xff\xd8"
        assert cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR).shape == frame.shape

    def test_annotate_without_a_result_still_draws_stats(self):
        annotated = annotate_frame(make_frame(), None, fps=1.0)

        assert annotated is not None

    def test_summary_lines_report_no_objects_clearly(self):
        assert "no objects above threshold" in summary_lines(
            InferenceResult(detections=[]))[0]

    def test_summary_lines_truncate(self):
        result = InferenceResult(detections=[
            Detection(label=f"object{i}", class_id=i, confidence=0.5, x1=0, y1=0, x2=1, y2=1)
            for i in range(10)
        ])
        lines = summary_lines(result, limit=3)

        assert len(lines) == 4
        assert "7 more" in lines[-1]


# =========================================================
# 6. SESSION / WORKER
# =========================================================

class TestSession:
    def test_start_produces_detections_from_a_fake_camera(self):
        session, source, _ = session_with(worker={"target_fps": 20.0})
        session.start()

        try:
            deadline = time.monotonic() + 5

            while time.monotonic() < deadline:
                snapshot = session.latest()

                if snapshot["detections"] is not None:
                    break

                time.sleep(0.05)

            snapshot = session.latest()

            assert snapshot["running"] is True
            assert snapshot["frames"] >= 1
            assert snapshot["detections"]["count"] == 2
            assert source.is_open is True
        finally:
            session.stop()

    def test_duplicate_start_does_not_create_a_second_worker(self):
        session, _, _ = session_with()
        first = session.start()
        thread = session._state.thread
        second = session.start()

        try:
            assert first["already_running"] is False
            assert second["already_running"] is True
            assert session._state.thread is thread
        finally:
            session.stop()

    def test_concurrent_starts_are_safe(self):
        session, _, _ = session_with()
        results = []

        def go():
            results.append(session.start())

        threads = [threading.Thread(target=go) for _ in range(6)]

        for thread in threads:
            thread.start()

        for thread in threads:
            thread.join()

        try:
            assert sum(1 for r in results if r["already_running"] is False) == 1
        finally:
            session.stop()

    def test_stop_is_idempotent_and_releases_the_camera(self):
        session, source, _ = session_with()
        session.start()

        assert session.stop()["was_running"] is True
        assert session.stop()["was_running"] is False
        assert source.closed == 1
        assert session.is_running is False

    def test_stop_without_start_is_safe(self):
        session, source, _ = session_with()

        assert session.stop() == {"stopped": True, "was_running": False}
        assert source.closed == 0

    def test_restart_after_stop_works(self):
        session, source, _ = session_with(worker={"target_fps": 20.0})
        session.start()
        session.stop()
        session.start()

        try:
            assert session.is_running is True
        finally:
            session.stop()

    def test_camera_read_failures_do_not_kill_the_worker(self):
        source = FakeSource(fail_after=2)
        session, _, _ = session_with(source=source, worker={"target_fps": 30.0})
        session.start()

        try:
            time.sleep(0.5)
            snapshot = session.latest()

            assert session.is_running is True
            assert snapshot["camera_error"]
            assert "no frame" in snapshot["camera_error"]
        finally:
            session.stop()

    def test_camera_is_reopened_after_repeated_failures(self):
        source = FakeSource(fail_after=1)
        session, _, _ = session_with(
            source=source,
            worker={"target_fps": 30.0},
            model={},
        )
        session.settings = VisionSettings(
            enabled=True,
            camera=CameraSettings(reopen_after_failures=3),
            model=session.settings.model,
            worker=session.settings.worker,
        )
        session.start()

        try:
            time.sleep(0.6)
        finally:
            session.stop()

        # reopening released the old source at least once
        assert source.closed >= 1

    def test_missing_camera_raises_and_starts_no_thread(self):
        session, _, _ = session_with(source=FakeSource(raise_on_open=True))

        with pytest.raises(SourceUnavailableError):
            session.start()

        assert session.is_running is False

    def test_model_failure_releases_the_camera(self):
        source = FakeSource()

        def failing_detector():
            detector = YoloDetector(ModelSettings(path="/nope/missing.pt", allow_download=False, warmup=False))
            return detector

        settings = VisionSettings(
            enabled=True,
            camera=CameraSettings(),
            model=ModelSettings(path="/nope/missing.pt", allow_download=False, warmup=False),
            worker=WorkerSettings(target_fps=20.0),
        )
        session = VisionSession(settings, source_factory=lambda cfg, **k: source,
                                detector_factory=failing_detector)

        with pytest.raises(ModelUnavailableError):
            session.start()

        assert session.is_running is False
        assert source.closed == 1

    def test_disabled_session_refuses_to_start(self):
        session, _, _ = session_with()
        session.settings = VisionSettings(
            enabled=False, camera=CameraSettings(),
            model=session.settings.model, worker=session.settings.worker,
        )
        result = session.start()

        assert result["started"] is False
        assert "disabled" in result["error"]

    def test_jpeg_preview_is_kept_for_streaming(self):
        session, _, _ = session_with(worker={"target_fps": 20.0, "jpeg_quality": 60})
        session.start()

        try:
            deadline = time.monotonic() + 5

            while time.monotonic() < deadline and session.latest_jpeg() is None:
                time.sleep(0.05)

            jpeg = session.latest_jpeg()

            assert jpeg is not None
            assert jpeg[:2] == b"\xff\xd8"
        finally:
            session.stop()

    def test_stale_results_are_flagged(self):
        session, _, _ = session_with(worker={"target_fps": 20.0})
        session.start()
        time.sleep(0.3)
        session.stop()

        payload = session.latest(max_age_seconds=0.0001)

        assert payload["stale"] is True

    def test_status_payload_reports_every_subsystem(self):
        session, source, _ = session_with(worker={"target_fps": 20.0})
        session.start()

        try:
            time.sleep(0.3)
            status = session.status()

            assert status["running"] is True
            assert status["camera_available"] is True
            assert status["model_loaded"] is True
            assert status["tracking"] is False
            assert status["errors"] == []
            assert "camera" in status and "model" in status and "worker" in status["configured"]
        finally:
            session.stop()

    def test_close_shuts_everything_down(self):
        session, source, detector = session_with()
        session.start()
        session.close()

        assert session.is_running is False
        assert source.closed == 1
        assert detector.is_loaded is False

    def test_device_lookup_is_handed_to_the_source_factory(self):
        seen = {}

        def factory(config, **kwargs):
            seen.update(kwargs)
            source = FakeSource()
            source.open()
            return source

        settings = VisionSettings(enabled=True, camera=CameraSettings(),
                                  model=ModelSettings(warmup=False), worker=WorkerSettings())
        session = VisionSession(settings, source_factory=factory,
                                detector_factory=lambda: fake_detector()[0])
        session.set_device_lookup(lambda: {"ip_address": "192.0.2.7"})
        session.start()
        session.stop()

        assert callable(seen.get("device_lookup"))


# =========================================================
# 7. SOURCE FACTORY / HARDWARE SEAM
# =========================================================

class TestSourceFactory:
    def test_webcam_source_is_the_default(self):
        settings = VisionSettings(enabled=True, camera=CameraSettings(source="webcam"),
                                  model=ModelSettings(), worker=WorkerSettings())
        source = open_frame_source(settings, capture_factory=lambda index, flag: FakeCapture())

        assert source.describe()["type"] == "webcam"
        source.close()

    def test_esp32_source_requires_an_address(self):
        from camera.config import CameraConfig

        settings = VisionSettings(enabled=True, camera=CameraSettings(source="esp32"),
                                  model=ModelSettings(), worker=WorkerSettings())

        with pytest.raises(SourceUnavailableError) as info:
            open_frame_source(settings, camera_config=CameraConfig.from_env(
                {"ESP32_CAM_IP": "", "ESP32_CAM_STREAM_URL": "", "ESP32_CAM_SNAPSHOT_URL": ""}))

        assert "no ESP32 camera address" in str(info.value)

    def test_auto_falls_back_to_the_esp32_source(self, monkeypatch):
        from camera.config import CameraConfig

        settings = VisionSettings(enabled=True, camera=CameraSettings(source="auto"),
                                  model=ModelSettings(), worker=WorkerSettings())

        monkeypatch.setattr(
            "ml.webcam_source.WebcamSource.open",
            lambda self: (_ for _ in ()).throw(SourceUnavailableError("no laptop camera")),
        )

        source = open_frame_source(
            settings,
            camera_config=CameraConfig.from_env({"ESP32_CAM_IP": "192.0.2.9", "ESP32_CAM_PORT": "81"}),
        )

        assert source.describe()["type"] == "esp32-camera"
        assert "192.0.2.9" in source.describe()["url"]
        source.close()

    def test_auto_reports_both_failures(self, monkeypatch):
        settings = VisionSettings(enabled=True, camera=CameraSettings(source="auto"),
                                  model=ModelSettings(), worker=WorkerSettings())

        monkeypatch.setattr(
            "ml.webcam_source.WebcamSource.open",
            lambda self: (_ for _ in ()).throw(SourceUnavailableError("webcam gone")),
        )
        monkeypatch.setattr(
            "ml.webcam_source.Esp32CameraSource.open",
            lambda self: (_ for _ in ()).throw(SourceUnavailableError("board gone")),
        )

        with pytest.raises(SourceUnavailableError) as info:
            open_frame_source(settings)

        assert "webcam gone" in str(info.value)
        assert "board gone" in str(info.value)

    def test_unknown_source_is_rejected_by_the_settings(self):
        with pytest.raises(VisionConfigError):
            CameraSettings(source="smart-fridge")

    def test_valid_sources_are_accepted(self):
        for source in ("webcam", "esp32", "auto"):
            assert CameraSettings(source=source).source == source

    def test_esp32_source_is_not_claimed_as_hardware_verified(self):
        source = Esp32CameraSource(CameraSettings(source="esp32"))
        info = source.describe()

        assert info["hardware_verified"] is False
        assert "not been tested" in info["note"]

    def test_detector_does_not_import_the_camera_api(self):
        """The detector must stay independent of frame acquisition."""

        import inspect
        import ml.detector as detector_module

        source = inspect.getsource(detector_module)

        assert "VideoCapture" not in source
        assert "webcam_source" not in source


# =========================================================
# 8. API
# =========================================================

class TestVisionApi:
    @pytest.fixture()
    def client(self):
        with TestClient(app) as test_client:
            yield test_client

    @pytest.fixture()
    def fake_session(self):
        """Inject a session so the API tests never touch a camera or a model."""

        session, source, _ = session_with(worker={"target_fps": 20.0})
        previous = vision_api._SESSION
        vision_api.set_session(session)

        yield session

        vision_api.set_session(previous)

    def test_status_answers_without_starting_anything(self, client):
        payload = client.get("/api/vision/status").json()

        assert payload["running"] is False
        assert payload["ml_available"] is True
        assert "camera" in payload and "model" in payload

    def test_health_reports_subsystems(self, client):
        payload = client.get("/api/vision/health").json()

        assert payload["ok"] is False
        assert payload["running"] is False
        assert "model_loaded" in payload
        assert "camera_available" in payload

    def test_detections_reports_no_result_when_stopped(self, client, fake_session):
        payload = client.get("/api/vision/detections").json()

        assert payload["status"] == "no_result"
        assert payload["count"] == 0
        assert payload["detections"] == []

    def test_detections_returns_boxes_after_start(self, client, fake_session):
        fake_session.start()

        try:
            deadline = time.monotonic() + 5

            while time.monotonic() < deadline:
                payload = client.get("/api/vision/detections").json()

                if payload["status"] == "ok":
                    break

                time.sleep(0.05)

            assert payload["status"] == "ok"
            assert payload["count"] == 2
            assert payload["labels"] == {"person": 1, "laptop": 1}
            first = payload["detections"][0]

            assert set(first) >= {"label", "confidence", "box", "center", "track_id", "tracked"}
            assert set(first["box"]) == {"x1", "y1", "x2", "y2"}
        finally:
            fake_session.stop()

    def test_detections_can_omit_boxes(self, client, fake_session):
        fake_session.start()

        try:
            deadline = time.monotonic() + 5

            while time.monotonic() < deadline:
                payload = client.get("/api/vision/detections?include_boxes=false").json()

                if payload["status"] == "ok":
                    break

                time.sleep(0.05)

            first = payload["detections"][0]

            assert "box" not in first
            assert "label" in first
        finally:
            fake_session.stop()

    def test_start_and_stop_through_the_api(self, client, fake_session):
        started = client.post("/api/vision/start")

        assert started.status_code == 200
        assert started.json()["started"] is True
        assert fake_session.is_running is True

        again = client.post("/api/vision/start")

        assert again.json()["already_running"] is True

        stopped = client.post("/api/vision/stop")

        assert stopped.status_code == 200
        assert fake_session.is_running is False

        again = client.post("/api/vision/stop")

        assert again.status_code == 200
        assert again.json()["was_running"] is False

    def test_frames_are_refused_without_a_configured_token(self, client, monkeypatch):
        monkeypatch.delenv("VISION_STREAM_TOKEN", raising=False)

        frame = client.get("/api/vision/frame")
        stream = client.get("/api/vision/stream")

        assert frame.status_code == 403
        assert "VISION_STREAM_TOKEN" in frame.json()["error"]
        assert stream.status_code == 403

    def test_frames_require_the_token_when_one_is_configured(self, client, monkeypatch):
        monkeypatch.setenv("VISION_STREAM_TOKEN", "secret-token")

        assert client.get("/api/vision/frame").status_code == 401
        assert client.get("/api/vision/stream").status_code == 401

    def test_frames_are_served_with_a_valid_token(self, client, fake_session, monkeypatch):
        monkeypatch.setenv("VISION_STREAM_TOKEN", "secret-token")
        fake_session.start()

        try:
            deadline = time.monotonic() + 5

            while time.monotonic() < deadline and fake_session.latest_jpeg() is None:
                time.sleep(0.05)

            response = client.get(
                "/api/vision/frame", headers={"Authorization": "Bearer secret-token"}
            )

            assert response.status_code == 200
            assert response.headers["content-type"] == "image/jpeg"
            assert response.content[:2] == b"\xff\xd8"
        finally:
            fake_session.stop()

    def test_start_is_protected_when_a_token_is_configured(self, client, fake_session, monkeypatch):
        monkeypatch.setenv("VISION_STREAM_TOKEN", "secret-token")

        assert client.post("/api/vision/start").status_code == 401

        authorized = client.post(
            "/api/vision/start", headers={"X-Vision-Token": "secret-token"}
        )

        assert authorized.status_code == 200
        fake_session.stop()

    def test_frames_accept_a_query_token_for_img_clients(self, client, fake_session, monkeypatch):
        """A browser <img> cannot send headers, so the image endpoints take ?token=."""

        monkeypatch.setenv("VISION_STREAM_TOKEN", "secret-token")
        fake_session.start()

        try:
            deadline = time.monotonic() + 5

            while time.monotonic() < deadline and fake_session.latest_jpeg() is None:
                time.sleep(0.05)

            assert client.get("/api/vision/frame?token=secret-token").status_code == 200
            assert client.get("/api/vision/frame?token=wrong").status_code == 401
            assert client.get("/api/vision/frame").status_code == 401
        finally:
            fake_session.stop()

    def test_query_token_does_not_authorize_start_or_stop(self, client, fake_session, monkeypatch):
        monkeypatch.setenv("VISION_STREAM_TOKEN", "secret-token")

        assert client.post("/api/vision/start?token=secret-token").status_code == 401
        assert client.post("/api/vision/stop?token=secret-token").status_code == 401

    def test_stream_reports_when_the_worker_is_stopped(self, client, fake_session, monkeypatch):
        monkeypatch.setenv("VISION_STREAM_TOKEN", "secret-token")
        fake_session.settings = VisionSettings(
            enabled=True,
            camera=fake_session.settings.camera,
            model=fake_session.settings.model,
            worker=WorkerSettings(target_fps=20.0, capture_frames=False),
        )

        response = client.get(
            "/api/vision/frame", headers={"Authorization": "Bearer secret-token"}
        )

        assert response.status_code == 503
        assert "vision worker" in response.json()["error"]

    def test_start_reports_a_missing_camera_as_503(self, client, monkeypatch):
        source = FakeSource(raise_on_open=True)
        session, _, _ = session_with(source=source)
        previous = vision_api._SESSION
        vision_api.set_session(session)

        try:
            response = client.post("/api/vision/start")

            assert response.status_code == 503
            assert "camera unavailable" in response.json()["error"]
            assert session.is_running is False
        finally:
            vision_api.set_session(previous)

    def test_endpoints_answer_when_the_ml_package_is_missing(self, client, monkeypatch):
        previous_session = vision_api._SESSION
        previous_class = vision_api.VisionSession
        previous_error = vision_api.ML_IMPORT_ERROR

        vision_api._SESSION = None
        vision_api.VisionSession = None
        vision_api.ML_IMPORT_ERROR = "ModuleNotFoundError: No module named 'numpy'"

        try:
            status = client.get("/api/vision/status")
            health = client.get("/api/vision/health")
            detections = client.get("/api/vision/detections")
            start = client.post("/api/vision/start")

            assert status.status_code == 200
            assert status.json()["ml_available"] is False
            assert health.status_code == 200
            assert health.json()["ok"] is False
            assert health.json()["reason"] == "ml_package_missing"
            assert detections.status_code == 503
            assert start.status_code == 503
            assert "requirements-ml.txt" in start.json()["error"]
        finally:
            vision_api._SESSION = previous_session
            vision_api.VisionSession = previous_class
            vision_api.ML_IMPORT_ERROR = previous_error

    def test_shutdown_handler_releases_the_camera(self, fake_session):
        fake_session.start()
        assert fake_session.is_running is True

        vision_api.shutdown_vision()

        assert fake_session.is_running is False

    def test_shutdown_without_a_session_is_safe(self, monkeypatch):
        previous = vision_api._SESSION
        vision_api.set_session(None)

        try:
            vision_api.shutdown_vision()  # must not raise
        finally:
            vision_api.set_session(previous)

    # -- regression: nothing existing was broken -------------------------

    def test_existing_routes_still_respond(self, client):
        for path in ("/api/health", "/api/camera/status", "/api/camera/stream-info", "/api/devices"):
            assert client.get(path).status_code == 200, path

    def test_camera_snapshot_route_is_untouched(self, client):
        payload = client.get("/api/camera/status").json()

        assert "source" in payload
        assert "configured" in payload


# =========================================================
# 9. STANDALONE DEMO (no camera, no display)
# =========================================================

class TestDemoCli:
    def test_list_cameras_exits_cleanly_with_fakes(self, monkeypatch, capsys):
        from ml import webcam_detection

        monkeypatch.setattr(
            webcam_detection,
            "list_available_cameras",
            lambda *a, **k: [{"index": 0, "backend": "any", "resolution": "640x480"}],
        )

        assert webcam_detection.main(["--list-cameras"]) == 0
        assert "index 0" in capsys.readouterr().out

    def test_list_cameras_reports_when_none_are_found(self, monkeypatch, capsys):
        from ml import webcam_detection

        monkeypatch.setattr(webcam_detection, "list_available_cameras", lambda *a, **k: [])

        assert webcam_detection.main(["--list-cameras"]) == 1
        assert "no camera" in capsys.readouterr().out

    def test_invalid_configuration_exits_with_a_message(self, monkeypatch, capsys):
        from ml import webcam_detection

        monkeypatch.setenv("VISION_CAMERA_INDEX", "-3")

        assert webcam_detection.main([]) == 1
        assert "invalid configuration" in capsys.readouterr().out

    def test_missing_camera_prints_advice_instead_of_a_traceback(self, monkeypatch, capsys):
        from ml import webcam_detection

        monkeypatch.setattr(
            "ml.session.open_frame_source",
            lambda settings, **kwargs: (_ for _ in ()).throw(
                SourceUnavailableError("camera index 0 could not be opened")
            ),
        )

        assert webcam_detection.main(["--no-display"]) == 1

        output = capsys.readouterr().out

        assert "CAMERA UNAVAILABLE" in output
        assert "--list-cameras" in output

    def test_missing_model_prints_advice(self, monkeypatch, capsys):
        from ml import webcam_detection

        monkeypatch.setenv("VISION_MODEL_PATH", "/nope/absent.pt")
        monkeypatch.setenv("VISION_ALLOW_MODEL_DOWNLOAD", "false")
        monkeypatch.setattr(
            "ml.session.open_frame_source",
            lambda settings, **kwargs: (lambda s: (s.open(), s)[1])(FakeSource()),
        )

        assert webcam_detection.main(["--no-display"]) == 1
        assert "MODEL UNAVAILABLE" in capsys.readouterr().out

    def test_cli_flags_override_the_config(self):
        from ml.webcam_detection import build_parser, settings_from_args

        args = build_parser().parse_args(
            ["--camera", "2", "--width", "1280", "--conf", "0.25", "--imgsz", "416", "--track"]
        )
        settings = settings_from_args(args, load_settings(env={}))

        assert settings.camera.index == 2
        assert settings.camera.width == 1280
        assert settings.model.confidence == 0.25
        assert settings.model.imgsz == 416
        assert settings.model.tracking is True

    def test_no_track_flag_disables_tracking(self):
        from ml.webcam_detection import build_parser, settings_from_args

        args = build_parser().parse_args(["--no-track"])
        settings = settings_from_args(args, load_settings(env={"VISION_TRACKING": "true"}))

        assert settings.model.tracking is False

    def test_image_source_needs_a_path(self, capsys):
        from ml import webcam_detection

        assert webcam_detection.main(["--source", "image"]) == 1
        assert "needs a file path" in capsys.readouterr().out
