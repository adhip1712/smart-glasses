// =========================================================
// VISIONARY NEXUS - ESP32-CAM DEVICE LIFECYCLE
// =========================================================
//
// Physical, zero-typing setup for an AI-Thinker ESP32-CAM:
//
//   1. first boot: listen on the setup AP and serve a page that asks for
//      ONLY a Wi-Fi SSID + password
//   2. store them in NVS and join that network
//   3. announce ourselves to the backend (POST /api/device/claim) using the
//      chip id (efuse MAC) and a device-generated claim secret
//   4. the user approves the physical device in the Visionary Nexus app
//   5. poll POST /api/device/claim/poll and receive the legitimate,
//      backend-assigned credential (device_id + device_token) and, if the
//      backend knows them, the Wi-Fi credentials + backend URL
//   6. store everything in NVS, POST /api/device/register, then
//      POST /api/device/heartbeat on an interval - heartbeats are the only
//      thing that moves the device to ONLINE
//
// The user is never asked for a backend URL, device id, pairing ticket,
// device token, IP address, port, MAC address or API key, and no API key is
// compiled into the firmware. Nothing here can create a new device record:
// every call addresses the device the backend already assigned to us.
//
// Function map:
//   credential received by ... fetchClaimCredential() / handleAppCredentials()
//   stored under Preferences   device_id, device_token (namespace "nexus")
//   registration sent by ..... registerDevice()
//   auth header .............. Authorization: Bearer <device_token> (postJson)
//   heartbeat endpoint ....... NEXUS_HEARTBEAT_PATH via sendHeartbeat()
//   backend URL resolved by .. resolveBackendUrl() (NVS -> mDNS -> fallback)
//   after reboot ............. loadIdentity() -> PHASE_CONNECT (no new claim)
//   on Wi-Fi change .......... PHASE_SETUP_AP reopens, identity is kept
// =========================================================

#include <WiFi.h>
#include <WiFiUdp.h>
#include <ESPmDNS.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <Preferences.h>
#include <esp_system.h>
#include "esp_camera.h"          // OV2640 driver, bundled with the ESP32 core

#include "device_config.h"

// =========================================================
// CAMERA FRAME STREAM
// =========================================================
//
// A read-only Stream over one JPEG frame buffer. It is used by the /capture
// endpoint to hand a frame to WebServer 2.0.17, which has no
// send(code, content_type, Stream&, length) overload (that one exists only on
// arduino-esp32 master). Nothing else in the sketch depends on this class.

class CameraFrameStream : public Stream {
 public:
  CameraFrameStream(const uint8_t *data, size_t length)
    : data_(data), length_(length), position_(0) {}

  int available() override { return (int)(length_ - position_); }
  int read() override { return position_ < length_ ? data_[position_++] : -1; }
  int peek() override { return position_ < length_ ? data_[position_] : -1; }
  size_t write(uint8_t) override { return 0; }   // read-only stream

  size_t readBytes(char *buffer, size_t length) override {
    size_t count = 0;

    while (count < length && position_ < length_) {
      buffer[count++] = (char)data_[position_++];
    }

    return count;
  }

 private:
  const uint8_t *data_;
  size_t length_;
  size_t position_;
};

// =========================================================
// STATE
// =========================================================

enum Phase {
  PHASE_SETUP_AP,   // user types Wi-Fi SSID + password on 192.168.4.1
  PHASE_CONNECT,    // joining that network
  PHASE_CLAIM,      // announcing ourselves and waiting for approval
  PHASE_REGISTER,   // registering with the backend-assigned token
  PHASE_HEARTBEAT,  // steady state
};

Preferences preferences;
WebServer setupServer(80);

Phase phase = PHASE_SETUP_AP;

String hardwareUid;    // "A0:B1:C2:03:04:05" - derived from the chip efuse
String deviceId;       // assigned by the backend, stored in NVS
String deviceToken;    // assigned by the backend, stored in NVS
String claimId;        // current claim, transient
String claimSecret;    // device-generated continuity secret, NVS
String backendUrl;     // resolved automatically, NVS
String wifiSsid;
String wifiPassword;

bool wifiCredentialsKnown = false;
bool wifiUp = false;
bool registered = false;
bool credentialsCaptured = false;
bool cameraReady = false;
bool cameraAttempted = false;

String cameraSensor = "";

int cameraFailures = 0;
int wifiFailures = 0;
int authFailures = 0;
int claimFailures = 0;
int claimPolls = 0;

unsigned long setupApDeadlineMs = 0;
unsigned long lastConnectAttemptMs = 0;
unsigned long lastRegisterAttemptMs = 0;
unsigned long lastClaimPollMs = 0;
unsigned long lastHeartbeatMs = 0;
unsigned long lastCameraAttemptMs = 0;

