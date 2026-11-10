from pathlib import Path
from datetime import datetime
import shutil

root = Path(r"C:\Users\adhip\OneDrive\All Projects\Smartglasses\smart-glasses")
backend = root / "backend" / "api.py"
frontend = root / "Frontend" / "src" / "components" / "YouTubeMusic.tsx"
stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
shutil.copy2(backend, backend.with_name(f"api.py.before-audius-proxy-{stamp}.bak"))
shutil.copy2(frontend, frontend.with_name(f"YouTubeMusic.tsx.before-audius-proxy-{stamp}.bak"))

b = backend.read_text(encoding="utf-8")
b = b.replace(
    "from fastapi.responses import JSONResponse",
    "from fastapi.responses import JSONResponse, StreamingResponse",
    1
)
old_public = '"/api/music/youtube-oauth/callback",'
new_public = '"/api/music/youtube-oauth/callback", "/api/music/audius-stream/",'
if old_public not in b:
    raise SystemExit("Auth public-prefix insertion point not found.")
b = b.replace(old_public, new_public, 1)

old_stream = '"stream_url": stream_url,\n                "audio": stream_url,'
new_stream = '"stream_url": f"/api/music/audius-stream/{quote(str(item[\'id\']), safe=\'\')}",\n                "audio": f"/api/music/audius-stream/{quote(str(item[\'id\']), safe=\'\')}",'
if old_stream not in b:
    raise SystemExit("Audius stream URL mapping not found.")
b = b.replace(old_stream, new_stream, 1)

anchor = '\n\n\n# =========================================================\n# MUSIC SEARCH / PLAYBACK ROUTES'
if anchor not in b:
    raise SystemExit("Audius stream route insertion point not found.")
route = r'''

@app.get("/api/music/audius-stream/{track_id}")
def music_audius_stream(track_id: str, request: FastAPIRequest):
    """Proxy an Audius track stream so browser audio works across CORS/CDN hosts."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", track_id or ""):
        return JSONResponse(status_code=400, content={"detail": "Invalid Audius track ID."})

    params = {"app_name": "VisionaryNexus"}
    if AUDIUS_API_KEY:
        params["api_key"] = AUDIUS_API_KEY
    stream_url = f"https://api.audius.co/v1/tracks/{quote(track_id, safe='')}/stream?{urlencode(params)}"
    headers = {"User-Agent": "VisionaryNexus/1.0", "Accept": "audio/*, */*"}
    byte_range = request.headers.get("range")
    if byte_range:
        headers["Range"] = byte_range

    try:
        upstream = urlopen(Request(stream_url, headers=headers, method="GET"), timeout=20)
        status = getattr(upstream, "status", 200)
        response_headers = {"Cache-Control": "no-store", "Accept-Ranges": "bytes"}
        for header in ("Content-Type", "Content-Length", "Content-Range", "ETag", "Last-Modified"):
            value = upstream.headers.get(header)
            if value:
                response_headers[header] = value

        def stream_chunks():
            try:
                while True:
                    chunk = upstream.read(64 * 1024)
                    if not chunk:
                        break
                    yield chunk
            finally:
                upstream.close()

        return StreamingResponse(
            stream_chunks(),
            status_code=status,
            headers=response_headers,
            media_type=upstream.headers.get_content_type() or "audio/mpeg",
        )
    except HTTPError as error:
        return JSONResponse(status_code=502, content={"detail": f"Audius stream returned HTTP {error.code}."})
    except (URLError, TimeoutError, OSError) as error:
        print("Audius stream proxy error:", str(error))
        return JSONResponse(status_code=502, content={"detail": "Audius stream is temporarily unavailable."})
'''
b = b.replace(anchor, route + anchor, 1)
backend.write_text(b, encoding="utf-8")

f = frontend.read_text(encoding="utf-8")
f = f.replace("import { apiFetch, readJson } from '../services/api'", "import { API_URL, apiFetch, readJson } from '../services/api'", 1)
old_error = """          {audiusFallbackCurrent && <audio key={audiusFallbackCurrent.id} src={audiusFallbackCurrent.stream_url} controls autoPlay onError={() => setAudiusFallbackMessage('This Audius stream could not be played. Try another result.')} className="w-full" />}"""
new_error = """          {audiusFallbackCurrent && <audio
            key={audiusFallbackCurrent.id}
            src={API_URL + audiusFallbackCurrent.stream_url}
            controls
            autoPlay
            onError={() => {
              const currentIndex = audiusFallbackTracks.findIndex(track => track.id === audiusFallbackCurrent.id)
              const nextTrack = currentIndex >= 0 ? audiusFallbackTracks[currentIndex + 1] : undefined
              if (nextTrack) {
                setAudiusFallbackMessage('That Audius stream failed. Automatically trying ' + nextTrack.name + '…')
                setAudiusFallbackCurrent(nextTrack)
              } else {
                setAudiusFallbackMessage('Audius could not play the available results. Try another search or open the Audius track page.')
              }
            }}
            className="w-full"
          />}"""
if old_error not in f:
    raise SystemExit("Audius audio element not found.")
f = f.replace(old_error, new_error, 1)
frontend.write_text(f, encoding="utf-8")
print("Added authenticated-app-safe Audius stream proxy with HTTP Range support; frontend now uses it and advances to the next result after a playback failure.")
print("Backups:", backend.with_name(f"api.py.before-audius-proxy-{stamp}.bak"), frontend.with_name(f"YouTubeMusic.tsx.before-audius-proxy-{stamp}.bak"))
