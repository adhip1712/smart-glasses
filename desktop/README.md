# Visionary Nexus Desktop

Windows desktop wrapper for the hosted Visionary Nexus application.

## Build on Windows

Requirements: Node.js 22.12+ and an internet connection.

```powershell
cd desktop
npm install
npm run dist:win
```

The installer is written to `release/Visionary-Nexus-Setup-1.0.2.exe`.

## Automatic updates

- Packaged Windows builds check GitHub Releases shortly after the app opens.
- When an update is available, the app asks whether to download it.
- Downloads happen in the background; when complete, choose **Restart and install**.
- Future versions are published as GitHub Releases with electron-builder's `latest.yml` metadata and installer assets.
- The first installer containing this updater must be installed once manually. After that, updates can be installed from inside Visionary Nexus.
- Releases must use version tags such as `v1.0.3`; the release workflow builds and publishes the Windows NSIS installer.

## Runtime notes

- The desktop client loads the production Visionary Nexus web app and uses its hosted FastAPI backend. An internet connection is required.
- Microphone and camera permissions are handled by Electron's media permission prompt.
- Google OAuth uses the system browser and returns to Visionary Nexus through the registered `visionarynexus://` protocol.
- The Windows companion is not bundled. Local automation that depends on it still requires it to be installed and running separately.
- The installer is unsigned; Windows SmartScreen may display a warning.

The desktop package does not modify or replace the existing backend.
