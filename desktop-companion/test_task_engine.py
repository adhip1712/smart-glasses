"""Unit tests for the safe Universal App Control task runner."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import task_engine


class TaskEngineTests(unittest.TestCase):
    def test_save_task_asks_for_missing_fields(self):
        plan = task_engine.plan_task({"task": "save_text"})
        self.assertFalse(plan["ready"])
        self.assertEqual(plan["missing"], ["text", "filename", "directory"])

    def test_natural_language_save_intent_is_recognized(self):
        plan = task_engine.plan_task({"command": "save this message in Notepad"})
        self.assertEqual(plan["task"], "save_text")
        self.assertFalse(plan["ready"])

    def test_filename_rejects_path_traversal(self):
        with self.assertRaises(ValueError):
            task_engine._filename("../outside.txt")

    def test_filename_adds_text_extension(self):
        self.assertEqual(task_engine._filename("School Notes"), "School Notes.txt")

    def test_save_is_verified_and_opens_notepad(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(task_engine, "_allowed_roots", return_value=[Path(folder)]):
                with patch.object(task_engine.subprocess, "Popen") as launch:
                    result = task_engine.execute_save_text({
                        "task": "save_text", "text": "Visionary Nexus test",
                        "filename": "test-note", "directory": folder,
                    })
            self.assertTrue(result["success"])
            self.assertTrue(result["verified"])
            self.assertTrue(result["opened_in_notepad"])
            self.assertEqual(Path(result["path"]).read_text(encoding="utf-8"), "Visionary Nexus test")
            launch.assert_called_once()

    def test_existing_file_is_not_overwritten_without_confirmation(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "existing.txt"
            target.write_text("keep me", encoding="utf-8")
            with patch.object(task_engine, "_allowed_roots", return_value=[Path(folder)]):
                result = task_engine.execute_save_text({
                    "task": "save_text", "text": "replacement",
                    "filename": "existing.txt", "directory": folder,
                })
            self.assertTrue(result["requires_confirmation"])
            self.assertEqual(target.read_text(encoding="utf-8"), "keep me")


if __name__ == "__main__":
    unittest.main()
