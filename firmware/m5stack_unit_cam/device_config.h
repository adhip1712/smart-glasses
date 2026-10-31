// =========================================================
// VISIONARY NEXUS - M5STACK UNIT CAM DEVICE CONFIGURATION
// =========================================================
//
// The user types ONLY a Wi-Fi SSID and password (on the device's own setup
// page, or in the Visionary Nexus app). Everything else - backend address,
// device id, device token, API key - is obtained automatically:
//
//   backend URL : pushed by the app -> NVS "backend_url"
//                 fallback: mDNS "nexus-backend.local"
//                 fallback: the single constant below
//   device id   : assigned by the backend, stored in NVS
//   device token: assigned by the backend, stored in NVS
//
// Nothing here is a secret: no API key is compiled in, and the device can
// never mint an identity for itself.
// =========================================================

#pragma once

// ---------------------------------------------------------
// BACKEND DISCOVERY
// ---------------------------------------------------------
//
// LAST-RESORT compile-time fallback, used only when the app did not push a
// backend URL and mDNS resolution failed. It is a hostname, not an address:
// set it per site at build time (for example
// -DNEXUS_FALLBACK_BACKEND_HOST=\"<your-backend-host>\") instead of editing
// the firmware logic. No LAN IP is ever compiled in.
#ifndef NEXUS_FALLBACK_BACKEND_HOST
#define NEXUS_FALLBACK_BACKEND_HOST "nexus-backend.local"
#endif

#ifndef NEXUS_FALLBACK_BACKEND_PORT
#define NEXUS_FALLBACK_BACKEND_PORT 8000
#endif

// Ports tried (in order) when the backend address has to be discovered at
// runtime: whichever port answers /api/device/backend-info wins. This is why
// running the backend on 8001 needs no rebuild and no typing - the firmware
// finds it. The app can also push the exact URL over the setup AP.
#define NEXUS_CANDIDATE_PORTS { 8000, 8001, 8080 }

// mDNS hostname advertised by the backend machine (optional helper).
#ifndef NEXUS_MDNS_HOST
#define NEXUS_MDNS_HOST "nexus-backend"
#endif

// ---------------------------------------------------------
// ENDPOINTS (must match backend/device_api.py)
// ---------------------------------------------------------

#define NEXUS_SESSION_PATH     "/api/device/session"
#define NEXUS_CLAIM_PATH       "/api/device/claim"
#define NEXUS_CLAIM_POLL_PATH  "/api/device/claim/poll"
#define NEXUS_REGISTER_PATH    "/api/device/register"
#define NEXUS_HEARTBEAT_PATH   "/api/device/heartbeat"
#define NEXUS_BACKEND_INFO     "/api/device/backend-info"
#define NEXUS_REPORT_PATH      "/api/device/provision/report"

// ---------------------------------------------------------
// TIMING
// ---------------------------------------------------------

// Heartbeat interval. Must stay comfortably below the backend's
// DEVICE_HEARTBEAT_TIMEOUT_SECONDS (default 30s) or the device shows offline.
#define NEXUS_HEARTBEAT_INTERVAL_MS 10000UL

// Retry cadence for registration and for claim polling.
#define NEXUS_RETRY_MS 5000UL
#define NEXUS_CLAIM_POLL_MS 3000UL

// How long the setup access point stays open in one window.
#define NEXUS_SETUP_AP_TIMEOUT_MS 600000UL

// ---------------------------------------------------------
// LOCAL SETUP ACCESS POINT    (no credentials required from the user)
// ---------------------------------------------------------

#define NEXUS_SETUP_AP_SSID_PREFIX "VisionaryNexus-"
#define NEXUS_SETUP_AP_PASSWORD    "nexus-setup"

// ---------------------------------------------------------
// CAMERA (M5Stack Unit CAM U109/U109-B + OV2640)
// ---------------------------------------------------------
//
// Pin map follows the M5Stack Unit CAM U109/U109-B documentation.
// This board normally has no PSRAM, so cameraInit() selects DRAM and SVGA.

#define NEXUS_CAMERA_PIN_PWDN    -1
#define NEXUS_CAMERA_PIN_RESET   15
#define NEXUS_CAMERA_PIN_XCLK    27
#define NEXUS_CAMERA_PIN_SIOD    25   // SCCB SDA
#define NEXUS_CAMERA_PIN_SIOC    23   // SCCB SCL
#define NEXUS_CAMERA_PIN_D7      19   // Y9
#define NEXUS_CAMERA_PIN_D6      36   // Y8
#define NEXUS_CAMERA_PIN_D5      18   // Y7
#define NEXUS_CAMERA_PIN_D4      39   // Y6
#define NEXUS_CAMERA_PIN_D3       5   // Y5
#define NEXUS_CAMERA_PIN_D2      34   // Y4
#define NEXUS_CAMERA_PIN_D1      35   // Y3
#define NEXUS_CAMERA_PIN_D0      32   // Y2
#define NEXUS_CAMERA_PIN_VSYNC   22
#define NEXUS_CAMERA_PIN_HREF    26
#define NEXUS_CAMERA_PIN_PCLK    21
#define NEXUS_CAMERA_PIN_FLASH    4   // Unit CAM blue status LED

#define NEXUS_CAMERA_XCLK_HZ      20000000
#define NEXUS_CAMERA_JPEG_QUALITY 12   // 10 when PSRAM is present, see camera.ino

// ---------------------------------------------------------
// FIRMWARE IDENTITY (informational only - not an authentication factor)
// ---------------------------------------------------------

#define NEXUS_FIRMWARE_VERSION "1.1.0-m5unitcam"
#define NEXUS_MODEL "M5Stack Unit CAM"

