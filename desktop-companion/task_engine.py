"""Safe task planning and deterministic file workflows for Universal App Control 3.0."""
from __future__ import annotations
import os, re, subprocess, tempfile, zipfile
from pathlib import PureWindowsPath
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

_INVALID_FILENAME = re.compile(r'[<>:"/\\|?*]')
_PROTECTED_DIRS = ("Windows", "Program Files", "Program Files (x86)", "ProgramData")

def _known_documents() -> Path:
    home = Path.home()
    if os.name == "nt":
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders") as key:
                raw, _ = winreg.QueryValueEx(key, "Personal")
                return Path(os.path.expandvars(str(raw))).expanduser()
        except (ImportError, OSError):
            pass
    candidates = [Path(os.environ.get("OneDrive", home / "OneDrive")) / "Documents",
                  home / "OneDrive - Personal" / "Documents", home / "Documents"]
    return next((p for p in candidates if p.exists() and p.is_dir()), home / "Documents")

def _default_save_directory(create: bool = False) -> Path:
    folder = _known_documents() / "Visionary Nexus"
    if create:
        folder.mkdir(parents=True, exist_ok=True)
    return folder.resolve()

def _is_protected_path(path: Path) -> bool:
    if path == Path(path.anchor):
        return True
    windows = Path(os.environ.get("WINDIR", r"C:\Windows")).resolve()
    protected = [windows] + [(windows.parent / name).resolve() for name in _PROTECTED_DIRS[1:]]
    return any(path == item or item in path.parents for item in protected)

def _allowed_directory(raw: Any, create: bool = False) -> Path:
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return _default_save_directory(create)
    if not isinstance(raw, str):
        raise ValueError("The save location must be a folder path.")
    raw = raw.strip().strip('"')
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        alias = raw.casefold()
        if alias == "documents":
            candidate = _known_documents()
        elif alias in {"desktop", "downloads"}:
            candidate = Path.home() / alias.title()
        else:
            raise ValueError("Use an absolute folder path, such as C:\\Users\\You\\Documents\\Work.")
    candidate = candidate.resolve()
    if _is_protected_path(candidate):
        raise ValueError("That is a protected Windows system location. Choose a normal documents or project folder.")
    if create:
        candidate.mkdir(parents=True, exist_ok=True)
    elif not candidate.exists():
        return candidate
    if not candidate.is_dir():
        raise ValueError("The save location exists but is not a folder.")
    return candidate

def _infer_app(payload: dict[str, Any], command: str) -> str:
    app_hint = str(payload.get("app") or payload.get("target_app") or payload.get("app_name") or "").strip()
    combined = (app_hint + " " + command).replace("_", " ").replace("-", " ")
    if app_hint.casefold() in {"sticky_notes", "stickynotes"} or re.search(r"\bsticky\s*notes?\b", combined, re.I):
        return "sticky_notes"
    if app_hint.casefold() in {"word", "microsoft word"} or re.search(r"\b(?:microsoft\s+)?word\b|\b\.docx\b", combined, re.I):
        return "word"
    return "notepad"

def _filename(raw: Any, app: str = "notepad") -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("Provide a filename.")
    name = raw.strip().strip('"')
    if name in {".", ".."} or Path(name).name != name or _INVALID_FILENAME.search(name):
        raise ValueError("Use a filename only, without a folder path or Windows-invalid characters.")
    if len(name) > 120 or name.endswith((".", " ")):
        raise ValueError("The filename is too long or ends with an invalid character.")
    if not Path(name).suffix:
        name += ".docx" if app == "word" else ".txt"
    allowed = {".docx", ".txt", ".md"} if app == "word" else {".txt", ".md"}
    if Path(name).suffix.casefold() not in allowed:
        raise ValueError("Word saves as .docx; Notepad and Sticky Notes save text as .txt or .md.")
    reserved = {"CON", "PRN", "AUX", "NUL"} | {f"COM{i}" for i in range(1, 10)} | {f"LPT{i}" for i in range(1, 10)}
    if Path(name).stem.upper() in reserved:
        raise ValueError("That filename is reserved by Windows.")
    return name

def _infer_filename(command: str) -> str:
    match = re.search(r"\b(?:as|named|called)\s+([A-Za-z0-9 _-]+?)(?:\s+(?:in|to|at)\s+|$)", command, re.I)
    return match.group(1).strip() if match else ""

def _infer_directory(command: str) -> str:
    match = re.search(r"\b(?:in|to|at)\s+([A-Za-z]:\\.+)$", command, re.I)
    return match.group(1).strip().rstrip(chr(92)) if match else ""
