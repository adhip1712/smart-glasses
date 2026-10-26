# `WebServer` streaming fix for ESP32 Arduino core 2.0.17

Applies to the camera streaming / capture response code that fails with:

```text
camera.ino:1185:7: error: no matching function for call to
'WebServer::send(int, const char [11], CameraFrameStream&, size_t&)'
```

Board `esp32:esp32:esp32cam`, core **2.0.17**, no core upgrade, no new libraries.

## 1. Why the call fails

`WebServer` on core 2.0.17 has **only** these response overloads
(`libraries/WebServer/src/WebServer.h` @ ref `2.0.17`, lines 137-143):

```cpp
void send(int code, const char* content_type = NULL, const String& content = String(""));
void send(int code, char* content_type, const String& content);
void send(int code, const String& content_type, const String& content);
void send(int code, const char* content_type, const char* content);
void send_P(int code, PGM_P content_type, PGM_P content);
void send_P(int code, PGM_P content_type, PGM_P content, size_t contentLength);
```

There is no overload that takes a stream. The four-argument
`send(int, const char*, Stream&, size_t)` overload used by the streaming code
exists **only on arduino-esp32 `master`** — checked release by release, it is
absent from 2.0.17, 3.0.0, 3.1.0, 3.2.0 and 3.3.0. The streaming code was
therefore written against the newest (master) WebServer API.

`const char [11]` in the error is the 10-character content type `"image/jpeg"`,
i.e. the endpoint sends one JPEG frame, not an endless multipart stream.

For reference, this is what the master-only overload does — the replacement
below reproduces it exactly:

```cpp
void WebServer::send(int code, const char *content_type, Stream &stream, size_t content_length) {
  if (!content_length) {
    content_length = stream.available();
    if (!content_length) {
      send(204);
      return;
    }
  }
  String header;
  _prepareHeader(header, code, content_type, content_length);  // Content-Length: content_length
  _currentClientWrite(header.c_str(), header.length());
  _currentClient.write(stream, content_length);                // copy exactly content_length bytes
}
```

## 2. Replacement — keeps `CameraFrameStream`

`CameraFrameStream` is not the problem and is kept. Only the response call
changes, using public 2.0.17 API:

```cpp
// BEFORE (master-only overload, does not exist on 2.0.17):
//   setupServer.send(200, "image/jpeg", stream, frameLength);

// AFTER (identical response, 2.0.17-compatible):
if (frameLength == 0) {
  setupServer.send(204);                 // same empty-stream behaviour as the master overload
} else {
  setupServer.setContentLength(frameLength);       // -> "Content-Length: <frameLength>"
  setupServer.send(200, "image/jpeg", "");         // 3-arg overload that exists on 2.0.17

  static uint8_t pump[1024];
  size_t remaining = frameLength;
  while (remaining > 0) {
    size_t chunk = (remaining > sizeof(pump)) ? sizeof(pump) : remaining;
    size_t got = stream.readBytes((char *)pump, chunk);
    if (got == 0) break;                           // stream ended early - stop, never hang
    setupServer.sendContent((const char *)pump, got);
    remaining -= got;
  }
}
```

## 3. If `CameraFrameStream` is not a `Stream`

Then it cannot be pumped; write the frame buffer directly (the class is
dropped, its framing is reproduced with `snprintf`):

```cpp
camera_fb_t *fb = esp_camera_fb_get();
if (!fb) {
  setupServer.send(500, "text/plain", "camera capture failed");
  return;
}
setupServer.setContentLength(fb->len);
setupServer.send(200, "image/jpeg", "");
setupServer.sendContent((const char *)fb->buf, fb->len);
esp_camera_fb_return(fb);
```

## 4. If the endpoint is a live MJPEG stream instead of one JPEG

An endless stream has no known length, so do not set one — use chunked
transfer and terminate the body explicitly:

```cpp
WiFiClient client = setupServer.client();
setupServer.setContentLength(CONTENT_LENGTH_UNKNOWN);
setupServer.send(200, "multipart/x-mixed-replace; boundary=frame", "");
while (client.connected()) {
  /* per frame: sendContent(part_header, hlen); sendContent((const char *)fb->buf, fb->len); */
}
setupServer.sendContent("", 0);   // 0-length chunk closes the response
```

## 5. Why behaviour and response format are preserved

| | master overload | replacement |
|---|---|---|
| status line | `200` (or `204` when empty) | same |
| `Content-Type` | `image/jpeg` | same |
| `Content-Length` | exact body length | same |
| `Connection` | `close` (always emitted by `WebServer`) | same |
| body bytes | `stream` copied in full | same, in 1024-byte writes |
| transfer encoding | none (length is known) | none — `_chunked` stays false |

## 6. API availability on 2.0.17

Verified directly against the 2.0.17 sources:

- `setContentLength(const size_t)` — public, `WebServer.h:149`
- `send(int, const char*, const char*)` — public, `WebServer.h:140`
- `sendContent(const char*, size_t)` — public, `WebServer.h:152`; writes raw bytes while `_chunked` is false
- `Stream::readBytes(char*, size_t)` — `cores/esp32/Stream.h`
- `CONTENT_LENGTH_UNKNOWN` — `WebServer.h:54`
- `_prepareHeader` is `protected`, which is why the header is reproduced through the public API above

## 7. Verification performed

- The original call was reproduced against a faithful stub of the 2.0.17
  WebServer API: it fails with the **identical** message, including
  `'WebServer::send(int, const char [11], CameraFrameStream&, size_t&)'`.
- The replacement compiles clean against the same stub (`g++ -std=gnu++11
  -Wall -Wextra -fsyntax-only`, 0 errors from the patched code).
- **Not compiled for the ESP32.** No `arduino-cli` or xtensa toolchain exists
  in this environment, so the real compile is still the one to run:

```powershell
& "C:\Program Files\Arduino CLI\arduino-cli.exe" compile --fqbn esp32:esp32:esp32cam firmware\camera
```

with core 2.0.17 at
`C:\Users\adhip\AppData\Local\Arduino15\packages\esp32\hardware\esp32\2.0.17`.

## 8. Where this code lives

The repository's `firmware/camera/camera.ino` is 1116 lines and contains **no**
`CameraFrameStream`, no 4-argument `send()` and no streaming endpoint (verified
by grep across the working tree, the pushed commit and every branch). The
streaming code being compiled is therefore in a local copy that has extra
lines after that file's end (the error is reported at line 1185). Apply the
patch above to that copy, or share the block so it can be patched exactly.
