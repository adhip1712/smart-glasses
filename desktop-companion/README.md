Visionary Nexus Windows Companion 3.0

Install or update on the Windows laptop:
1. Open PowerShell in this folder.
2. Run: powershell -ExecutionPolicy Bypass -File .\install.ps1

The installer installs/updates pywinauto and starts the companion at 127.0.0.1:8765. It starts at Windows sign-in. No administrator access or phone is required. Universal App Control 3.0 adds no mandatory cloud service or paid API.

Capabilities:
- Discover Start Menu shortcuts and registered Windows applications.
- Launch discovered desktop apps.
- List visible desktop windows (GET /windows).
- Inspect visible actionable controls in a selected window (POST /ui/inspect).
- Capture a selected window for optional vision analysis (POST /ui/screenshot). Screenshot access is explicit and scoped to one selected window.
- Click a uniquely matched visible control, enter literal text into an editable field, or press a restricted navigation key (POST /ui/action).
- Plan supported natural-language tasks (POST /task/plan).
- Execute safe text-file save workflows (POST /task/execute): ask for missing text, filename, and location; validate the destination; save; read back to verify; and open the result in Notepad.
- Launch an application through the task runner (POST /task/execute with task=launch_app).

Task runner safety:
- File operations are limited to Desktop, Documents, Downloads, and folders inside those locations.
- Filenames are validated; only .txt and .md are accepted.
- Existing files are never overwritten without explicit confirmed_overwrite=true.
- File writes are atomic and verified by reading the saved content back.
- No arbitrary shell, script, URL, process, or unrestricted filesystem operation is exposed.

UI safety boundaries:
- Inspection is explicit and limited to the selected window; passive message/document text and edit-field values are not returned.
- Password/security-code controls are not supported.
- Actions remain limited to click, type_text, and restricted navigation keys.
- Controls named Send, Delete, Publish, Buy, Pay, Submit, and similar require a separate confirmation in Visionary Nexus.
- WhatsApp messaging remains draft-first; the user must manually press Send.
- The companion binds only to 127.0.0.1 and accepts the configured Visionary Nexus origins.

Existing /health, /apps, /launch, /windows, /ui/inspect, /ui/action, and disabled /alarm behavior is preserved. A running Windows session is required for interactive desktop actions.

Note: the screenshot endpoint provides visual input; this release does not silently grant a vision model permission to click coordinates. Vision-based actions still require a separately reviewed, allowlisted integration.
