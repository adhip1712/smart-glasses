from pathlib import Path
from datetime import datetime
import shutil

root = Path(r"C:\Users\adhip\OneDrive\All Projects\Smartglasses\smart-glasses")
backend = root / "backend" / "api.py"
frontend = root / "Frontend" / "src" / "components" / "YouTubeMusic.tsx"
stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
shutil.copy2(backend, backend.with_name(f"api.py.before-youtube-alternatives-{stamp}.bak"))
shutil.copy2(frontend, frontend.with_name(f"YouTubeMusic.tsx.before-youtube-alternatives-{stamp}.bak"))

b = backend.read_text(encoding="utf-8")
anchor = '\n\n@app.post("/api/music/correct-query")'
if anchor not in b:
    raise SystemExit("Backend insertion point not found; no changes made.")
endpoint = r'''

@app.get("/api/music/youtube-alternative-search")
def music_youtube_alternative_search(q: str = "", limit: int = 18):
    """Search public Piped and Invidious instances after official YouTube API quota limits."""
    query = (q or "").strip()
    if not query:
        return {"success": False, "tracks": [], "source": "", "message": "Enter a song, artist or genre to search."}

    max_results = max(1, min(int(limit or 18), 20))
    headers = {"Accept": "application/json", "User-Agent": "VisionaryNexus/1.0"}
    piped_instances = [
        "https://pipedapi.adminforge.de",
        "https://pipedapi.leptons.xyz",
    ]
    invidious_instances = [
        "https://inv.nadeko.net",
        "https://invidious.nerdvpn.de",
        "https://inv.tux.pizza",
    ]

    def clean_video_id(value):
        text = str(value or "")
        match = re.search(r"(?:v=|/watch/|/shorts/|^)([A-Za-z0-9_-]{11})(?:\b|$)", text)
        return match.group(1) if match else ""

    def valid_track(track):
        title = str(track.get("name") or "")
        duration = int(track.get("durationSeconds") or 0)
        return bool(track.get("id") and title and
                    not re.search(r"\bshorts?\b|#shorts", title, re.IGNORECASE) and
                    not (duration and duration <= 60))

    # Piped first: it exposes YouTube search metadata without consuming the
    # official YouTube Data API quota.
    for instance in piped_instances:
        try:
            params = urlencode({"q": query, "filter": "music_songs"})
            request = Request(instance + "/search?" + params, headers=headers)
            with urlopen(request, timeout=4) as response:
                payload = json.loads(response.read().decode("utf-8", errors="replace"))
            items = payload if isinstance(payload, list) else payload.get("items") or []
            tracks = []
            for item in items:
                if not isinstance(item, dict):
                    continue
                video_id = clean_video_id(item.get("url") or item.get("videoId"))
                if not video_id:
                    continue
                track = {
                    "id": video_id,
                    "name": str(item.get("title") or "YouTube video"),
                    "artist": str(item.get("uploaderName") or item.get("uploader") or "YouTube"),
                    "durationSeconds": int(item.get("duration") or 0),
                    "image": str(item.get("thumbnail") or ""),
                    "url": "https://www.youtube.com/watch?v=" + video_id,
                    "provider": "youtube",
                    "searchSource": "Piped",
                }
                if valid_track(track):
                    tracks.append(track)
                if len(tracks) >= max_results:
                    break
            if tracks:
                return {"success": True, "tracks": tracks, "query": query, "source": "piped",
                        "message": f"Found {len(tracks)} YouTube matches through Piped."}
        except Exception as error:
            print("Piped fallback search error:", str(error))
            continue

    # Invidious is the second YouTube-catalogue search source.
    for instance in invidious_instances:
        try:
            params = urlencode({"q": query, "type": "video", "sort_by": "relevance"})
            request = Request(instance + "/api/v1/search?" + params, headers=headers)
            with urlopen(request, timeout=4) as response:
                payload = json.loads(response.read().decode("utf-8", errors="replace"))
            items = payload if isinstance(payload, list) else []
            tracks = []
            for item in items:
                if not isinstance(item, dict) or item.get("type") not in (None, "video"):
                    continue
                video_id = clean_video_id(item.get("videoId"))
                if not video_id:
                    continue
                thumbnails = item.get("videoThumbnails") or []
                image = next((str(pic.get("url") or "") for pic in thumbnails
                              if isinstance(pic, dict) and pic.get("url")), "")
                track = {
                    "id": video_id,
                    "name": str(item.get("title") or "YouTube video"),
                    "artist": str(item.get("author") or "YouTube"),
                    "durationSeconds": int(item.get("lengthSeconds") or 0),
                    "image": image,
                    "url": "https://www.youtube.com/watch?v=" + video_id,
                    "provider": "youtube",
                    "searchSource": "Invidious",
                }
                if valid_track(track):
                    tracks.append(track)
                if len(tracks) >= max_results:
                    break
            if tracks:
                return {"success": True, "tracks": tracks, "query": query, "source": "invidious",
                        "message": f"Found {len(tracks)} YouTube matches through Invidious."}
        except Exception as error:
            print("Invidious fallback search error:", str(error))
            continue

    return {"success": False, "tracks": [], "query": query, "source": "",
            "message": "Piped and Invidious did not return results. Audius can be tried next."}
'''
b = b.replace(anchor, endpoint + anchor, 1)
backend.write_text(b, encoding="utf-8")