// =========================================================
// SMALL HELPERS
// =========================================================

String chipHardwareUid() {
  uint64_t chipId = ESP.getEfuseMac();
  char buffer[18];

  snprintf(
    buffer,
    sizeof(buffer),
    "%02X:%02X:%02X:%02X:%02X:%02X",
    (uint8_t)(chipId >> 40),
    (uint8_t)(chipId >> 32),
    (uint8_t)(chipId >> 24),
    (uint8_t)(chipId >> 16),
    (uint8_t)(chipId >> 8),
    (uint8_t)(chipId)
  );

  return String(buffer);
}

String randomSecret() {
  char buffer[33];

  for (int i = 0; i < 32; i += 8) {
    snprintf(buffer + i, 9, "%08x", (unsigned int)esp_random());
  }

  buffer[32] = '\0';

  return String(buffer);
}

String jsonEscape(const String &value) {
  String out = value;
  out.replace("\\", "\\\\");
  out.replace("\"", "\\\"");
  return out;
}

/** Extract "key":"value" from a small JSON response. */
String jsonString(const String &document, const String &key) {
  String needle = "\"" + key + "\":\"";
  int index = document.indexOf(needle);

  if (index < 0) {
    return String();
  }

  int start = index + needle.length();
  int end = document.indexOf('"', start);

  if (end <= start) {
    return String();
  }

  String value = document.substring(start, end);

  return value == "null" ? String() : value;
}

String jsonFirstArrayString(const String &document, const String &key) {
  String needle = "\"" + key + "\":[\"";
  int index = document.indexOf(needle);

  if (index < 0) {
    return String();
  }

  int start = index + needle.length();
  int end = document.indexOf('"', start);

  if (end <= start) {
    return String();
  }

  return document.substring(start, end);
}

// =========================================================
// NVS
// =========================================================

void loadIdentity() {
  preferences.begin("nexus", false);

  hardwareUid = chipHardwareUid();
  deviceId = preferences.getString("device_id", "");
  deviceToken = preferences.getString("device_token", "");
  wifiSsid = preferences.getString("wifi_ssid", "");
  wifiPassword = preferences.getString("wifi_password", "");
  backendUrl = preferences.getString("backend_url", "");
  claimId = preferences.getString("claim_id", "");
  claimSecret = preferences.getString("claim_secret", "");

  // Device-generated continuity secret: created once, only used to prove
  // that the poller is the same board that opened the claim.
  if (!claimSecret.length()) {
    claimSecret = randomSecret();
    preferences.putString("claim_secret", claimSecret);
  }

  wifiCredentialsKnown = wifiSsid.length() > 0;
  registered = deviceToken.length() > 0;

  Serial.printf(
    "[boot] hardware_uid=%s device_id=%s token=%s wifi=%s backend=%s\n",
    hardwareUid.c_str(),
    deviceId.length() ? deviceId.c_str() : "(unassigned)",
    deviceToken.length() ? "stored" : "(none)",
    wifiCredentialsKnown ? wifiSsid.c_str() : "(unset)",
    backendUrl.length() ? backendUrl.c_str() : "(will resolve)"
  );
}

/** Persist whatever the backend handed us. These are the only keys that
 *  carry an identity, and they are written in exactly one place. */
void persistCredential() {
  preferences.putString("device_id", deviceId);
  preferences.putString("device_token", deviceToken);
  preferences.putString("claim_id", claimId);
}

void persistWifi() {
  preferences.putString("wifi_ssid", wifiSsid);
  preferences.putString("wifi_password", wifiPassword);
}

void persistBackendUrl() {
  preferences.putString("backend_url", backendUrl);
}

/** Used when the backend rejects our credential (token rotated/revoked).
 *  We keep the device id - the record stays the same - and ask for the
 *  credential again through a new claim. */
void forgetCredential() {
  deviceToken = "";
  registered = false;
  preferences.remove("device_token");
  preferences.remove("claim_id");
  claimId = "";

  Serial.println("[auth] credential cleared - re-claiming the same device");
}

// =========================================================
// BACKEND URL RESOLUTION  (never typed by the user)
// =========================================================

String fallbackBackendUrl() {
  return String("http://") + NEXUS_FALLBACK_BACKEND_HOST + ":" +
         String(NEXUS_FALLBACK_BACKEND_PORT);
}

/** Ask a candidate address whether the Visionary Nexus API lives there.
 *  Used while discovering the backend at runtime so the port does not have to
 *  be compiled in or typed by the user. */
bool probeBackend(const String &base) {
  HTTPClient http;

  if (!http.begin(base + NEXUS_BACKEND_INFO)) {
    return false;
  }

  http.setTimeout(4000);

  int status = http.GET();
  String body = http.getString();

  http.end();

  return status == 200 && body.indexOf("\"urls\"") >= 0;
}

