#include <Arduino.h>
#include "Wire.h"

// AI Thinker ESP32-CAM camera pins
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27

void setup() {
  Serial.begin(115200);
  delay(2000);

  Serial.println();
  Serial.println("========================================");
  Serial.println(" Visionary Nexus OV2640 SCCB Test");
  Serial.println("========================================");

  // Wake camera
  pinMode(PWDN_GPIO_NUM, OUTPUT);
  digitalWrite(PWDN_GPIO_NUM, LOW);

  Serial.println("Camera PWDN: LOW");

  // Start SCCB/I2C
  Wire.begin(SIOD_GPIO_NUM, SIOC_GPIO_NUM);
  Wire.setClock(100000);

  Serial.println("SCCB bus started");
  Serial.println("Scanning addresses...");
  Serial.println();

  int found = 0;

  for (uint8_t address = 1; address < 127; address++) {
    Wire.beginTransmission(address);
    uint8_t error = Wire.endTransmission();

    if (error == 0) {
      Serial.printf(
        "DEVICE FOUND at 0x%02X\n",
        address
      );
      found++;
    }
  }

  Serial.println();

  if (found == 0) {
    Serial.println("NO SCCB DEVICES FOUND.");
    Serial.println();
    Serial.println("Expected OV2640 address: 0x30");
    Serial.println("Camera communication is not responding.");
  } else {
    Serial.printf(
      "SCCB scan complete: %d device(s) found.\n",
      found
    );
  }

  Serial.println();
  Serial.println("Diagnostic complete.");
}

void loop() {
  delay(5000);
}