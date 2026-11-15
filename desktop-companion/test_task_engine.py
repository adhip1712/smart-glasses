"""Tests for the Universal App Control save workflow."""
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import task_engine


class TaskEngineTests(unittest.TestCase):
    def test_save_intent_is_recognized_for_notepad_word_and_sticky_notes(self):
        for command in (
            "save this message in Notepad",
            "save this in Word",
            "save this as a sticky note",
            "write this to a text file",
        ):
            with self.subTest(command=command):
                plan = task_engine.plan_task({"command": command, "text": "hello", "filename": "test"})
                self.assertTrue(plan["ready"], plan)
                self.assertEqual(plan["task"], "save_text")

    def test_default_destination_is_visionary_nexus_documents_folder(self):
        with tempfile.TemporaryDirectory() as folder:
            docs = Path(folder) / "Documents"
            docs.mkdir()
            with patch.object(task_engine, "_known_documents", return_value=docs):
                plan = task_engine.plan_task({"task": "save_text", "text": "hello", "filename": "note"})
                self.assertTrue(plan["ready"], plan)
                self.assertEqual(Path(plan["directory"]), docs / "Visionary Nexus")
                self.assertFalse(plan["overwrite_required"])

    def test_explicit_path_is_used_exactly_and_created_if_needed(self):
        with tempfile.TemporaryDirectory() as folder:
            target_dir = Path(folder) / "Custom" / "Project"
            with patch.object(task_engine, "_is_protected_path", return_value=False):
                plan = task_engine.plan_task({"task": "save_text", "text": "hello", "filename": "note", "directory": str(target_dir)})
                self.assertTrue(plan["ready"], plan)
                self.assertEqual(Path(plan["target"]), target_dir / "note.txt")

    def test_full_explicit_filename_path_is_respected(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "my-note.txt"
            with patch.object(task_engine, "_is_protected_path", return_value=False):
                plan = task_engine.plan_task({"task": "save_text", "text": "hello", "destination_path": str(target)})
            self.assertTrue(plan["ready"], plan)
            self.assertEqual(Path(plan["target"]), target)

    def test_filename_rejects_path_traversal(self):
        with self.assertRaises(ValueError):
            task_engine._filename("../outside.txt")

    def test_default_save_writes_verifies_and_opens_notepad(self):
        with tempfile.TemporaryDirectory() as folder:
            docs = Path(folder) / "Documents"
            docs.mkdir()
            with patch.object(task_engine, "_known_documents", return_value=docs):
                with patch.object(task_engine.subprocess, "Popen") as launch:
                    result = task_engine.execute_save_text({"task": "save_text", "text": "Visionary Nexus test", "filename": "test-note"})
            self.assertTrue(result["success"], result)
            self.assertTrue(result["verified"])
            self.assertTrue(result["opened_in_notepad"])
            self.assertEqual(Path(result["path"]).read_text(encoding="utf-8"), "Visionary Nexus test")
            self.assertEqual(Path(result["path"]).parent, docs / "Visionary Nexus")
            launch.assert_called_once()

    def test_word_creates_valid_docx_and_opens_it(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(task_engine, "_is_protected_path", return_value=False):
                with patch.object(task_engine.subprocess, "Popen") as launch:
                    with patch.object(task_engine.os, "startfile", create=True) as startfile:
                        result = task_engine.execute_save_text({
                            "task": "save_text", "text": "Word document test", "filename": "report",
                            "directory": folder, "app": "word",
                        })
            self.assertTrue(result["success"], result)
            self.assertTrue(result["verified"])
            self.assertTrue(result["opened_in_app"])
            self.assertTrue(result["path"].endswith("report.docx"))
            with zipfile.ZipFile(result["path"]) as doc:
                self.assertIn("word/document.xml", doc.namelist())
                self.assertIn("Word document test", doc.read("word/document.xml").decode())
            if task_engine.os.name == "nt":
                startfile.assert_called_once()
            else:
                launch.assert_called_once()

    def test_existing_file_is_not_overwritten_without_confirmation(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "existing.txt"
            target.write_text("keep me", encoding="utf-8")
            with patch.object(task_engine, "_is_protected_path", return_value=False):
                result = task_engine.execute_save_text({"task": "save_text", "text": "replacement", "filename": "existing.txt", "directory": folder})
            self.assertTrue(result["requires_confirmation"])
            self.assertEqual(target.read_text(encoding="utf-8"), "keep me")


if __name__ == "__main__":
    unittest.main()
