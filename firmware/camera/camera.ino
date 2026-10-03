// =========================================================
// VISIONARY NEXUS - ESP32-CAM DEVICE LIFECYCLE
// =========================================================
//
// Flow (mirrors backend/device_api.py):
//
//   1. derive the hardware uid from the chip (efuse MAC) - the identity the
//      backend recognises, so a re-flash cannot create a second device
//   2. if Wi-Fi + device token are already in NVS: skip provisioning and go
//      straight to registration + heartbeat (reconnect path)
//   3. otherwise open the local setup AP, take the credentials and the
//      pairing code the app got from POST /api/device/provision, then
//      exchange that ONE code for THIS device's token at
//      POST /api/device/provision/credentials
//   4. join Wi-Fi, report wifi_connected, POST /api/device/register with the
//      stored token - the backend updates the existing device
//   5. POST /api/device/heartbeat on an interval - the only thing that moves
//      the device to ONLINE
//
// Nothing in this file ever asks the backend to create a device.
// =========================================================

#include <WiFi.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <Preferences.h>

#include "device_config.h"

// =========================================================
// STATE
// =========================================================

enum Phase {
  PHASE_SETUP_AP,    // waiting for the app to hand over Wi-Fi + pairing code
  PHASE_HANDSHAKE,   // joining Wi-Fi and exchanging the code for our token
  PHASE_REGISTER,    // announcing ourselves with the stored token
  PHASE_HEARTBEAT,   // steady state: heartbeats keep the device ONLINE
};

Preferences preferences;
WebServer setupServer(80);

Phase phase = PHASE_SETUP_AP;

String hardwareUid;      // "A0:B1:C2:03:04:05" - derived from the chip
String deviceId;         // assigned by the backend, stored in NVS
String deviceToken;      // assigned by the backend, stored in NVS
String pairingCode;      // one-shot code handed over by the app
String wifiSsid;
String wifiPassword;

bool wifiCredentialsKnown = false;
bool wifiUp = false;
bool registered = false;
bool credentialsCaptured = false;

int handshakeFailures = 0;

unsigned long setupApDeadlineMs = 0;
unsigned long lastRegisterAttemptMs = 0;
unsigned long lastHandshakeAttemptMs = 0;
unsigned long lastHeartbeatMs = 0;

// =========================================================
// HELPERS
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

String jsonEscape(const String &value) {
  String out = value;
  out.replace("\\", "\\\\");
  out.replace("\"", "\\\"");
  return out;
}

/** Extract "key":"value" from a small JSON response without a full parser. */
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

void loadIdentity() {
  preferences.begin("nexus", false);

  hardwareUid = chipHardwareUid();
  deviceId = preferences.getString("device_id", "");
  deviceToken = preferences.getString("device_token", "");
  pairingCode = preferences.getString("pairing_code", "");
  wifiSsid = preferences.getString("wifi_ssid", "");
  wifiPassword = preferences.getString("wifi_password", "");

  wifiCredentialsKnown = wifiSsid.length() > 0;

  Serial.printf(
    "[boot] hardware_uid=%s device_id=%s token=%s\n",
    hardwareUid.c_str(),
    deviceId.length() ? deviceId.c_str() : "(unassigned)",
    deviceToken.length() ? "stored" : "(none)"
  );
}

void persistIdentity() {
  preferences.putString("device_id", deviceId);
  preferences.putString("device_token", deviceToken);
}

void persistWifi() {
  preferences.putString("wifi_ssid", wifiSsid);
  preferences.putString("wifi_password", wifiPassword);
}

// =========================================================
// HTTP
// =========================================================

bool postJson(const String &path, const String &payload, String &response) {
  if (WiFi.status() != WL_CONNECTED) {
    return false;
  }

  HTTPClient http;
  http.begin(String(NEXUS_BACKEND_URL) + path);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(8000);

  int status = http.POST(payload);

  response = http.getString();
  http.end();

  return status >= 200 && status < 300;
}

void reportEvent(const char *event, const char *error) {
  String payload = "{";
  payload += "\"device_id\":\"" + jsonEscape(deviceId) + "\",";
  payload += "\"device_token\":\"" + jsonEscape(deviceToken) + "\",";
  payload += "\"pairing_code\":\"" + jsonEscape(pairingCode) + "\",";
  payload += "\"hardware_uid\":\"" + jsonEscape(hardwareUid) + "\",";
  payload += "\"event\":\"" + String(event) + "\",";
  payload += "\"error\":\"" + jsonEscape(String(error)) + "\"}";

  String response;
  postJson(NEXUS_REPORT_PATH, payload, response);
}

// =========================================================
// SETUP ACCESS POINT
// =========================================================

