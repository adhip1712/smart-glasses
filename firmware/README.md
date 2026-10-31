# Visionary Nexus firmware

## Sketches

### Primary hardware sketch: camera

Path: `firmware/camera/camera.ino`

- Board: AI Thinker ESP32-CAM
- Sensor: auto-detected at boot (runtime sensor-ID detection); the board has reported both OV2640 and OV3660, and the detected name is sent to FastAPI in every check-in so the UI never hard-codes it
- Arduino ESP32 core: 3.3.11
- Required local file: `firmware/camera/camera_pins.h`
- Libraries: ESP32 core `WiFi`, `Preferences`, `WebServer`, `HTTPClient`, and the core-provided `esp_camera` driver
- Serial Monitor: 115200 baud
- Purpose: camera diagnostics, Wi-Fi provisioning and reconnect, camera capture/status service, and authenticated device registration/check-in

This is the primary Visionary Nexus firmware for the current hardware target. Wi-Fi credentials and the device pairing token are stored on the board in ESP32 NVS; they are not compiled into the sketch or sent to FastAPI as Wi-Fi credentials.

### Device/controller scaffold

Path: `firmware/device/device.ino`

- Board: ESP32-compatible Arduino board; no specific hardware target is wired yet
- Sensor requirements: none
- Arduino ESP32 core: 3.3.11 recommended
- Libraries: Arduino core only
- Serial Monitor: 115200 baud
- Purpose: compilable home for the existing controller module tabs. The module `.ino` files and headers in this directory are currently empty placeholders and do not implement sensors, audio, buttons, power, or device controls.

## Device sketch tabs

These files are tabs of the single `device` sketch, not separate Arduino sketches:

- `.ino`: `battery.ino`, `bluetooth.ino`, `buttons.ino`, `leds.ino`, `mic.ino`, `on_off.ino`, `power.ino`, `sensors.ino`, `sleep_mode.ino`, `speaker.ino`, `wake_word.ino`, `wifi.ino`
- `.h`: `device_config.h`, `pins.h`, `secrets.h`, `settings.h`

No credentials belong in `secrets.h`; it remains an empty placeholder.

## Arduino IDE setup and upload

1. Install Arduino IDE and Espressif Arduino-ESP32 core 3.3.11.
2. Open the primary sketch file directly, not the `firmware/` parent folder.
3. For the camera target, open `firmware/camera/camera.ino`, select **AI Thinker ESP32-CAM**, then select the board's COM port (currently COM8).
4. Select a partition/PSRAM configuration supported by the board package; do not change the AI Thinker pin map in `camera_pins.h`.
5. Click Verify, connect the board in download mode if needed, then Upload.
6. Open Serial Monitor at 115200 baud. The first boot prints the temporary provisioning AP name and one-time AP password.
7. Connect a phone/computer to the `VISIONARY NEXUS` temporary AP and open `http://192.168.4.1/`, or use the Device page's direct provisioning form while connected to the AP. Enter the Wi-Fi name/password and reachable FastAPI base URL once.
8. Later boots load saved credentials from NVS and reconnect automatically. To forget Wi-Fi, use the Device page's confirmed reset action or the physical AP portal.

Start the existing backend from the repository root with `.venv\Scripts\activate` followed by `uvicorn app.main:app --host 0.0.0.0 --port 8001`. Start the frontend with `npm --prefix Frontend run dev -- --host 0.0.0.0`.

The backend must be reachable from the device on the local network. Enter the computer's LAN IPv4 address and port 8001 in the Device setup form, not `localhost`. On Windows, get the active adapter's IPv4 address with `ipconfig`; permit TCP 8001 on the trusted Private network in Windows Firewall.

`POST /api/device/provision` accepts a physical `VN-XXXXXXXX` device ID, issues a ten-minute pairing ticket, and stores only its SHA-256 hash. The Device page posts SSID/password directly to the ESP32 AP; FastAPI never receives those values. The ESP32 exchanges the one-time ticket at `POST /api/device/register` for a persistent device token and stores that token in NVS. FastAPI stores only its hash. Do not expose device-management endpoints outside a trusted network.

The camera sketch uses only headers shipped with the ESP32 core plus its adjacent `camera_pins.h`; no PlatformIO-only or VS Code include paths are required.

## Current validation limits

The installed ESP32 core is 3.3.11 and its `esp_camera.h` is present. Compile with `arduino-cli compile --fqbn esp32:esp32:esp32cam firmware/camera`. Physical camera initialization and Wi-Fi provisioning still require the board and must be verified on hardware.