/** Try each candidate port on a host and return the first backend that
 *  answers /api/device/backend-info. This is how a backend running on 8001
 *  (or any other port) is found without the user typing anything. */
String discoverBackendOnHost(const String &host, int fallbackPort) {
  const int candidatePorts[] = NEXUS_CANDIDATE_PORTS;

  for (unsigned int i = 0; i < sizeof(candidatePorts) / sizeof(candidatePorts[0]); i++) {
    int port = candidatePorts[i];

    if (port == fallbackPort) {
      continue;  // tried first, below
    }

    String url = String("http://") + host + ":" + String(port);

    if (probeBackend(url)) {
      return url;
    }
  }

  String preferred = String("http://") + host + ":" + String(fallbackPort);

  if (probeBackend(preferred)) {
    return preferred;
  }

  return String();
}

/** Priority: value pushed by the app / delivered by the backend (NVS) ->
 *  mDNS name -> compile-time fallback host. In every case the port is
 *  discovered at runtime, so an environment-driven port (e.g. 8001) needs no
 *  rebuild and no typing. */
String resolveBackendUrl() {
  if (backendUrl.length()) {
    return backendUrl;
  }

  // 1. mDNS: the backend machine advertises itself on the local network.
  if (MDNS.begin("nexus-glasses")) {
    for (int attempt = 0; attempt < 3; attempt++) {
      if (MDNS.queryService(NEXUS_MDNS_HOST, "tcp") > 0) {
        IPAddress resolved = MDNS.IP(0);

        if ((uint32_t)resolved != 0) {
          String url = discoverBackendOnHost(resolved.toString(), NEXUS_FALLBACK_BACKEND_PORT);

          if (url.length()) {
            Serial.printf("[backend] discovered via mDNS: %s\n", url.c_str());
            return url;
          }
        }
      }

      delay(200);
    }
  }

  // 2. Compile-time fallback host (a name, never a hardcoded IP).
  String host = String(NEXUS_FALLBACK_BACKEND_HOST);
  String url = discoverBackendOnHost(host, NEXUS_FALLBACK_BACKEND_PORT);

  if (url.length()) {
    Serial.printf("[backend] discovered at %s\n", url.c_str());
    return url;
  }

  Serial.println("[backend] no backend answered - set the address from the app");
  return fallbackBackendUrl();
}

void setBackendUrl(const String &url) {
  if (!url.length()) {
    return;
  }

  String cleaned = url;
  cleaned.trim();

  while (cleaned.endsWith("/")) {
    cleaned.remove(cleaned.length() - 1);
  }

  if (cleaned == backendUrl) {
    return;
  }

  backendUrl = cleaned;
  persistBackendUrl();

  Serial.printf("[backend] url set to %s\n", backendUrl.c_str());
}

// =========================================================
// HTTP
// =========================================================

/** Every authenticated call carries the backend-assigned device token in a
 *  standard Authorization: Bearer header. No API key exists in this build. */
bool postJson(
  const String &path,
  const String &payload,
  String &response,
  bool authenticated = false
) {
  if (WiFi.status() != WL_CONNECTED) {
    return false;
  }

  String base = resolveBackendUrl();

  if (!base.length()) {
    return false;
  }

  HTTPClient http;
  http.begin(base + path);
  http.addHeader("Content-Type", "application/json");

  if (authenticated && deviceToken.length()) {
    http.addHeader("Authorization", String("Bearer ") + deviceToken);
  }

  http.setTimeout(8000);

  int status = http.POST(payload);

  response = http.getString();
  http.end();

  if (status == 401 || status == 403) {
    Serial.printf("[http] %s rejected the credential (status %d)\n", path.c_str(), status);
    authFailures++;
  } else if (status >= 200 && status < 300) {
    authFailures = 0;
  }

  return status >= 200 && status < 300;
}

// =========================================================
// SETUP ACCESS POINT - Wi-Fi SSID + password only
// =========================================================