const char SETUP_PAGE[] PROGMEM = R"HTML(
<!doctype html><html><head><meta charset="utf-8"><title>Visionary Nexus setup</title>
<style>body{background:#030712;color:#e5e7eb;font:14px/1.5 monospace;padding:24px}
label{display:block;margin-top:12px}input{width:100%;padding:10px;margin-top:6px;background:#0b1220;color:#e5e7eb;border:1px solid #1f2937;border-radius:8px}
button{margin-top:18px;width:100%;padding:12px;background:#082f49;color:#00e5ff;border:1px solid #00e5ff55;border-radius:10px}
</style></head><body>
<h3>VISIONARY NEXUS &middot; DEVICE SETUP</h3>
<form method="POST" action="/configure">
  <label>Wi-Fi SSID<input name="ssid" required></label>
  <label>Wi-Fi password<input name="password" type="password"></label>
  <label>Pairing code (from the app)<input name="pairing_code" placeholder="ABCD-EFGH" required></label>
  <button type="submit">Configure device</button>
</form></body></html>
)HTML";

void handleSetupRoot() {
  setupServer.send_P(200, "text/html", SETUP_PAGE);
}

void handleConfigure() {
  wifiSsid = setupServer.arg("ssid");
  wifiPassword = setupServer.arg("password");
  pairingCode = setupServer.arg("pairing_code");

  wifiCredentialsKnown = wifiSsid.length() > 0;

  persistWifi();
  preferences.putString("pairing_code", pairingCode);

  credentialsCaptured = true;

  setupServer.send(
    200,
    "text/plain",
    "Credentials stored. The device will now join the network and register."
  );

  Serial.println("[setup] credentials captured");
}

void startSetupAccessPoint() {
  String apName = String(NEXUS_SETUP_AP_SSID_PREFIX) + hardwareUid.substring(12);

  WiFi.mode(WIFI_AP);
  WiFi.softAP(apName.c_str(), NEXUS_SETUP_AP_PASSWORD);

  setupServer.on("/", HTTP_GET, handleSetupRoot);
  setupServer.on("/configure", HTTP_POST, handleConfigure);
  setupServer.begin();

  setupApDeadlineMs = millis() + NEXUS_SETUP_AP_TIMEOUT_MS;
  phase = PHASE_SETUP_AP;

  Serial.printf("[setup] access point \"%s\" open\n", apName.c_str());
}

// =========================================================
// WI-FI
// =========================================================

void reportWifiFailed(const char *reason) {
  reportEvent("wifi_failed", reason);
}

void connectToWifi() {
  if (!wifiCredentialsKnown) {
    return;
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
    Serial.println("\n[wifi] join failed");
    reportWifiFailed("could not join the access point");
    return;
  }

  Serial.printf("\n[wifi] connected ip=%s rssi=%d\n",
                WiFi.localIP().toString().c_str(),
                WiFi.RSSI());

  // Tell the backend the link is up (wifi_configuring -> connecting).
  String payload = "{";
  payload += "\"device_id\":\"" + jsonEscape(deviceId) + "\",";
  payload += "\"device_token\":\"" + jsonEscape(deviceToken) + "\",";
  payload += "\"pairing_code\":\"" + jsonEscape(pairingCode) + "\",";
  payload += "\"hardware_uid\":\"" + jsonEscape(hardwareUid) + "\",";
  payload += "\"firmware\":\"" NEXUS_FIRMWARE_VERSION "\",";
  payload += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  payload += "\"rssi\":" + String(WiFi.RSSI()) + ",";
  payload += "\"event\":\"wifi_connected\"}";

  String response;
  postJson(NEXUS_REPORT_PATH, payload, response);
}

// =========================================================
// CREDENTIAL HANDSHAKE
// =========================================================

/** Exchange the one-shot pairing code for THIS device's token. */
bool fetchCredentials() {
  if (!pairingCode.length()) {
    Serial.println("[handshake] no pairing code stored");
    return false;
  }

  String payload = "{";
  payload += "\"pairing_code\":\"" + jsonEscape(pairingCode) + "\",";

  if (deviceId.length()) {
    payload += "\"device_id\":\"" + jsonEscape(deviceId) + "\",";
  }

  payload += "\"hardware_uid\":\"" + jsonEscape(hardwareUid) + "\"}";

  String response;

  if (!postJson(NEXUS_CREDENTIALS_PATH, payload, response)) {
    Serial.println("[handshake] credential exchange rejected");
    return false;
  }

  String returnedDeviceId = jsonString(response, "device_id");
  String returnedToken = jsonString(response, "device_token");

  // Guard against ever adopting a *different* identity mid-flight: the
  // backend only ever returns the identity of this device's record.
  if (returnedDeviceId.length() &&
      deviceId.length() &&
      returnedDeviceId != deviceId) {
    Serial.println("[handshake] backend returned a different device_id - refusing");
    return false;
  }

  if (returnedToken.length()) {
    deviceToken = returnedToken;
  }

  if (!deviceToken.length()) {
    Serial.println("[handshake] no device token in the response");
    return false;
  }

  if (returnedDeviceId.length()) {
    deviceId = returnedDeviceId;
  }

  // Wi-Fi credentials are restored from the backend too, so a board that was
  // re-flashed can be brought back with the pairing code alone.
  String backendSsid = jsonString(response, "ssid");

  if (backendSsid.length()) {
    wifiSsid = backendSsid;
    wifiCredentialsKnown = true;
  }

  String backendPassword = jsonString(response, "password");

  if (backendPassword.length()) {
    wifiPassword = backendPassword;
  }

  // The code has been consumed: never keep it in flash again.
  pairingCode = "";
  preferences.remove("pairing_code");

  persistWifi();
  persistIdentity();

  Serial.printf("[handshake] identity confirmed: %s\n", deviceId.c_str());

  return true;
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
  payload += "\"device_token\":\"" + jsonEscape(deviceToken) + "\",";
  payload += "\"hardware_uid\":\"" + jsonEscape(hardwareUid) + "\",";
  payload += "\"firmware\":\"" NEXUS_FIRMWARE_VERSION "\",";
  payload += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  payload += "\"rssi\":" + String(WiFi.RSSI()) + "}";

  String response;

  if (!postJson(NEXUS_REGISTER_PATH, payload, response)) {
    Serial.println("[register] rejected - retrying with the same identity");
    return false;
  }

  registered = true;
  lastHeartbeatMs = 0;  // heartbeat immediately after registering

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

  if (postJson(NEXUS_HEARTBEAT_PATH, payload, response)) {
    Serial.println("[heartbeat] ok");
  } else {
    Serial.println("[heartbeat] failed - will retry");
    registered = false;
    phase = PHASE_REGISTER;
  }
}

// =========================================================
// LIFECYCLE
// =========================================================

void setup() {
  Serial.begin(115200);
  delay(300);

  Serial.println("\n========================================");
  Serial.println("VISIONARY NEXUS - ESP32-CAM");
  Serial.println("========================================");

  loadIdentity();

  if (wifiCredentialsKnown && deviceToken.length()) {
    // Reconnect path: this board already owns an identity.
    connectToWifi();

    if (wifiUp) {
      phase = PHASE_REGISTER;
    }
  } else if (wifiCredentialsKnown) {
    phase = PHASE_HANDSHAKE;
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
        credentialsCaptured = false;
        setupServer.stop();
        phase = PHASE_HANDSHAKE;
        break;
      }

      if (now > setupApDeadlineMs) {
        // Keep the AP alive for a slow user instead of giving up.
        setupApDeadlineMs = now + NEXUS_SETUP_AP_TIMEOUT_MS;
      }

      break;
    }

    case PHASE_HANDSHAKE: {
      if (WiFi.status() != WL_CONNECTED) {
        wifiUp = false;

        if (now - lastHandshakeAttemptMs > NEXUS_REGISTER_RETRY_MS) {
          lastHandshakeAttemptMs = now;
          connectToWifi();
        }

        break;
      }

      wifiUp = true;

      // Wi-Fi is good enough to reach the backend: collect the token.
      if (fetchCredentials()) {
        handshakeFailures = 0;
        phase = PHASE_REGISTER;
        break;
      }

      handshakeFailures++;

      if (handshakeFailures == 1) {
        reportEvent("pairing_failed", "could not exchange the pairing code");
      }

      if (handshakeFailures >= 6) {
        // The code is not usable any more - ask the app for a new setup
        // session. The backend keeps the SAME device for the retry.
        Serial.println("[handshake] giving up, reopening the setup access point");
        handshakeFailures = 0;
        startSetupAccessPoint();
      }

      break;
    }

    case PHASE_REGISTER: {
      if (WiFi.status() != WL_CONNECTED) {
        wifiUp = false;
        phase = PHASE_HANDSHAKE;
        break;
      }

      if (!registered && now - lastRegisterAttemptMs > NEXUS_REGISTER_RETRY_MS) {
        lastRegisterAttemptMs = now;
        registerDevice();
      }

      if (registered) {
        phase = PHASE_HEARTBEAT;
      }

      break;
    }

    case PHASE_HEARTBEAT: {
      if (WiFi.status() != WL_CONNECTED) {
        wifiUp = false;
        registered = false;
        reportWifiFailed("connection lost");
        phase = PHASE_HANDSHAKE;
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
