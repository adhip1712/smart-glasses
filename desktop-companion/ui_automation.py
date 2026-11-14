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
HIGH_IMPACT_NAMES = ("send", "delete", "remove", "purchase", "buy", "checkout", "publish", "post", "submit", "transfer", "pay", "confirm")

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
            name = (info.name or "").strip()[:120]
            ctype = str(info.control_type or "")[:40]
            if any(word in name.casefold() for word in SENSITIVE_NAMES):
                name = "[sensitive control]"
            # Do not expose values from edit controls, document contents, or password fields.
            controls.append({
                "name": name,
                "control_type": ctype,
                "automation_id": str(info.automation_id or "")[:100],
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
    control_type = str(data.get("control_type") or "").strip()
    if action not in {"click", "type_text", "press_key"}:
        raise ValueError("Allowed actions are click, type_text, and press_key.")
    w = _window(window_id)
    if action in {"click", "type_text"}:
        if not control_name:
            raise ValueError("control_name is required for this action.")
        matches = []
        for c in w.descendants():
            try:
                info = c.element_info
                if (info.name or "").strip().casefold() == control_name.casefold() and (not control_type or info.control_type == control_type):
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
            control.type_keys(text, with_spaces=True, set_foreground=True)
    else:
        key = str(data.get("key") or "").upper()
        allowed = {"ENTER", "TAB", "ESC", "UP", "DOWN", "LEFT", "RIGHT", "HOME", "END", "BACKSPACE", "DELETE", "SPACE"}
        if key not in allowed:
            raise ValueError("That key is not allowed. Use a navigation key such as ENTER, TAB, ESC, or an arrow key.")
        w.set_focus()
        send_keys("{" + key + "}")
    return {"success": True, "action": action, "window_id": window_id, "verified": True}
