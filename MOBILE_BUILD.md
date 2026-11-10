# Visionary Nexus — iOS and Android apps

Visionary Nexus now has Capacitor 8 native projects generated from the existing React + TypeScript frontend. The FastAPI backend remains separate and is shared by web, Windows desktop, Android and iOS.

## Project layout

- `Frontend/android/` — Android Studio project for Google Play builds.
- `Frontend/ios/` — Xcode project for App Store builds.
- `Frontend/capacitor.config.ts` — native app ID, display name and web asset directory.
- `Frontend/src/services/api.ts` — shared API client; mobile backend URL is stored under `visionary.backend_url`.
- `Frontend/src/components/Settings.tsx` — Network section contains the mobile backend address setting.

## Build / sync after frontend changes

```powershell
cd Frontend
npm install
npm run mobile:sync
```

## Android (Windows supported)

1. Install Android Studio and its Android SDK / platform tools.
2. Install a supported JDK (use the version required by the generated Gradle plugin; Android Studio can manage this).
3. Open the project: `cd Frontend; npx cap open android`.
4. Let Gradle sync, select an emulator or USB-connected Android phone, and run the `app` configuration.
5. For Google Play, use Android Studio **Build > Generate Signed Bundle / APK** and create a signed Android App Bundle (`.aab`). Keep the signing key private and backed up.

## iOS (requires macOS)

1. Use a Mac with Xcode installed and the iOS SDK available.
2. Run `cd Frontend; npm install; npm run mobile:sync`.
3. Open with `npx cap open ios`, configure the Apple Developer team and bundle signing in Xcode, then test on a simulator and physical iPhone.
4. Archive and upload through Xcode Organizer / App Store Connect. App Store review, privacy declarations, screenshots and store metadata are still required.

## Backend connection on a phone

The mobile app needs a reachable FastAPI server. For LAN testing, run the backend on the PC bound to `0.0.0.0`, allow the backend port through the PC firewall on the private network, and keep the phone and PC on the same Wi-Fi. In Visionary Nexus > Settings > Network, set **Mobile app backend address** to the PC's current LAN address, for example `http://192.168.1.10:8000`, then save. The address is local to that network and can change when the router assigns a new IP. For production distribution, deploy FastAPI behind HTTPS at a stable domain instead of relying on a home-PC address.

The Android manifest currently permits cleartext HTTP to support local-network development. Production builds should use HTTPS and remove that broad cleartext allowance after the backend is deployed securely. iOS has local-network permission text and ATS local-network allowance for development.

## Current status / limitations

- Capacitor Android and iOS projects have been generated and synced with the current frontend build.
- A production web bundle completed successfully before the native sync.
- TypeScript `tsc --noEmit` still reports existing errors in `AIAssistant.tsx` and `Vision.tsx`; these were not changed as part of mobile scaffolding.
- This Windows computer did not report a Java runtime or Android SDK in PATH, so an APK/AAB has not yet been built or run here.
- iOS compilation, signing and App Store submission must be done on a Mac with Xcode.
- App icons, launch screens, store screenshots/metadata, privacy disclosures, release signing, production HTTPS backend hosting and on-device QA remain before public store release.
- YouTube playback continues to use the existing web player implementation inside the Capacitor WebView. YouTube API / embedded-player restrictions still apply; the mobile wrapper does not bypass them.
