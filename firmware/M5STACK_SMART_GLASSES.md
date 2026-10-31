# Visionary Nexus: M5Stack Atom Echo + Unit CAM

This folder contains two separate firmware targets. The devices communicate over the same Wi-Fi network; do not wire the camera GPIOs to Atom Echo.

## Hardware roles

- **M5Stack ATOM Echo**: push-to-talk microphone command capture; uploads a WAV recording to the existing FastAPI transcription endpoint and forwards the transcript to `/api/ask`. The response is printed to Serial Monitor. This target does not yet play spoken replies through the Echo speaker.
- **M5Stack Unit CAM (U109/U109-B)**: OV2640 camera, Wi-Fi provisioning, authenticated device claim/registration/heartbeat, and a `/capture` JPEG endpoint used by the existing Visionary Nexus camera API.
- Both devices must join the same trusted 2.4 GHz Wi-Fi network as the computer running the backend.

## Before uploading

1. Install Arduino CLI and the Espressif Arduino-ESP32 core. The ATOM Echo target compiled locally; the Unit CAM target's compile check is still running. Physical hardware testing is still required.
2. Start the backend from the repository root:
   `.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8001`
3. Ensure `GROQ_API_KEY` or `OPENAI_API_KEY` is configured in the backend environment for speech transcription. Do not paste keys into firmware.
4. Allow TCP 8001 on the computer's trusted Private network firewall profile.

## Build and upload

### ATOM Echo

Board: `esp32:esp32:m5stack-atom`

```powershell
powershell -ExecutionPolicy Bypass -File tools\build_m5stack_firmware.ps1
arduino-cli upload --fqbn esp32:esp32:m5stack-atom -p COMx --input-dir build\m5stack\atom_echo firmware\atom_echo
arduino-cli monitor -p COMx -c baudrate=115200
```

Replace `COMx` with the port shown by Windows Device Manager. Connect ATOM Echo to the PC with USB-C. Hold its button while speaking and release to send the recording.

On first boot, connect to Wi-Fi `VisionaryNexus-Echo` (password `nexus-setup`), open `http://192.168.4.1`, and enter the Wi-Fi SSID/password. Leave Backend URL blank to try discovery; if discovery cannot find the computer, enter its backend base URL, for example `http://<computer-LAN-IP>:8001`. Use the computer's current LAN address, not `localhost`; do not hard-code it in source.

### M5Stack Unit CAM

Board: `esp32:esp32:esp32` (ESP32 Dev Module). The firmware has the M5Stack Unit CAM OV2640 pin map, not the AI Thinker ESP32-CAM pin map.

```powershell
arduino-cli compile --fqbn esp32:esp32:esp32 --build-property build.partitions=huge_app --output-dir build\m5stack\unit_cam firmware\m5stack_unit_cam
arduino-cli upload --fqbn esp32:esp32:esp32 -p COMx --input-dir build\m5stack\unit_cam firmware\m5stack_unit_cam
```

Unit CAM has **no onboard USB programming circuit**. Upload requires an appropriate USB-to-TTL/ESP32 downloader connected to the Unit CAM Grove RX/TX/5V/GND interface; the adapter must support the board's boot/reset procedure. Follow the M5Stack Unit CAM pinout and downloader instructions. Do not connect 5V to GPIO pins. If your exact hardware is Unit CAMS3 rather than Unit CAM U109, stop: it needs a different firmware target/pin map.

After flashing, the Unit CAM opens its own temporary setup Wi-Fi AP. Connect to it, open `http://192.168.4.1`, and enter the Wi-Fi details. The device then claims itself with the backend and appears for approval in Visionary Nexus. Approve the camera device once in the app; the backend assigns and stores its credential. It should reconnect automatically after power cycles.

## Current limits / honest verification

- Firmware cannot be physically tested until the boards arrive.
- ATOM Echo currently implements push-to-talk capture and sends the assistant's textual response to Serial Monitor; speaker TTS/music playback over its I2S speaker is not yet implemented.
- Wake-word detection on the ATOM Echo is not implemented by changing a text setting alone; this target uses the physical button to avoid false wake activations until a compatible on-device wake engine is integrated.
- Unit CAM has 4 MB flash and typically no PSRAM. The camera target automatically falls back to a smaller frame buffer.
- The camera API filters device records so an Atom Echo heartbeat cannot be mistaken for the camera stream host.
