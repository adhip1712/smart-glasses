Visionary Nexus Windows Companion 3.2

Install or update on the Windows laptop:
1. Open PowerShell in this folder.
2. Run: powershell -ExecutionPolicy Bypass -File .\install.ps1

The installer installs/updates pywinauto and starts the companion at 127.0.0.1:8765. It starts at Windows sign-in. No administrator access or phone is required. Universal App Control 3.0 adds no mandatory cloud service or paid API.

Capabilities:
- Discover Start Menu shortcuts and registered Windows applications.
- Launch discovered desktop apps.
- Open validated http/https URLs in the Windows default browser (POST /open-url); embedded credentials and non-web schemes are rejected.
- Open Spotify desktop search through its registered `spotify:search:` URI (POST /spotify/search); no Spotify Web API key or OAuth token is used.
- Send play/pause, next, previous, and stop through Windows media transport keys (POST /spotify/control). These target the active system media session and are best-effort; they do not guarantee Spotify owns that session or that a selected track autoplays.
- Spotify account tier, ads, catalog availability, and playback restrictions remain controlled by Spotify.
- List visible desktop windows (GET /windows).
- Inspect visible actionable controls in a selected window (POST /ui/inspect).
- Capture a selected window for optional vision analysis (POST /ui/screenshot). Screenshot access is explicit and scoped to one selected window.
- Click a uniquely matched visible control, enter literal text into an editable field, or press a restricted navigation key (POST /ui/action).
- Plan supported natural-language tasks (POST /task/plan).
- Execute save workflows (POST /task/execute): ask for missing text and filename; default to the user's Documents\\Visionary Nexus folder (created automatically); honor an explicitly supplied folder or full destination path; save, read back to verify, and open in the selected app where supported. Word output is a .docx document; Notepad and Sticky Notes requests produce text files.
- Launch an application through the task runner (POST /task/execute with task=launch_app).

Task runner safety:
- The default save location is Documents\\Visionary Nexus. An explicit absolute destination supplied by the user is honored, except protected Windows system folders and drive roots.
- Filenames are validated. Word creates .docx; Notepad and Sticky Notes create .txt or .md.
- Existing files are never overwritten without explicit confirmed_overwrite=true.
- Sticky Notes can be launched, but it has no supported file-import interface in this workflow; the verified text copy remains in the Visionary Nexus folder.
- File writes are atomic and verified by reading the saved content back. Word documents are checked by reopening their OpenXML content.
- No arbitrary shell, script, process, or unrestricted filesystem operation is exposed. Website handoff accepts only validated http/https URLs and uses the Windows default-browser association; it does not execute commands from a URL.

UI safety boundaries:
- Inspection is explicit and limited to the selected window; passive message/document text and edit-field values are not returned.
- Password/security-code controls are not supported.
- Actions remain limited to click, type_text, and restricted navigation keys.
- Controls named Send, Delete, Publish, Buy, Pay, Submit, and similar require a separate confirmation in Visionary Nexus.
- WhatsApp messaging remains draft-first; the user must manually press Send.
- The companion binds only to 127.0.0.1 and accepts the configured Visionary Nexus origins.

Existing /health, /apps, /launch, /windows, /ui/inspect, /ui/action, and disabled /alarm behavior is preserved. The new /open-url endpoint adds default-browser website handoff. A running Windows session is required for interactive desktop actions.

Note: the screenshot endpoint provides visual input; this release does not silently grant a vision model permission to click coordinates. Vision-based actions still require a separately reviewed, allowlisted integration.
