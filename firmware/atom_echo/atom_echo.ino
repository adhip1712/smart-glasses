/*
 * Visionary Nexus / M5Stack ATOM Echo
 * Board: esp32:esp32:m5stack-atom
 * Hold the button while speaking; release to transcribe and route the command.
 * Local backend STT must be configured with GROQ_API_KEY or OPENAI_API_KEY.
 */
#include <WiFi.h>
#include <WebServer.h>
#include <Preferences.h>
#include <HTTPClient.h>
#include <WiFiClient.h>
#include <ArduinoJson.h>
#include <driver/i2s.h>
#include <esp_heap_caps.h>

static const char *AP_SSID = "VisionaryNexus-Echo";
static const char *AP_PASSWORD = "nexus-setup";
static const uint32_t RATE = 16000, MAX_SECONDS = 5;
static const size_t MAX_SAMPLES = RATE * MAX_SECONDS;
static const char *TRANSCRIBE = "/api/voice/transcribe";
static const char *ASK = "/api/ask";

static const int ATOM_BUTTON_PIN = 39; // ATOM Echo onboard button, active-low
bool buttonWasDown = false;
Preferences prefs;
WebServer portal(80);
String ssid, password, backend;
int conversationId = 0;
bool rebootAfterSave = false;
int16_t *pcm = nullptr;

String backendBase() {
  if (backend.length()) return backend;
  IPAddress ip;
  if (WiFi.hostByName("nexus-backend.local", ip) == 1) {
    backend = "http://" + ip.toString() + ":8001";
    return backend;
  }
  // Dynamic LAN discovery: scan the current local subnet, never a compiled IP.
  IPAddress local = WiFi.localIP(), mask = WiFi.subnetMask(), gateway = WiFi.gatewayIP();
  uint32_t net = (uint32_t)local & (uint32_t)mask, end = net | ~(uint32_t)mask;
  const uint16_t ports[] = {8001, 8000, 8080};
  for (uint16_t port : ports) {
    for (uint32_t n = net + 1; n < end; ++n) {
      IPAddress host(n);
      if (host == local || host == gateway) continue;
      WiFiClient c; c.setTimeout(100);
      if (!c.connect(host, port, 100)) continue;
      c.printf("GET /api/health HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n", host.toString().c_str());
      unsigned long until = millis() + 200;
      String head;
      while (c.connected() && millis() < until && head.length() < 500) {
        while (c.available() && head.length() < 500) head += (char)c.read();
        delay(1);
      }
      c.stop();
      if (head.startsWith("HTTP/1.1 200") && head.indexOf("\"status\"") >= 0) {
        backend = "http://" + host.toString() + ":" + String(port);
        return backend;
      }
    }
  }
  return "";
}

bool postJson(const String &path, const String &body, String &out) {
  String base = backendBase();
  if (!base.length()) { Serial.println("[backend] not found; set optional backend URL in setup"); return false; }
  HTTPClient h;
  if (!h.begin(base + path)) return false;
  h.setTimeout(30000);
  h.addHeader("Content-Type", "application/json");
  int code = h.POST(body);
  out = h.getString();
  h.end();
  Serial.printf("[http] %s -> %d\n", path.c_str(), code);
  return code >= 200 && code < 300;
}

