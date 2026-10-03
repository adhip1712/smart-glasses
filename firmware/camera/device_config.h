// =========================================================
// VISIONARY NEXUS - ESP32-CAM DEVICE CONFIGURATION
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
// backend URL and mDNS resolution failed. Override it at build time with
// -DNEXUS_FALLBACK_BACKEND_HOST=\"192.168.1.100\" so the host lives in one
// place per site instead of inside the firmware logic.
#ifndef NEXUS_FALLBACK_BACKEND_HOST
#define NEXUS_FALLBACK_BACKEND_HOST "nexus-backend.local"
#endif

#ifndef NEXUS_FALLBACK_BACKEND_PORT
#define NEXUS_FALLBACK_BACKEND_PORT 8000
#endif

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
// FIRMWARE IDENTITY (informational only - not an authentication factor)
// ---------------------------------------------------------

#define NEXUS_FIRMWARE_VERSION "1.0.0"
#define NEXUS_MODEL "ESP32-CAM"
