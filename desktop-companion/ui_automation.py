"""Permission-scoped Windows UI Automation for Visionary Nexus.

Only inspects top-level windows and visible controls on explicit request.
Never reads text from edit controls (which may contain private or secret data).
"""
from __future__ import annotations

try:
    from pywinauto import Desktop
    from pywinauto.keyboard import send_keys
except ImportError:
    Desktop = None
    send_keys = None

SENSITIVE_NAMES = ("password", "passcode", "pin", "one-time code", "otp", "security code")
HIGH_IMPACT_NAMES = ("send", "delete", "remove", "purchase", "buy", "checkout", "publish", "post", "submit", "transfer", "pay", "confirm", "share", "invite", "forward", "upload")

def _require():
    if Desktop is None:
        raise RuntimeError("UI automation is not installed. Re-run desktop-companion\\install.ps1.")

def _windows():
    _require()
    return [w for w in Desktop(backend="uia").windows() if w.is_visible() and w.window_text().strip()]

def list_windows():
    result = []
    for w in _windows():
        try:
            result.append({"window_id": str(w.handle), "title": w.window_text()[:180], "process_id": int(w.element_info.process_id)})
        except Exception:
            continue
    return result[:80]

def _window(window_id):
    if not str(window_id).isdigit():
        raise ValueError("Choose a window_id returned by /windows.")
    for w in _windows():
        if str(w.handle) == str(window_id):
            return w
    raise ValueError("That window is no longer available. Refresh /windows.")

def inspect_window(window_id):
    w = _window(window_id)
    controls = []
    for c in w.descendants():
        try:
            if not c.is_visible():
                continue
            info = c.element_info
            ctype = str(info.control_type or "")[:40]
            # Expose actionable labels only, not passive message/document text.
            if ctype not in {"Button", "Edit", "Document", "ComboBox", "TabItem", "MenuItem", "CheckBox", "RadioButton", "Hyperlink", "SplitButton"}:
                continue
            name = (info.name or "").strip()[:120]
            if any(word in name.casefold() for word in SENSITIVE_NAMES):
                name = "[sensitive control]"
            # Do not expose values from edit controls, document contents, or password fields.
            controls.append({
                "name": name,
                "control_type": ctype,
                "automation_id": str(info.automation_id or "")[:100],
                "control_id": int(info.control_id or 0),
                "class_name": str(info.class_name or "")[:100],
                "framework_id": str(info.framework_id or "")[:60],
                "enabled": bool(c.is_enabled()),
                "rectangle": {
                    "left": int(c.rectangle().left), "top": int(c.rectangle().top),
                    "right": int(c.rectangle().right), "bottom": int(c.rectangle().bottom)
                }
            })
        except Exception:
            continue
        if len(controls) >= 250:
            break
    return {"success": True, "window_id": str(w.handle), "title": w.window_text()[:180], "controls": controls}

def perform_action(data):
    window_id = str(data.get("window_id") or "")
    action = str(data.get("action") or "").casefold()
    control_name = str(data.get("control_name") or "").strip()
    automation_id = str(data.get("automation_id") or "").strip()
    control_type = str(data.get("control_type") or "").strip()
    if action not in {"click", "type_text", "press_key"}:
        raise ValueError("Allowed actions are click, type_text, and press_key.")
    w = _window(window_id)
    if action in {"click", "type_text"}:
        if not control_name and not automation_id:
            raise ValueError("Provide an exact control_name or automation_id from /ui/inspect.")
        matches = []
        for c in w.descendants():
            try:
                info = c.element_info
                name_matches = not control_name or (info.name or "").strip().casefold() == control_name.casefold()
                id_matches = not automation_id or str(info.automation_id or "").strip() == automation_id
                if name_matches and id_matches and (not control_type or info.control_type == control_type):
                    if c.is_visible() and c.is_enabled():
                        matches.append(c)
            except Exception:
                continue
        if len(matches) != 1:
            raise ValueError("Control must match exactly one visible, enabled control. Inspect the window and use its exact name and type.")
        control = matches[0]
        if action == "click":
            if control_name.casefold() in HIGH_IMPACT_NAMES or any(x in control_name.casefold() for x in HIGH_IMPACT_NAMES):
                if data.get("confirmed") is not True:
                    return {"success": False, "requires_confirmation": True, "message": "This control may send, submit, publish, delete, purchase, or transfer. Confirm the exact action in Visionary Nexus before continuing."}
            control.click_input()
        else:
            text = data.get("text")
            if not isinstance(text, str) or not text or len(text) > 2000:
                raise ValueError("Provide text of 1–2000 characters.")
            if control.element_info.control_type not in {"Edit", "ComboBox", "Document"}:
                raise ValueError("Text can only be entered into an editable text control.")
            if any(x in control_name.casefold() for x in SENSITIVE_NAMES):
                raise ValueError("Typing into password or security-code controls is not supported.")
            control.click_input()
            # Set literal text directly; do not interpret text as key sequences.
            control.set_edit_text(text)
    else:
        key = str(data.get("key") or "").upper()
        allowed = {"TAB", "ESC", "UP", "DOWN", "LEFT", "RIGHT", "HOME", "END", "BACKSPACE", "SPACE"}
        if key not in allowed:
            raise ValueError("That key is not allowed. Use a non-submitting navigation key such as TAB, ESC, or an arrow key.")
        w.set_focus()
        send_keys("{" + key + "}")
    return {"success": True, "action": action, "window_id": window_id}

def capture_window(window_id):
    """Capture only the explicitly selected visible window for optional vision analysis."""
    import base64
    from io import BytesIO
    w = _window(window_id)
    image = w.capture_as_image()
    if image.width > 1600 or image.height > 1200:
        image.thumbnail((1600, 1200))
    buffer = BytesIO()
    image.save(buffer, format="JPEG", quality=78, optimize=True)
    data = buffer.getvalue()
    if len(data) > 4_000_000:
        image.thumbnail((1200, 900))
        buffer = BytesIO()
        image.save(buffer, format="JPEG", quality=68, optimize=True)
        data = buffer.getvalue()
    return {"success": True, "window_id": str(w.handle), "title": w.window_text()[:180],
            "mime_type": "image/jpeg", "image_base64": base64.b64encode(data).decode("ascii"),
            "width": image.width, "height": image.height}
