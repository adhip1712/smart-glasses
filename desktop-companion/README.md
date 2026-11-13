Visionary Nexus Windows Companion

Install on the Windows laptop: install Python 3.10+, open PowerShell in this folder, then run:
powershell -ExecutionPolicy Bypass -File .\install.ps1

Runs locally on 127.0.0.1:8765 and starts at Windows sign-in. No phone is required.

Supports Start Menu/App Paths discovery, launching discovered desktop apps, and scheduling alarms. Alarm seconds precision is provided while the companion remains running. Windows Task Scheduler fallback is minute precision. The laptop must be awake and the user signed in for an interactive alert.

App discovery and launch do not grant access to private app data or UI automation. Those capabilities need separate app-specific connections and explicit permission. Only the production website and local development origins are accepted by default.