void portalRoot() {
  portal.send(200, "text/html",
    "<!doctype html><meta name='viewport' content='width=device-width'><body style='font:16px sans-serif;background:#07111f;color:#eef;padding:24px'>"
    "<h2>VISIONARY NEXUS Â· ATOM ECHO</h2><p>Enter the Wi-Fi used by the computer running Visionary Nexus.</p>"
    "<form method='post' action='/save'><label>Wi-Fi name</label><input name='ssid' required style='display:block;width:100%;padding:12px;margin:8px 0'>"
    "<label>Wi-Fi password</label><input name='password' type='password' style='display:block;width:100%;padding:12px;margin:8px 0'>"
    "<label>Backend URL (optional)</label><input name='backend' placeholder='Leave blank for discovery' style='display:block;width:100%;padding:12px;margin:8px 0'>"
    "<button style='padding:12px;width:100%'>Save and connect</button></form></body>");
}
void portalSave() {
  ssid = portal.arg("ssid"); password = portal.arg("password"); backend = portal.arg("backend");
  backend.trim(); while (backend.endsWith("/")) backend.remove(backend.length()-1);
  prefs.begin("vn-echo", false); prefs.putString("ssid",ssid); prefs.putString("password",password); prefs.putString("backend",backend); prefs.end();
  portal.send(200,"text/html","<h2>Saved. You may close this page.</h2><p>Atom Echo is restarting.</p>");
  rebootAfterSave = true;
}
void startPortal() {
  WiFi.mode(WIFI_AP); WiFi.softAP(AP_SSID, AP_PASSWORD);
  portal.on("/", HTTP_GET, portalRoot); portal.on("/save", HTTP_POST, portalSave); portal.begin();
  Serial.println("[status] setup mode");
  Serial.printf("[setup] join %s (password %s), then open http://192.168.4.1\n", AP_SSID, AP_PASSWORD);
}
bool connectSaved() {
  prefs.begin("vn-echo", true); ssid=prefs.getString("ssid",""); password=prefs.getString("password",""); backend=prefs.getString("backend",""); prefs.end();
  if (!ssid.length()) return false;
  WiFi.mode(WIFI_STA); WiFi.begin(ssid.c_str(),password.c_str());
  unsigned long until=millis()+20000;
  while(WiFi.status()!=WL_CONNECTED && millis()<until){delay(300);Serial.print(".");}
  if(WiFi.status()!=WL_CONNECTED){Serial.println("\n[wifi] failed");return false;}
  Serial.printf("\n[wifi] %s, RSSI %d\n",WiFi.localIP().toString().c_str(),WiFi.RSSI());
  Serial.println("[status] Wi-Fi connected"); return true;
}
bool micInit() {
  i2s_config_t cfg={};
  cfg.mode=(i2s_mode_t)(I2S_MODE_MASTER|I2S_MODE_RX|I2S_MODE_PDM);
  cfg.sample_rate=RATE; cfg.bits_per_sample=I2S_BITS_PER_SAMPLE_16BIT;
  cfg.channel_format=I2S_CHANNEL_FMT_ONLY_LEFT; cfg.communication_format=I2S_COMM_FORMAT_STAND_I2S;
  cfg.intr_alloc_flags=ESP_INTR_FLAG_LEVEL1; cfg.dma_buf_count=8; cfg.dma_buf_len=256;
  cfg.use_apll=false; cfg.tx_desc_auto_clear=false; cfg.fixed_mclk=0;
  if(i2s_driver_install(I2S_NUM_0,&cfg,0,nullptr)!=ESP_OK)return false;
  i2s_pin_config_t pins={}; pins.bck_io_num=I2S_PIN_NO_CHANGE; pins.ws_io_num=33;
  pins.data_out_num=I2S_PIN_NO_CHANGE; pins.data_in_num=23;
  if(i2s_set_pin(I2S_NUM_0,&pins)!=ESP_OK)return false;
  return i2s_set_pdm_rx_down_sample(I2S_NUM_0,I2S_PDM_DSR_8S)==ESP_OK;
}
void le16(uint8_t*p,uint16_t v){p[0]=v&255;p[1]=(v>>8)&255;}
void le32(uint8_t*p,uint32_t v){p[0]=v&255;p[1]=(v>>8)&255;p[2]=(v>>16)&255;p[3]=(v>>24)&255;}
void wavHeader(uint8_t*h,uint32_t bytes){
  memcpy(h,"RIFF",4);le32(h+4,36+bytes);memcpy(h+8,"WAVEfmt ",8);le32(h+16,16);
  le16(h+20,1);le16(h+22,1);le32(h+24,RATE);le32(h+28,RATE*2);le16(h+32,2);le16(h+34,16);
  memcpy(h+36,"data",4);le32(h+40,bytes);
}
String jsonText(const String &s,const char *key){
  DynamicJsonDocument doc(8192); if(deserializeJson(doc,s))return "";
  return String((const char*)(doc[key] | ""));
}
int jsonNumber(const String&s,const char*key){
  DynamicJsonDocument doc(1024); if(deserializeJson(doc,s))return 0; return doc[key] | 0;
}
bool transcribe(size_t count,String &textOut) {
  String base=backendBase(); if(!base.startsWith("http://"))return false;
  String authority=base.substring(7);int slash=authority.indexOf('/');if(slash>=0)authority=authority.substring(0,slash);
  int colon=authority.lastIndexOf(':');String host=colon>=0?authority.substring(0,colon):authority;
  uint16_t port=colon>=0?authority.substring(colon+1).toInt():80;
  WiFiClient c;c.setTimeout(65000);if(!c.connect(host.c_str(),port,5000))return false;
  const String boundary="----VNAtomEchoBoundary";
  String prefix="--"+boundary+"\r\nContent-Disposition: form-data; name=\"language\"\r\n\r\nauto\r\n";
  prefix+="--"+boundary+"\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"atom-echo.wav\"\r\nContent-Type: audio/wav\r\n\r\n";
  String suffix="\r\n--"+boundary+"--\r\n";
  uint32_t wavBytes=44+count*2, total=prefix.length()+wavBytes+suffix.length();
  c.printf("POST %s HTTP/1.1\r\nHost: %s\r\nContent-Type: multipart/form-data; boundary=%s\r\nContent-Length: %u\r\nConnection: close\r\n\r\n",TRANSCRIBE,host.c_str(),boundary.c_str(),total);
  c.write((const uint8_t*)prefix.c_str(),prefix.length());uint8_t h[44];wavHeader(h,count*2);c.write(h,44);
  const uint8_t *p=(const uint8_t*)pcm;size_t remain=count*2;
  while(remain){size_t n=remain>1024?1024:remain;size_t sent=c.write(p,n);if(!sent)break;p+=sent;remain-=sent;delay(0);}
  c.write((const uint8_t*)suffix.c_str(),suffix.length());
  unsigned long until=millis()+65000;String raw;
  while((c.connected()||c.available())&&millis()<until&&raw.length()<10000){while(c.available()&&raw.length()<10000)raw+=(char)c.read();delay(2);}
  c.stop();int bodyAt=raw.indexOf("\r\n\r\n");if(bodyAt<0)return false;
  textOut=jsonText(raw.substring(bodyAt+4),"text");return textOut.length()>0;
}
void runAssistant(const String &spoken) {
  String response;
  if(!conversationId){
    if(!postJson("/api/conversations","{\"title\":\"Atom Echo Voice\"}",response)){Serial.println("[assistant] conversation creation failed");return;}
    conversationId=jsonNumber(response,"id");
  }
  if(!conversationId)return;
  DynamicJsonDocument requestDoc(4096);
  requestDoc["message"] = spoken;
  requestDoc["conversation_id"] = conversationId;
  String body;
  serializeJson(requestDoc, body);
  if(postJson(ASK,body,response)){
    String answer=jsonText(response,"response");
    Serial.printf("[voice] heard: %s\n[assistant] %s\n",spoken.c_str(),answer.c_str());
    Serial.println("[status] command sent");
  } else {Serial.println("[assistant] request failed");}
}
void recordCommand() {
  if(!pcm){Serial.println("[mic] no recording buffer");return;}
  size_t count=0;int16_t chunk[256];
  Serial.println("[mic] hold button while speaking; release to send (max 5s)");
  while(digitalRead(ATOM_BUTTON_PIN)==LOW && count<MAX_SAMPLES){
    size_t bytes=0;
    if(i2s_read(I2S_NUM_0,chunk,sizeof(chunk),&bytes,pdMS_TO_TICKS(100))==ESP_OK&&bytes){
      size_t n=bytes/2;if(n>MAX_SAMPLES-count)n=MAX_SAMPLES-count;
      memcpy(pcm+count,chunk,n*2);count+=n;
    }
    delay(1);
  }
  if(count<RATE/3){Serial.println("[mic] too short; hold the button and speak");return;}
  String transcript;
  Serial.printf("[mic] recorded %.1f seconds\n",count/(float)RATE);
  if(transcribe(count,transcript)){Serial.printf("[stt] %s\n",transcript.c_str());runAssistant(transcript);}
  else{Serial.println("[stt] failed; check backend URL, STT provider and API key");}
}
void setup(){
  Serial.begin(115200);pinMode(ATOM_BUTTON_PIN, INPUT);delay(300);
  Serial.println("\nVISIONARY NEXUS - M5STACK ATOM ECHO");
  pcm=(int16_t*)heap_caps_malloc(MAX_SAMPLES*sizeof(int16_t),MALLOC_CAP_8BIT);
  if(!pcm)pcm=(int16_t*)malloc(MAX_SAMPLES*sizeof(int16_t));
  if(!micInit())Serial.println("[mic] PDM init failed; verify ESP32 core and M5Atom board target");
  if(!connectSaved())startPortal();
}
void loop(){
  if(WiFi.getMode()==WIFI_AP){portal.handleClient();if(rebootAfterSave){delay(500);ESP.restart();}delay(5);return;}
  if(WiFi.status()!=WL_CONNECTED){if(!connectSaved()){startPortal();return;}}
  bool down = digitalRead(ATOM_BUTTON_PIN) == LOW;
  if(down && !buttonWasDown){delay(40);if(digitalRead(ATOM_BUTTON_PIN)==LOW)recordCommand();}
  buttonWasDown = digitalRead(ATOM_BUTTON_PIN) == LOW;
  delay(5);
}

