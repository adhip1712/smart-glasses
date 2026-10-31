#include <Arduino.h>
#include "Wire.h"

#define CAMERA_PWDN 32
#define CAMERA_XCLK 0
#define CAMERA_SIOD 26
#define CAMERA_SIOC 27

void setup() {
  Serial.begin(115200);
  delay(2000);

  Serial.println();
  Serial.println("========================================");
  Serial.println(" Visionary Nexus Camera XCLK + SCCB Test");
  Serial.println("========================================");

  // Wake camera
  pinMode(CAMERA_PWDN, OUTPUT);
  digitalWrite(CAMERA_PWDN, LOW);

  Serial.println("Camera PWDN = LOW");

  // Generate 20 MHz clock on GPIO0 using LEDC
  ledcSetup(0, 20000000, 1);
  ledcAttachPin(CAMERA_XCLK, 0);
  ledcWrite(0, 1);

  Serial.println("20 MHz XCLK started on GPIO0");

  delay(500);

  // Start SCCB
  Wire.begin(CAMERA_SIOD, CAMERA_SIOC);
  Wire.setClock(100000);

  Serial.println("SCCB started");
  Serial.println("Scanning...");
  Serial.println();

  int found = 0;

  for (uint8_t address = 1; address < 127; address++) {
    Wire.beginTransmission(address);
    uint8_t error = Wire.endTransmission();

    if (error == 0) {
      Serial.printf("DEVICE FOUND at 0x%02X\n", address);
      found++;
    }
  }

  Serial.println();

  if (found == 0) {
    Serial.println("NO SCCB DEVICES FOUND.");
    Serial.println("Expected OV2640 address: 0x30");
  } else {
    Serial.printf("Found %d SCCB device(s).\n", found);
  }

  Serial.println();
  Serial.println("Test complete.");
}

void loop() {
  delay(5000);
}