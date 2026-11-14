Visionary Nexus Windows Companion 3.0

Install or update on the Windows laptop:
1. Open PowerShell in this folder.
2. Run: powershell -ExecutionPolicy Bypass -File .\install.ps1

The installer adds the pywinauto UI Automation dependency and starts the companion at 127.0.0.1:8765. It starts at Windows sign-in. No administrator access or phone is required.

Capabilities:
- Discover Start Menu shortcuts and registered Windows applications.
- Launch discovered desktop apps.
- List visible desktop windows (GET /windows).
- Inspect visible actionable controls in a selected window (POST /ui/inspect).
- Click a uniquely matched visible control, enter literal text into an editable field, or press a restricted navigation key (POST /ui/action).

Safety boundaries:
- Inspection is explicit and limited to the selected window; passive message/document text and edit-field values are not returned.
- Password/security-code controls are not supported.
- Actions are limited to click, type_text, and a small allowlist of navigation keys. No shell, script, arbitrary URL, file-system, or hidden-process execution is exposed.
- Controls named Send, Delete, Publish, Buy, Pay, Submit, and similar require a separate confirmation in Visionary Nexus.
- WhatsApp messaging remains draft-first; the user must manually press Send.
- The companion binds only to 127.0.0.1 and accepts the configured Visionary Nexus origins.

The existing /health, /apps, /launch, and disabled /alarm routes remain available. A running Windows session is required for interactive desktop actions.
