# Visionary Nexus Desktop

Windows desktop wrapper for the hosted Visionary Nexus application.

## Build on Windows

Requirements: Node.js 22.12+ and an internet connection.

```powershell
cd desktop
npm install
npm run dist:win
```

The installer is written to `release/Visionary-Nexus-Setup-1.0.0.exe`.

## Runtime notes

- The desktop client loads the production Visionary Nexus web app and uses its hosted FastAPI backend. An internet connection is required.
- Microphone and camera permissions are handled by Electron's media permission prompt.
- OAuth redirects for the configured Google, GitHub, Microsoft, and Apple providers are allowed inside the desktop flow.
- The Windows companion is not bundled in this first release. Local automation that depends on the companion still requires it to be installed and running separately.
- The installer is currently unsigned. Windows SmartScreen may display a warning. Add a trusted code-signing certificate before wider public distribution.

The desktop package does not modify or replace the existing backend.
