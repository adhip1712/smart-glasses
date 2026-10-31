# Visionary Nexus camera guide

## Verified hardware target

- Board: AI Thinker ESP32-CAM
- ESP32 chip: ESP32-D0WD-V3
- Camera sensor: auto-detected at boot (OV2640 / OV3660 / OV5640). This board has reported `Sensor PID: 0x3660` / `Detected sensor: OV3660`, so nothing hard-codes OV2640
- Serial port: COM8 in the current setup
- ESP32 Arduino core: 3.3.11

## What was verified from the installed ESP32 Arduino package

The installed vendor library supports both OV2640 and OV3660. The physical sensor is detected at startup: the firmware prints the PID, stores the detected name, and includes it in every FastAPI check-in so `/api/camera/status`, `/api/camera/devices` and the Vision/Device pages display the real sensor.

- `OV2640_PID` and `OV3660_PID` are present in the driver
- `CAMERA_OV2640` and `CAMERA_OV3660` are present in the sensor enumeration

The AI Thinker pin mapping is also defined in the official CameraWebServer example:

- `CAMERA_MODEL_AI_THINKER`
- `PWDN_GPIO_NUM = 32`
- `RESET_GPIO_NUM = -1`
- `XCLK_GPIO_NUM = 0`
- `SIOD_GPIO_NUM = 26`
- `SIOC_GPIO_NUM = 27`
- `Y9_GPIO_NUM = 35`
- `Y8_GPIO_NUM = 34`
- `Y7_GPIO_NUM = 39`
- `Y6_GPIO_NUM = 36`
- `Y5_GPIO_NUM = 21`
- `Y4_GPIO_NUM = 19`
- `Y3_GPIO_NUM = 18`
- `Y2_GPIO_NUM = 5`
- `VSYNC_GPIO_NUM = 25`
- `HREF_GPIO_NUM = 23`
- `PCLK_GPIO_NUM = 22`

The library also validates OV3660 handling in the official example:

- `if (s->id.PID == OV3660_PID) { s->set_vflip(s, 1); }`

## Root cause to watch for

The installed CameraWebServer example includes `board_config.h` and the default selection is `CAMERA_MODEL_ESP_EYE`, not `CAMERA_MODEL_AI_THINKER`. That can lead to a board configuration mismatch even when the driver supports OV3660 correctly.

For this project, the correct board target is AI Thinker ESP32-CAM and the correct model selection is `CAMERA_MODEL_AI_THINKER`. The sensor itself is whatever the board reports at boot (OV3660 on the current hardware).

## Recommended upload setup

In Arduino IDE:

1. Install the ESP32 board package version 3.3.11.
2. Select board: `AI Thinker ESP32-CAM`.
3. Select partition scheme: a scheme with enough app space and PSRAM support.
4. Select serial port: COM8.
5. Set flash mode and PSRAM settings according to the board package defaults.
6. Use `firmware/camera/camera.ino` as the camera, provisioning, and diagnostics sketch.

## PSRAM guidance

PSRAM is important for the default UXGA stream and JPEG capture on ESP32-CAM boards. If the board has no PSRAM, the example reduces the frame size to avoid buffer overflow.

The official CameraWebServer example checks `psramFound()` and uses a lower frame size when PSRAM is missing.

## Expected serial output

The diagnostic sketch prints:

- `VISIONARY NEXUS ESP32-CAM DIAGNOSTIC`
- `PSRAM: present` or `PSRAM: missing`
- `Detected sensor: OV3660` (or `OV2640` / `OV5640`) when the sensor is seen correctly
- `Camera Ready! Use: http://<ip>` when the board has connected to Wi-Fi

## Runtime troubleshooting

If you see:

- `E (35) camera: Detected camera not supported.`
- `Camera probe failed with error 0x106 (ESP_ERR_NOT_SUPPORTED)`

then check all of the following:

1. Board model selected is `AI Thinker ESP32-CAM`.
2. `CAMERA_MODEL_AI_THINKER` is selected in the example or diagnostic sketch.
3. Camera ribbon cable orientation is correct and the sensor is seated properly.
4. Pin definitions match the AI Thinker mapping exactly.
5. PSRAM is available or the sketch is reducing resolution for a no-PSRAM board.
6. The camera is an OV2640/OV3660 module on the AI Thinker ESP32-CAM, not an S3 Sense variant.

## Backend integration

The Python backend exposes camera endpoints through the existing FastAPI app:

- `GET /api/camera/status`
- `POST /api/camera/capture`
- `GET /api/camera/devices`
- `POST /api/camera/heartbeat`
- `POST /api/camera/provision` (alias of the pairing-ticket endpoint)
- `POST /api/vision/ocr`, `POST /api/vision/detect`, `POST /api/vision/analyze`
- `POST /api/camera/analyze`

These endpoints are intentionally lightweight and keep the real hardware behind the backend abstraction.

## Physical verification required

The above steps are the engineering diagnosis based on the installed Arduino ESP32 package and source. Physical sensor initialization, streaming and `/capture.jpg` delivery must still be verified on the AI Thinker ESP32-CAM; the backend reports `provider: esp32` only once a device has actually checked in.
