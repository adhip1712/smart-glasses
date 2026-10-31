#include <Arduino.h>

void setup() {
  Serial.begin(115200);
  delay(2000);

  Serial.println();
  Serial.println("================================");
  Serial.println("VISIONARY NEXUS BOOT TEST");
  Serial.println("================================");
  Serial.println("Application reached setup()");
  Serial.println("If you can see this, the ESP32 is executing Arduino code.");
}

void loop() {
  Serial.println("[VN TEST] Alive");
  delay(2000);
}