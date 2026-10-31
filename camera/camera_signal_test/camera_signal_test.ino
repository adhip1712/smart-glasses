#include <Arduino.h>

#define CAMERA_PWDN 32
#define CAMERA_XCLK 0

void setup() {
  Serial.begin(115200);
  delay(2000);

  Serial.println();
  Serial.println("========================================");
  Serial.println(" Visionary Nexus Camera Signal Test");
  Serial.println("========================================");

  // Wake camera
  pinMode(CAMERA_PWDN, OUTPUT);
  digitalWrite(CAMERA_PWDN, LOW);

  Serial.println("Camera PWDN set LOW");

  // Configure GPIO0 for a simple output test.
  // This does NOT generate the actual camera clock;
  // it only verifies that GPIO0 can be controlled.
  pinMode(CAMERA_XCLK, OUTPUT);

  Serial.println("GPIO0 output configured");

  digitalWrite(CAMERA_XCLK, LOW);
  delay(500);

  Serial.println("GPIO0 LOW");

  digitalWrite(CAMERA_XCLK, HIGH);
  delay(500);

  Serial.println("GPIO0 HIGH");

  digitalWrite(CAMERA_XCLK, LOW);

  Serial.println();
  Serial.println("Signal test completed.");
  Serial.println("ESP32 GPIO control is responding.");
}

void loop() {
  delay(5000);
}