const char SETUP_PAGE[] PROGMEM = R"HTML(
<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Visionary Nexus - device setup</title>
<style>body{background:#030712;color:#e5e7eb;font:15px/1.6 monospace;padding:24px;max-width:520px;margin:auto}
h3{letter-spacing:.12em;color:#00e5ff;font-weight:600}label{display:block;margin-top:18px;color:#94a3b8;font-size:12px;letter-spacing:.1em;text-transform:uppercase}
input{width:100%;padding:12px;margin-top:6px;background:#0b1220;color:#e5e7eb;border:1px solid #1f2937;border-radius:10px;font-size:15px}
button{margin-top:22px;width:100%;padding:14px;background:#082f49;color:#00e5ff;border:1px solid #00e5ff55;border-radius:12px;letter-spacing:.12em}
p{color:#64748b;font-size:12px}</style></head><body>
<h3>VISIONARY NEXUS &middot; DEVICE SETUP</h3>
<p>Enter your Wi-Fi details. The device obtains its Visionary Nexus identity
automatically - no codes, tokens or addresses to type.</p>
<form method="POST" action="/configure">
  <label>Wi-Fi network</label><input name="ssid" required autofocus>
  <label>Wi-Fi password</label><input name="password" type="password">
  <button type="submit">Connect device</button>
</form></body></html>
)HTML";

const char CONFIGURED_PAGE[] PROGMEM = R"HTML(
<!doctype html><html><head><meta charset="utf-8"><title>Visionary Nexus</title>
<style>body{background:#030712;color:#e5e7eb;font:15px/1.6 monospace;padding:32px}h3{color:#4ade80}</style>
</head><body><h3>Wi-Fi saved</h3><p>The device is joining your network and will appear in
the Visionary Nexus app for approval.</p></body></html>
)HTML";

void sendCorsHeaders() {
  setupServer.sendHeader("Access-Control-Allow-Origin", "*");
  setupServer.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  setupServer.sendHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

void handleSetupRoot() {
  setupServer.send_P(200, "text/html", SETUP_PAGE);
}

/** The user submits SSID + password. That is the entire user input. */
void handleConfigure() {
  wifiSsid = setupServer.arg("ssid");
  wifiPassword = setupServer.arg("password");

  wifiCredentialsKnown = wifiSsid.length() > 0;
  credentialsCaptured = true;

  persistWifi();

  Serial.printf("[setup] user supplied Wi-Fi \"%s\"\n", wifiSsid.c_str());

  setupServer.send_P(200, "text/html", CONFIGURED_PAGE);
}

/** Optional: the Visionary Nexus app pushes the backend address it is using
 *  (POST http://192.168.4.1/api/backend). The user never types it. */
void handleAppBackend() {
  String url = setupServer.arg("url");

  if (!url.length() && setupServer.hasArg("plain")) {
    url = jsonString(setupServer.arg("plain"), "backend_url");
  }

  if (url.length()) {
    setBackendUrl(url);
  }

  sendCorsHeaders();
  setupServer.send(200, "application/json", "{\"ok\":true}");
}

/** Optional: the app pushes the credential directly over the local channel
 *  (used when the phone is already on the device's AP). The credential is
 *  the backend-assigned one - the device never invents it. */
void handleAppCredentials() {
  String body = setupServer.hasArg("plain") ? setupServer.arg("plain") : "";

  String pushedDeviceId = jsonString(body, "device_id");
  String pushedToken = jsonString(body, "device_token");
  String pushedBackend = jsonString(body, "backend_url");
  String pushedSsid = jsonString(body, "ssid");
  String pushedPassword = jsonString(body, "password");

  if (pushedBackend.length()) {
    setBackendUrl(pushedBackend);
  }

  if (pushedSsid.length()) {
    wifiSsid = pushedSsid;
    wifiPassword = pushedPassword;
    wifiCredentialsKnown = true;
    credentialsCaptured = true;
    persistWifi();
  }

  if (pushedDeviceId.length() && pushedToken.length()) {
    deviceId = pushedDeviceId;
    deviceToken = pushedToken;
    registered = true;
    persistCredential();

    Serial.printf("[setup] credential received from the app for %s\n", deviceId.c_str());
  }

  sendCorsHeaders();
  setupServer.send(
    200,
    "application/json",
    "{\"ok\":true,\"device_id\":\"" + jsonEscape(deviceId) + "\"}"
  );
}

void handleOptions() {
  sendCorsHeaders();
  setupServer.send(204);
}

void handleDeviceStatus() {
  String body = "{";
  body += "\"hardware_uid\":\"" + jsonEscape(hardwareUid) + "\",";
  body += "\"device_id\":\"" + jsonEscape(deviceId) + "\",";
  body += "\"has_credential\":" + String(deviceToken.length() ? "true" : "false") + ",";
  body += "\"wifi_configured\":" + String(wifiCredentialsKnown ? "true" : "false") + ",";
  body += "\"phase\":" + String((int)phase) + ",";
  body += "\"camera_ready\":" + String(cameraReady ? "true" : "false") + ",";
  body += "\"camera_sensor\":\"" + jsonEscape(cameraSensor) + "\",";
  body += "\"psram\":" + String(psramFound() ? "true" : "false") + ",";
  body += "\"firmware\":\"" NEXUS_FIRMWARE_VERSION "\"}";

  sendCorsHeaders();
  setupServer.send(200, "application/json", body);
}

/** GET /capture - one JPEG frame straight from the OV2640.
 *
 *  WebServer on core 2.0.17 offers no Stream overload of send(), so the frame
 *  is written with the public 2.0.17 API. The client receives an identical
 *  response: same status, same Content-Type, same Content-Length, same bytes.
 *  The OV2640 stays the only source of frames - if it did not initialise, the
 *  endpoint answers 503 and never pretends to have an image. */
void handleCapture() {
  if (!cameraReady) {
    sendCorsHeaders();
    setupServer.send(503, "text/plain", "camera not ready");
    return;
  }

  camera_fb_t *fb = esp_camera_fb_get();

  if (fb == NULL) {
    sendCorsHeaders();
    setupServer.send(500, "text/plain", "camera capture failed");
    return;
  }

  CameraFrameStream frameStream(fb->buf, fb->len);
  size_t frameLength = fb->len;

  sendCorsHeaders();

  if (frameLength == 0) {
    setupServer.send(204);
  } else {
    setupServer.setContentLength(frameLength);
    setupServer.send(200, "image/jpeg", "");

    static uint8_t pump[1024];
    size_t remaining = frameLength;

    while (remaining > 0) {
      size_t chunk = (remaining > sizeof(pump)) ? sizeof(pump) : remaining;
      size_t got = frameStream.readBytes((char *)pump, chunk);

      if (got == 0) break;

      setupServer.sendContent((const char *)pump, got);
      remaining -= got;
    }
  }

  esp_camera_fb_return(fb);
}

void startSetupAccessPoint() {
  String apName = String(NEXUS_SETUP_AP_SSID_PREFIX) + hardwareUid.substring(12);

  WiFi.mode(WIFI_AP);
  WiFi.softAP(apName.c_str(), NEXUS_SETUP_AP_PASSWORD);

  setupServer.on("/", HTTP_GET, handleSetupRoot);
  setupServer.on("/configure", HTTP_POST, handleConfigure);
  setupServer.on("/api/backend", HTTP_POST, handleAppBackend);
  setupServer.on("/api/backend", HTTP_OPTIONS, handleOptions);
  setupServer.on("/api/credentials", HTTP_POST, handleAppCredentials);
  setupServer.on("/api/credentials", HTTP_OPTIONS, handleOptions);
  setupServer.on("/api/status", HTTP_GET, handleDeviceStatus);
  setupServer.on("/capture", HTTP_GET, handleCapture);
  setupServer.begin();

  credentialsCaptured = false;
  setupApDeadlineMs = millis() + NEXUS_SETUP_AP_TIMEOUT_MS;
  phase = PHASE_SETUP_AP;

  Serial.printf("[setup] access point \"%s\" open - waiting for Wi-Fi details\n", apName.c_str());
}

// =========================================================
// WI-FI
// =========================================================

bool joinWifi() {
  if (!wifiCredentialsKnown) {
    return false;
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());

  Serial.printf("[wifi] joining %s", wifiSsid.c_str());

  unsigned long deadline = millis() + 20000UL;

  while (WiFi.status() != WL_CONNECTED && millis() < deadline) {
    delay(400);
    Serial.print(".");
  }

  wifiUp = WiFi.status() == WL_CONNECTED;

  if (!wifiUp) {
    wifiFailures++;
    Serial.printf("\n[wifi] join failed (%d)\n", wifiFailures);
    return false;
  }

  wifiFailures = 0;
  Serial.printf("\n[wifi] connected ip=%s rssi=%d\n",
                WiFi.localIP().toString().c_str(),
                WiFi.RSSI());

  return true;
}

// =========================================================
// CLAIM  (announce + wait for approval + receive credential)
// =========================================================

/** Tell the backend this physical board is online and ready to be approved. */
bool announceClaim() {
  String payload = "{";
  payload += "\"hardware_uid\":\"" + jsonEscape(hardwareUid) + "\",";
  payload += "\"claim_secret\":\"" + jsonEscape(claimSecret) + "\",";
  payload += "\"firmware\":\"" NEXUS_FIRMWARE_VERSION "\",";
  payload += "\"model\":\"" NEXUS_MODEL "\",";
  payload += "\"ap_ssid\":\"" + jsonEscape(NEXUS_SETUP_AP_SSID_PREFIX + hardwareUid.substring(12)) + "\"}";

  String response;

  if (!postJson(NEXUS_CLAIM_PATH, payload, response)) {
    Serial.println("[claim] announcement failed");
    return false;
  }

  claimId = jsonString(response, "claim_id");

  if (!claimId.length()) {
    Serial.println("[claim] backend did not return a claim id");
    return false;
  }

  preferences.putString("claim_id", claimId);
  claimPolls = 0;

  Serial.printf("[claim] waiting for approval in the app (claim %s)\n", claimId.c_str());

  return true;
}

/** Poll for the user's approval and receive the backend-assigned credential.
 *  This is the function through which a physical device obtains its token. */
bool fetchClaimCredential() {
  if (!claimId.length()) {
    return false;
  }

  String payload = "{";
  payload += "\"claim_id\":\"" + jsonEscape(claimId) + "\",";
  payload += "\"claim_secret\":\"" + jsonEscape(claimSecret) + "\"}";

  String response;

  if (!postJson(NEXUS_CLAIM_POLL_PATH, payload, response)) {
    Serial.println("[claim] poll failed");
    return false;
  }

  String state = jsonString(response, "claim_state");

  if (state == "pending_approval") {
    return false;
  }

  if (state == "rejected" || state == "expired") {
    Serial.printf("[claim] %s - reopening the setup access point\n", state.c_str());
    preferences.remove("claim_id");
    claimId = "";
    startSetupAccessPoint();
    return false;
  }

  if (state != "delivered") {
    return false;
  }

  String returnedDeviceId = jsonString(response, "device_id");
  String returnedToken = jsonString(response, "device_token");

  if (!returnedDeviceId.length() || !returnedToken.length()) {
    Serial.println("[claim] credential missing from the delivery");
    return false;
  }

  // Never adopt a different identity than the one this board is bound to.
  if (deviceId.length() && deviceId != returnedDeviceId) {
    Serial.println("[claim] backend returned another device - refusing");
    return false;
  }

  deviceId = returnedDeviceId;
  deviceToken = returnedToken;
  registered = false;

  String deliveredSsid = jsonString(response, "ssid");

  if (deliveredSsid.length()) {
    wifiSsid = deliveredSsid;
    String deliveredPassword = jsonString(response, "password");

    if (deliveredPassword.length()) {
      wifiPassword = deliveredPassword;
    }

    wifiCredentialsKnown = true;
    persistWifi();
  }

  // The backend tells us where it lives, so the address is never typed.
  String deliveredUrl = jsonString(response, "backend_url");

  if (!deliveredUrl.length()) {
    deliveredUrl = jsonFirstArrayString(response, "backend_urls");
  }

  if (deliveredUrl.length()) {
    setBackendUrl(deliveredUrl);
  }

  persistCredential();

  Serial.printf("[claim] credential received for %s\n", deviceId.c_str());

  return true;
}

// =========================================================
// CAMERA  (AI Thinker ESP32-CAM + OV2640)
// =========================================================
//
// Camera readiness is decided ONLY by a successful esp_camera_init() on the
// physical sensor. A connected Wi-Fi link, a registered device or an
// incoming heartbeat never set this flag.
//
// Pin map and sensor settings mirror the ESP32 Arduino core's own
// CameraWebServer example for CAMERA_MODEL_AI_THINKER.

bool cameraInit() {
  // Zero-initialised so driver fields we do not set (e.g. sccb_i2c_port)
  // are defined values rather than stack garbage.
  camera_config_t config = {};

  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;

  config.pin_d0 = NEXUS_CAMERA_PIN_D0;
  config.pin_d1 = NEXUS_CAMERA_PIN_D1;
  config.pin_d2 = NEXUS_CAMERA_PIN_D2;
  config.pin_d3 = NEXUS_CAMERA_PIN_D3;
  config.pin_d4 = NEXUS_CAMERA_PIN_D4;
  config.pin_d5 = NEXUS_CAMERA_PIN_D5;
  config.pin_d6 = NEXUS_CAMERA_PIN_D6;
  config.pin_d7 = NEXUS_CAMERA_PIN_D7;

  config.pin_xclk = NEXUS_CAMERA_PIN_XCLK;
  config.pin_pclk = NEXUS_CAMERA_PIN_PCLK;
  config.pin_vsync = NEXUS_CAMERA_PIN_VSYNC;
  config.pin_href = NEXUS_CAMERA_PIN_HREF;
  config.pin_sccb_sda = NEXUS_CAMERA_PIN_SIOD;
  config.pin_sccb_scl = NEXUS_CAMERA_PIN_SIOC;
  config.pin_pwdn = NEXUS_CAMERA_PIN_PWDN;
  config.pin_reset = NEXUS_CAMERA_PIN_RESET;

  config.xclk_freq_hz = NEXUS_CAMERA_XCLK_HZ;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAMESIZE_UXGA;
  config.jpeg_quality = NEXUS_CAMERA_JPEG_QUALITY;
  config.fb_count = 1;
  config.fb_location = CAMERA_FB_IN_PSRAM;
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;

  // The AI Thinker board ships 4 MB of PSRAM; without it, limit the frame
  // size and keep the frame buffer in DRAM (same logic as Espressif's example).
  if (psramFound()) {
    config.jpeg_quality = 10;
    config.fb_count = 2;
    config.grab_mode = CAMERA_GRAB_LATEST;
  } else {
    config.frame_size = FRAMESIZE_SVGA;
    config.fb_location = CAMERA_FB_IN_DRAM;
  }

  Serial.printf(
    "[camera] OV2640 init: xclk=%dMHz psram=%s fb=%d\n",
    NEXUS_CAMERA_XCLK_HZ / 1000000,
    psramFound() ? "yes" : "no",
    (int)config.fb_count
  );

  esp_err_t error = esp_camera_init(&config);

  if (error != ESP_OK) {
    // 0x105 == ESP_ERR_NOT_FOUND: the SCCB bus answered nothing, i.e. the
    // camera module is absent or badly seated.
    Serial.printf("[camera] esp_camera_init failed (0x%x)\n", error);
    return false;
  }

  sensor_t *sensor = esp_camera_sensor_get();

  if (sensor == NULL) {
    Serial.println("[camera] no sensor after init");
    esp_camera_deinit();
    return false;
  }

  char pid[16];

  snprintf(pid, sizeof(pid), "0x%02X", sensor->id.PID);

  cameraSensor = String(pid);

  // Probe the sensor once: a real OV2640 must answer with a frame.
  camera_fb_t *frame = esp_camera_fb_get();

  if (frame == NULL) {
    Serial.println("[camera] sensor present but produced no frame");
    esp_camera_deinit();
    cameraSensor = "";
    return false;
  }

  Serial.printf(
    "[camera] READY: pid=%s frame=%ux%u %u bytes\n",
    cameraSensor.c_str(),
    frame->width,
    frame->height,
    (unsigned)frame->len
  );

  esp_camera_fb_return(frame);

  return true;
}

/** Report the camera state to the backend (same report endpoint the rest of
 *  the lifecycle uses). Never used to claim readiness without init success. */
void reportCameraState(bool ready) {
  if (!deviceId.length()) {
    return;
  }

  String payload = "{";
  payload += "\"device_id\":\"" + jsonEscape(deviceId) + "\",";
  payload += "\"device_token\":\"" + jsonEscape(deviceToken) + "\",";
  payload += "\"hardware_uid\":\"" + jsonEscape(hardwareUid) + "\",";
  payload += "\"firmware\":\"" NEXUS_FIRMWARE_VERSION "\",";
  payload += "\"event\":\"" + String(ready ? "camera_ready" : "camera_failed") + "\",";

  if (ready) {
    payload += "\"sensor\":\"" + jsonEscape(cameraSensor) + "\",";
    payload += "\"psram\":" + String(psramFound() ? "true" : "false") + ",";
    payload += "\"error\":\"\"}";
  } else {
    payload += "\"error\":\"OV2640 did not initialise\"}";
  }

  String response;
  postJson(NEXUS_REPORT_PATH, payload, response, true);
}

/** Called once the device is registered (the flow reaches the camera only
 *  after the device is online). Retried a few times - a failed init is often
 *  just a brown-out or a loose ribbon cable. */
void ensureCameraReady() {
  if (cameraReady) {
    return;
  }

  if (cameraAttempted && (millis() - lastCameraAttemptMs) < 30000UL) {
    return;
  }

  lastCameraAttemptMs = millis();
  cameraAttempted = true;

  bool ready = cameraInit();

  if (ready) {
    cameraReady = true;
    cameraFailures = 0;
    reportCameraState(true);
    return;
  }

  cameraFailures++;

  if (cameraFailures == 1) {
    reportCameraState(false);
  }
}

// =========================================================
// REGISTRATION
// =========================================================

bool registerDevice() {
  if (!deviceId.length() || !deviceToken.length()) {
    return false;
  }

  String payload = "{";
  payload += "\"device_id\":\"" + jsonEscape(deviceId) + "\",";
  payload += "\"hardware_uid\":\"" + jsonEscape(hardwareUid) + "\",";
  payload += "\"firmware\":\"" NEXUS_FIRMWARE_VERSION "\",";
  payload += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  payload += "\"rssi\":" + String(WiFi.RSSI()) + "}";

  String response;

  // The token travels in the Authorization header; the body keeps a copy for
  // compatibility with the same endpoint used by tools/device_sim.py.
  String withToken = payload;
  withToken.remove(withToken.length() - 1);
  withToken += ",\"device_token\":\"" + jsonEscape(deviceToken) + "\"}";

  if (!postJson(NEXUS_REGISTER_PATH, withToken, response, true)) {
    Serial.println("[register] rejected - retrying with the same identity");

    if (authFailures >= 3) {
      forgetCredential();
      phase = PHASE_CLAIM;
    }

    return false;
  }

  registered = true;
  authFailures = 0;
  lastHeartbeatMs = 0;

  Serial.println("[register] ok - backend updated the existing device");

  return true;
}

// =========================================================
// HEARTBEAT
// =========================================================

void sendHeartbeat() {
  String payload = "{";
  payload += "\"device_id\":\"" + jsonEscape(deviceId) + "\",";
  payload += "\"device_token\":\"" + jsonEscape(deviceToken) + "\",";
  payload += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  payload += "\"rssi\":" + String(WiFi.RSSI()) + ",";
  payload += "\"uptime_ms\":" + String(millis()) + ",";
  payload += "\"firmware\":\"" NEXUS_FIRMWARE_VERSION "\"}";

  String response;

  if (postJson(NEXUS_HEARTBEAT_PATH, payload, response, true)) {
    Serial.println("[heartbeat] ok");

    // ONLINE is reached: bring the camera up (OV2640 initialisation is the
    // only thing that may report "camera READY").
    if (!cameraReady) {
      ensureCameraReady();
    }

    return;
  }

  Serial.println("[heartbeat] failed");

  if (authFailures >= 3) {
    // The credential is no longer valid (rotated, or the backend was reset).
    // Keep the device id, ask for a fresh one through a new claim.
    forgetCredential();
    phase = PHASE_CLAIM;
  }
}

// =========================================================
// BOOT / LOOP
// =========================================================

void setup() {
  Serial.begin(115200);
  delay(300);

  Serial.println("\n========================================");
  Serial.println("VISIONARY NEXUS - ESP32-CAM");
  Serial.println("========================================");

  loadIdentity();

  if (wifiCredentialsKnown) {
    // Reboot / power cycle / re-flash with NVS intact: reconnect as the same
    // device. If we already own a credential the claim step is skipped.
    phase = PHASE_CONNECT;
  } else {
    startSetupAccessPoint();
  }
}

void loop() {
  unsigned long now = millis();

  switch (phase) {
    case PHASE_SETUP_AP: {
      setupServer.handleClient();

      if (credentialsCaptured) {
        setupServer.stop();
        phase = PHASE_CONNECT;
        break;
      }

      if (now > setupApDeadlineMs) {
        setupApDeadlineMs = now + NEXUS_SETUP_AP_TIMEOUT_MS;
      }

      break;
    }

    case PHASE_CONNECT: {
      if (WiFi.status() == WL_CONNECTED) {
        wifiUp = true;
        // A stored token means we are already a known device.
        phase = deviceToken.length() ? PHASE_REGISTER : PHASE_CLAIM;
        break;
      }

      if (credentialsCaptured || now - lastConnectAttemptMs > NEXUS_RETRY_MS) {
        lastConnectAttemptMs = now;
        credentialsCaptured = false;

        if (!joinWifi()) {
          // Wrong password, network gone, or the user changed their router:
          // ask for the Wi-Fi details again but keep the device identity, so
          // this never turns into a second device record.
          if (wifiFailures >= 2 && !deviceToken.length()) {
            startSetupAccessPoint();
          }
        }
      }

      break;
    }

    case PHASE_CLAIM: {
      if (WiFi.status() != WL_CONNECTED) {
        phase = PHASE_CONNECT;
        break;
      }

      if (!claimId.length()) {
        if (now - lastRegisterAttemptMs > NEXUS_RETRY_MS) {
          lastRegisterAttemptMs = now;
          announceClaim();
        }

        break;
      }

      claimPolls++;

      if (now - lastClaimPollMs > NEXUS_CLAIM_POLL_MS) {
        lastClaimPollMs = now;

        if (fetchClaimCredential()) {
          claimFailures = 0;
          phase = PHASE_REGISTER;
          break;
        }
      }

      // Still waiting: after ~2 minutes, reopen the setup AP so the user can
      // retry. The claim (and the device record) is reused, never duplicated.
      if (claimPolls > 40) {
        claimPolls = 0;
        claimFailures++;

        if (claimFailures >= 2) {
          Serial.println("[claim] no approval - reopening setup for a retry");
          startSetupAccessPoint();
        }
      }

      break;
    }

    case PHASE_REGISTER: {
      if (WiFi.status() != WL_CONNECTED) {
        phase = PHASE_CONNECT;
        break;
      }

      if (now - lastRegisterAttemptMs > NEXUS_RETRY_MS) {
        lastRegisterAttemptMs = now;

        if (registerDevice()) {
          phase = PHASE_HEARTBEAT;
        }
      }

      break;
    }

    case PHASE_HEARTBEAT: {
      if (WiFi.status() != WL_CONNECTED) {
        registered = false;
        phase = PHASE_CONNECT;
        break;
      }

      if (now - lastHeartbeatMs > NEXUS_HEARTBEAT_INTERVAL_MS) {
        lastHeartbeatMs = now;
        sendHeartbeat();
      }

      break;
    }
  }

  delay(50);
}
