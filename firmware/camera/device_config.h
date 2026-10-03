// =========================================================
// VISIONARY NEXUS - ESP32-CAM DEVICE CONFIGURATION
// =========================================================
//
// Compile-time configuration for the device lifecycle:
//
//   provision Wi-Fi -> transfer the existing device credential
//   -> register against THAT device -> heartbeat -> ONLINE
//
// The firmware never invents a device identity: `device_id` and
// `device_token` are assigned by the backend and stored in NVS.
// =========================================================

#pragma once

// ---------------------------------------------------------
// BACKEND
// ---------------------------------------------------------

// IP of the machine running backend/api.py (or a hostname / ngrok url).
// No trailing slash.
#define NEXUS_BACKEND_URL "http://192.168.1.100:8000"

// Endpoints (must match backend/device_api.py).
#define NEXUS_SESSION_PATH     "/api/device/session"
#define NEXUS_PROVISION_STATUS "/api/device/provision/status"
#define NEXUS_CREDENTIALS_PATH "/api/device/provision/credentials"
#define NEXUS_REPORT_PATH      "/api/device/provision/report"
#define NEXUS_REGISTER_PATH    "/api/device/register"
#define NEXUS_HEARTBEAT_PATH   "/api/device/heartbeat"

// ---------------------------------------------------------
// TIMING
// ---------------------------------------------------------

// How often the device talks to /api/device/heartbeat. The backend marks a
// device offline when it stops hearing from it (DEVICE_HEARTBEAT_TIMEOUT_SECONDS),
// so this must be comfortably shorter than that timeout.
#define NEXUS_HEARTBEAT_INTERVAL_MS 10000UL

// Registration is retried with a fixed backoff - it is idempotent, so
// retrying can never create a second device.
#define NEXUS_REGISTER_RETRY_MS 5000UL

// How long the local setup access point stays open while waiting for the
// Wi-Fi credentials / pairing code to be written to NVS.
#define NEXUS_SETUP_AP_TIMEOUT_MS 300000UL

// ---------------------------------------------------------
// LOCAL SETUP ACCESS POINT
// ---------------------------------------------------------

// The setup page runs here; the phone/desktop app opens
// http://192.168.4.1/ and posts the credentials it received from
// POST /api/device/provision (ssid, password, pairing_code, device_id).
#define NEXUS_SETUP_AP_SSID_PREFIX "VisionaryNexus-"
#define NEXUS_SETUP_AP_PASSWORD    "nexus-setup"

// ---------------------------------------------------------
// FIRMWARE IDENTITY
// ---------------------------------------------------------

#define NEXUS_FIRMWARE_VERSION "1.0.0"
#define NEXUS_MODEL "ESP32-CAM"
