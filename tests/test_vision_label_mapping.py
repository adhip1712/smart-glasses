"""Regression tests for YOLO COCO label mapping; no camera or weights required."""
import unittest

from ml.config import ModelSettings
from ml.detector import YoloDetector


class FakeModel:
    # Standard Ultralytics YOLOv8 COCO ids.
    names = {63: "laptop", 73: "book"}


class VisionLabelMappingTests(unittest.TestCase):
    def test_laptop_and_book_class_ids_are_not_swapped(self):
        detector = YoloDetector(
            settings=ModelSettings(warmup=False),
            model_loader=lambda _: FakeModel(),
        )
        detector.load()
        self.assertEqual(detector.class_names[63], "laptop")
        self.assertEqual(detector.class_names[73], "book")
        self.assertEqual(detector._label_for(63), "laptop")
        self.assertEqual(detector._label_for(73), "book")

    def test_result_class_names_override_fallback_names(self):
        detector = YoloDetector(
            settings=ModelSettings(warmup=False),
            model_loader=lambda _: FakeModel(),
        )
        detector.load()
        result = type("Result", (), {"names": {63: "laptop", 73: "book"}})()
        self.assertEqual(detector._label_for(63, result), "laptop")
        self.assertEqual(detector._label_for(73, result), "book")


if __name__ == "__main__":
    unittest.main(verbosity=2)
