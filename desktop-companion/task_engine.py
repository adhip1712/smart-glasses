"""Safe task planning and deterministic file workflows for Universal App Control 3.0."""
from __future__ import annotations
import os
import re
import subprocess
from pathlib import Path
from typing import Any

_ALLOWED_ROOT_NAMES = ("Desktop", "Documents", "Downloads")
_INVALID_FILENAME = re.compile(r'[<>:"/\\|?*]')

def _allowed_directory(raw: Any) -> Path:
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("Choose a save location: Desktop, Documents, Downloads, or a folder inside one of them.")
    home = Path.home().resolve()
    alias = raw.strip().casefold()
    if alias in {name.casefold() for name in _ALLOWED_ROOT_NAMES}:
        raw = str(home / next(name for name in _ALLOWED_ROOT_NAMES if name.casefold() == alias))
    candidate = Path(raw).expanduser().resolve()
    roots = [(home / name).resolve() for name in _ALLOWED_ROOT_NAMES]
    if not any(candidate == root or root in candidate.parents for root in roots):
        raise ValueError("For safety, file tasks are limited to Desktop, Documents, Downloads, and folders inside them.")
    if not candidate.exists() or not candidate.is_dir():
        raise ValueError("That save location does not exist or is not a folder. Choose an existing folder.")
    return candidate

def _filename(raw: Any) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("Provide a filename.")
    name = raw.strip()
    if name in {".", ".."} or Path(name).name != name or _INVALID_FILENAME.search(name):
        raise ValueError("Use a filename only, without a folder path or Windows-invalid characters.")
    if len(name) > 120 or name.endswith((".", " ")):
        raise ValueError("The filename is too long or ends with an invalid character.")
    if not Path(name).suffix:
        name += ".txt"
    if Path(name).suffix.casefold() not in {".txt", ".md"}:
        raise ValueError("This workflow currently saves text files (.txt or .md).")
    reserved = {"CON", "PRN", "AUX", "NUL"} | {f"COM{i}" for i in range(1, 10)} | {f"LPT{i}" for i in range(1, 10)}
    if Path(name).stem.upper() in reserved:
        raise ValueError("That filename is reserved by Windows.")
    return name

def plan_task(payload: dict[str, Any]) -> dict[str, Any]:
    task = str(payload.get("task") or "").strip().casefold().replace("-", "_")
    command = str(payload.get("command") or "").strip()
    if not task:
        lowered = command.casefold()
        if re.search(r"\b(save|write)\b", lowered) and re.search(r"\b(notepad|text file|message)\b", lowered):
            task = "save_text"
        elif re.search(r"\b(open|launch|start)\b", lowered):
            task = "launch_app"
    if task == "launch_app":
        app = str(payload.get("app") or "").strip()
        if not app:
            match = re.search(r"\b(?:open|launch|start)\s+(?:the\s+)?(.+?)(?:\s+app)?$", command, re.I)
            app = match.group(1).strip() if match else ""
        if not app:
            return {"success": True, "task": task, "ready": False, "missing": ["app"], "questions": ["Which application should I open?"]}
        return {"success": True, "task": task, "ready": True, "app": app, "steps": [{"action": "launch_app", "app": app}]}
    if task != "save_text":
        return {"success": False, "supported": ["save_text", "launch_app"], "error": "This task type is not yet supported by the deterministic task runner. Use the existing /launch and /ui routes for other app controls."}
    text = payload.get("text")
    if text is None and ":" in command:
        text = command.split(":", 1)[1].strip()
    filename = payload.get("filename")
    directory = payload.get("directory")
    missing, questions = [], []
    if not isinstance(text, str) or not text:
        missing.append("text"); questions.append("What exact text should I save?")
    if not isinstance(filename, str) or not filename.strip():
        missing.append("filename"); questions.append("What filename should I use?")
    if not isinstance(directory, str) or not directory.strip():
        missing.append("directory"); questions.append("Where should I save it: Desktop, Documents, Downloads, or another folder?")
    if missing:
        return {"success": True, "task": task, "ready": False, "missing": missing, "questions": questions}
    try:
        safe_name = _filename(filename)
        safe_dir = _allowed_directory(directory)
    except ValueError as exc:
        return {"success": True, "task": task, "ready": False, "missing": [], "questions": [str(exc)], "error": str(exc)}
    target = safe_dir / safe_name
    return {
        "success": True, "task": task, "ready": True, "filename": safe_name,
        "directory": str(safe_dir), "target": str(target), "overwrite_required": target.exists(),
        "steps": [{"action": "validate_destination"}, {"action": "write_text", "target": str(target)},
                  {"action": "verify_file", "target": str(target)}, {"action": "open_in_notepad", "target": str(target)}],
    }

def execute_save_text(payload: dict[str, Any]) -> dict[str, Any]:
    plan = plan_task(payload)
    if not plan.get("success") or not plan.get("ready"):
        return plan
    if plan.get("overwrite_required") and payload.get("confirmed_overwrite") is not True:
        return {"success": False, "requires_confirmation": True, "target": plan["target"],
                "message": "A file with that name already exists. Confirm overwrite before replacing it."}
    text = payload.get("text")
    if not isinstance(text, str) or not text or len(text) > 100_000:
        raise ValueError("Text must contain 1–100,000 characters.")
    target = Path(plan["target"])
    temp = target.with_name(target.name + ".vn-tmp")
    try:
        with temp.open("w", encoding="utf-8", newline="") as stream:
            stream.write(text); stream.flush(); os.fsync(stream.fileno())
        os.replace(temp, target)
    finally:
        try:
            if temp.exists(): temp.unlink()
        except OSError:
            pass
    if target.read_text(encoding="utf-8") != text:
        raise RuntimeError("The file was written but read-back verification did not match.")
    opened, open_error = False, None
    try:
        subprocess.Popen(["notepad.exe", str(target)], close_fds=True); opened = True
    except OSError as exc:
        open_error = type(exc).__name__
    return {"success": True, "task": "save_text", "path": str(target), "verified": True,
            "opened_in_notepad": opened, "open_error": open_error, "characters_saved": len(text),
            "message": "The text file was saved and verified." + (" It was also opened in Notepad." if opened else " Notepad could not be opened automatically.")}
