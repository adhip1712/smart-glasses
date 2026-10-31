#include "esp_camera.h"

// ========================================
// AI Thinker ESP32-CAM pin configuration
// ========================================

#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0

#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27

#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5

#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

void setup() {
  Serial.begin(115200);
  delay(2000);

  Serial.println();
  Serial.println("========================================");
  Serial.println(" Visionary Nexus Camera Diagnostic");
  Serial.println("========================================");
  Serial.println("Board: AI Thinker ESP32-CAM");
  Serial.println("Initializing camera...");

  camera_config_t config;

  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;

  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;

  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;

  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;

  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;

  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;

  // Keep the diagnostic simple
  config.frame_size = FRAMESIZE_QVGA;
  config.jpeg_quality = 12;
  config.fb_count = 1;
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  config.fb_location = CAMERA_FB_IN_PSRAM;

  Serial.println("Calling esp_camera_init()...");

  esp_err_t err = esp_camera_init(&config);

  if (err != ESP_OK) {
    Serial.printf("CAMERA FAILED: 0x%x\n", err);
    Serial.println("Camera sensor was NOT detected.");
    return;
  }

  Serial.println("CAMERA INITIALIZED SUCCESSFULLY!");

  sensor_t *sensor = esp_camera_sensor_get();

  if (sensor != nullptr) {
    Serial.printf("Sensor PID : 0x%02X\n", sensor->id.PID);
    Serial.printf("Sensor VER : 0x%02X\n", sensor->id.VER);
    Serial.printf("Sensor MIDH: 0x%02X\n", sensor->id.MIDH);
    Serial.printf("Sensor MIDL: 0x%02X\n", sensor->id.MIDL);
  } else {
    Serial.println("ERROR: Sensor object is NULL");
  }

  Serial.println("Testing camera frame...");

  camera_fb_t *fb = esp_camera_fb_get();

  if (fb == nullptr) {
    Serial.println("FRAME TEST FAILED");
  } else {
    Serial.printf("FRAME TEST SUCCESS: %u bytes\n", fb->len);
    esp_camera_fb_return(fb);
  }

  Serial.println("Diagnostic complete.");
}

void loop() {
  delay(5000);
}