def plan_task(payload: dict[str, Any]) -> dict[str, Any]:
    task = str(payload.get("task") or "").strip().casefold().replace("-", "_")
    command = str(payload.get("command") or "").strip()
    if not task:
        if re.search(r"\b(?:save|write|put)\b", command, re.I) and re.search(r"\b(?:notepad|word|sticky\s*notes?|text file|file|message|document|note)\b", command, re.I):
            task = "save_text"
        elif re.search(r"\b(open|launch|start)\b", command, re.I):
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
        return {"success": False, "supported": ["save_text", "launch_app"], "error": "This task type is not yet supported by the deterministic task runner."}
    app = _infer_app(payload, command)
    text = payload.get("text")
    if text is None and ":" in command:
        text = command.split(":", 1)[1].strip()
    filename = payload.get("filename") or _infer_filename(command)
    directory = payload.get("directory") or payload.get("path") or payload.get("destination_path") or _infer_directory(command)
    # A complete destination filename is accepted as well as a folder path.
    if isinstance(directory, str) and directory.strip():
        raw_destination = directory.strip().strip('"')
        native_destination = Path(raw_destination).expanduser()
        destination_file = native_destination if native_destination.is_absolute() else PureWindowsPath(raw_destination)
        if destination_file.suffix.casefold() in {".txt", ".md", ".docx"}:
            if not filename:
                filename = destination_file.name
            directory = str(destination_file.parent)
    missing, questions = [], []
    if not isinstance(text, str) or not text:
        missing.append("text"); questions.append("What exact text should I save?")
    if not isinstance(filename, str) or not filename.strip():
        missing.append("filename"); questions.append("What filename should I use?")
    if missing:
        return {"success": True, "task": task, "ready": False, "missing": missing, "questions": questions, "app": app}
    try:
        safe_name = _filename(filename, app)
        safe_dir = _allowed_directory(directory)
    except ValueError as exc:
        field = "filename" if "filename" in str(exc).casefold() or "file" in str(exc).casefold() else "directory"
        return {"success": True, "task": task, "ready": False, "missing": [], "field": field, "questions": [str(exc)], "error": str(exc), "app": app}
    target = safe_dir / safe_name
    return {"success": True, "task": task, "ready": True, "app": app, "filename": safe_name,
            "directory": str(safe_dir), "target": str(target), "overwrite_required": target.exists(),
            "steps": [{"action": "create_destination"}, {"action": "write_text", "target": str(target)},
                      {"action": "verify_file", "target": str(target)}, {"action": "open_in_app", "app": app, "target": str(target)}]}

def _write_docx(target: Path, text: str) -> None:
    paragraphs = "".join('<w:p><w:r><w:t xml:space="preserve">' + escape(line) + '</w:t></w:r></w:p>' for line in (text.splitlines() or [""]))
    xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + paragraphs + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>'
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as doc:
        doc.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        doc.writestr("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        doc.writestr("word/document.xml", xml)

def execute_save_text(payload: dict[str, Any]) -> dict[str, Any]:
    plan = plan_task(payload)
    if not plan.get("success") or not plan.get("ready"):
        return plan
    if plan.get("overwrite_required") and payload.get("confirmed_overwrite") is not True:
        return {"success": False, "requires_confirmation": True, "target": plan["target"], "message": "A file with that name already exists. Confirm overwrite before replacing it."}
    text = payload.get("text")
    if not isinstance(text, str) or not text or len(text) > 100_000:
        raise ValueError("Text must contain 1–100,000 characters.")
    target = Path(plan["target"])
    target.parent.mkdir(parents=True, exist_ok=True)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", dir=target.parent, prefix=".visionary-nexus-", suffix=".tmp", delete=False) as stream:
            temp_path = Path(stream.name)
            if target.suffix.casefold() == ".docx":
                stream.close()
                _write_docx(temp_path, text)
            else:
                stream.write(text.encode("utf-8")); stream.flush(); os.fsync(stream.fileno())
        if plan.get("overwrite_required"):
            os.replace(temp_path, target)
        else:
            os.rename(temp_path, target)
    except FileExistsError:
        return {"success": False, "requires_confirmation": True, "target": str(target), "message": "A file with that name appeared while saving. Confirm overwrite before replacing it."}
    finally:
        try:
            if temp_path and temp_path.exists(): temp_path.unlink()
        except OSError:
            pass
    if target.suffix.casefold() == ".docx":
        with zipfile.ZipFile(target) as doc:
            xml = doc.read("word/document.xml").decode("utf-8")
        if any(escape(line) not in xml for line in text.splitlines() if line):
            raise RuntimeError("The Word document was written but read-back verification did not match.")
    elif target.read_text(encoding="utf-8") != text:
        raise RuntimeError("The file was written but read-back verification did not match.")
    app, opened, open_error = plan["app"], False, None
    try:
        if app == "notepad":
            subprocess.Popen(["notepad.exe", str(target)], close_fds=True)
        elif app == "word":
            if os.name == "nt": os.startfile(str(target))
            else: subprocess.Popen(["xdg-open", str(target)], close_fds=True)
        elif app == "sticky_notes":
            if os.name != "nt": raise OSError("Sticky Notes is only available on Windows.")
            subprocess.Popen(["explorer.exe", "shell:AppsFolder\\Microsoft.MicrosoftStickyNotes_8wekyb3d8bbwe!App"], close_fds=True)
        opened = True
    except OSError as exc:
        open_error = type(exc).__name__
    note = " The text is saved as a file; Sticky Notes does not provide a supported file-import interface." if app == "sticky_notes" else ""
    return {"success": True, "task": "save_text", "app": app, "path": str(target), "verified": True,
            "opened_in_app": opened, "opened_in_notepad": opened and app == "notepad",
            "open_error": open_error, "characters_saved": len(text),
            "message": "The content was saved and verified." + (f" {app.replace('_', ' ').title()} was opened." if opened else " The requested app could not be opened.") + note}