f = frontend.read_text(encoding="utf-8")
anchor = "  // Audius is the in-app automatic fallback when YouTube search quota is exhausted.\n"
if anchor not in f:
    raise SystemExit("Frontend insertion point not found after backend edit.")
fn = '''  // Try other YouTube-catalogue search sources before switching to Audius.
  const searchYouTubeAlternatives = async (term: string, autoplay = false, reservedTab?: Window | null) => {
    setMessage('YouTube API quota exhausted. Trying Piped, then Invidious…')
    try {
      const response = await apiFetch('/api/music/youtube-alternative-search?q=' + encodeURIComponent(term) + '&limit=18')
      const data = await readJson<{ success?: boolean; tracks?: YouTubeTrack[]; source?: string; message?: string }>(response)
      const found = (data?.tracks || []).filter(track => track?.provider?.toLowerCase() === 'youtube' && track.id)
      if (response.ok && data?.success && found.length) {
        setResults(found)
        setMessage(data.message || 'Found YouTube results through an alternative search source.')
        if (autoplay) {
          const selected = bestFullSongMatch(term, found)
          if (selected) playTrack(selected, found, reservedTab)
          else setMessage('Alternative YouTube results were found, but none confidently matched the full song. Choose a result to play.')
        }
        return
      }
    } catch (error) {
      console.warn('Alternative YouTube catalogue search failed:', error)
    }
    setResults([])
    setMessage('Piped and Invidious could not find a result. Automatically trying Audius…')
    void searchAudiusFallback(term)
  }

'''
f = f.replace(anchor, fn + anchor, 1)
f = f.replace("void searchAudiusFallback(clean)", "void searchYouTubeAlternatives(clean, autoplay, reservedTab)")
f = f.replace("YouTube is primary; Audius automatically takes over in-app if YouTube search quota runs out.", "YouTube is primary; Piped and Invidious search its catalogue if the API quota runs out, then Audius is tried automatically.")
f = f.replace("Visionary Nexus searches Audius and plays a streamable match here when YouTube quota is exhausted.", "Visionary Nexus automatically reaches Audius after Piped and Invidious cannot find a YouTube match.")
frontend.write_text(f, encoding="utf-8")
print("Updated backend and frontend. Backups:", backend.with_name(f"api.py.before-youtube-alternatives-{stamp}.bak"), frontend.with_name(f"YouTubeMusic.tsx.before-youtube-alternatives-{stamp}.bak"))
