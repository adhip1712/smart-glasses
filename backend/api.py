# =========================================================
# VISIONARY NEXUS - BACKEND API
# =========================================================

import os
import json
import re
import time

from datetime import datetime
from urllib.parse import urlencode, quote
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

import jwt

from dotenv import load_dotenv

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from pydantic import BaseModel

from groq import Groq

from sqlalchemy.orm import Session

try:
    from backend.database import engine, SessionLocal, Base
    from backend.models import Conversation, Message, RecentLocation, MusicPlaylist, Setting
    from backend.device_api import router as device_router
    from backend.camera_api import router as camera_router
    from backend.vision_api import router as vision_router
except ImportError:
    from database import engine, SessionLocal, Base
    from models import Conversation, Message, RecentLocation, MusicPlaylist, Setting
    from device_api import router as device_router
    from camera_api import router as camera_router
    from vision_api import router as vision_router


# =========================================================
# DATABASE
# =========================================================

Base.metadata.create_all(bind=engine)


# =========================================================
# ENVIRONMENT
# =========================================================

ENV_PATH = os.path.join(
    os.path.dirname(__file__),
    "..",
    ".env",
)

load_dotenv(ENV_PATH)

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
WEATHER_API_KEY = os.getenv("WEATHER_API_KEY")
YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY")
NAVIDROME_URL = os.getenv("NAVIDROME_URL", "http://127.0.0.1:4533").rstrip("/")
NAVIDROME_USERNAME = (os.getenv("NAVIDROME_USERNAME") or "").strip()
NAVIDROME_PASSWORD = (os.getenv("NAVIDROME_PASSWORD") or "").strip()
NAVIDROME_ENABLED = (os.getenv("NAVIDROME_ENABLED", "true") or "true").strip().lower() == "true"
APPLE_MUSIC_KEY_ID = os.getenv("APPLE_MUSIC_KEY_ID")
APPLE_MUSIC_TEAM_ID = os.getenv("APPLE_MUSIC_TEAM_ID")
APPLE_MUSIC_PRIVATE_KEY = os.getenv("APPLE_MUSIC_PRIVATE_KEY")
APPLE_MUSIC_PROVIDER = os.getenv("APPLE_MUSIC_PROVIDER", "mock").lower()
WEATHER_PROVIDER = os.getenv("WEATHER_PROVIDER", "mock").lower()
NAVIGATION_PROVIDER = os.getenv("NAVIGATION_PROVIDER", "mock").lower()
APPLE_MUSIC_BASE_URL = os.getenv("APPLE_MUSIC_BASE_URL", "https://itunes.apple.com")
WEATHER_BASE_URL = os.getenv("WEATHER_BASE_URL", "https://api.weatherapi.com")
NAVIGATION_BASE_URL = os.getenv("NAVIGATION_BASE_URL", "https://nominatim.openstreetmap.org")


def _load_apple_music_private_key() -> str | None:
    value = (APPLE_MUSIC_PRIVATE_KEY or "").strip()
    if not value:
        return None

    if os.path.exists(value):
        try:
            with open(value, "r", encoding="utf-8") as key_file:
                return key_file.read().strip()
        except OSError:
            return None

    return value.replace("\\n", "\n").strip()


def generate_apple_music_developer_token() -> str:
    if not APPLE_MUSIC_KEY_ID or not APPLE_MUSIC_TEAM_ID:
        raise ValueError("Apple MusicKit developer credentials are missing: APPLE_MUSIC_KEY_ID and APPLE_MUSIC_TEAM_ID are required.")

    private_key = _load_apple_music_private_key()
    if not private_key:
        raise ValueError("Apple MusicKit developer credentials are missing: APPLE_MUSIC_PRIVATE_KEY is required.")

    now = int(time.time())
    payload = {
        "iss": APPLE_MUSIC_TEAM_ID,
        "iat": now,
        "exp": now + 15777000,
    }
    headers = {
        "alg": "ES256",
        "kid": APPLE_MUSIC_KEY_ID,
    }
    return jwt.encode(payload, private_key, algorithm="ES256", headers=headers)


# =========================================================
# PROVIDERS
# =========================================================

class BaseMusicProvider:
    def search(self, query: str):
        raise NotImplementedError


class MockMusicProvider(BaseMusicProvider):
    def search(self, query: str):
        clean_query = (query or "unknown").strip()
        if not clean_query:
            return []

        tokens = [
            part.capitalize()
            for part in re.split(r"\s+", clean_query)
            if part
        ]
        base_name = " ".join(tokens[:3]) or "Preview Track"

        return [
            {
                "id": f"mock-{index}",
                "name": f"{base_name} {index + 1}",
                "artist": "Smart Glasses Studio",
                "album": "Generated Mix",
                "duration": 210000 + index * 18000,
                "image": "https://images.unsplash.com/photo-1511379938547-c1f69419868d?auto=format&fit=crop&w=600&q=80",
                "audio": "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
                "url": "https://music.apple.com",
                "genre": "Ambient",
                "score": 100 - index,
            }
            for index in range(3)
        ]


class RealMusicProvider(BaseMusicProvider):
    def _search_itunes(self, clean_query: str):
        """Search Apple's public iTunes catalogue and return playable preview clips."""
        params = urlencode({"term": clean_query, "entity": "song", "limit": 10, "country": "US"})
        search_url = f"{APPLE_MUSIC_BASE_URL.rstrip('/')}/search?{params}"
        request = Request(search_url, headers={"User-Agent": "VISIONARY-NEXUS/1.0", "Accept": "application/json"}, method="GET")
        try:
            with urlopen(request, timeout=2) as response:
                payload = json.loads(response.read().decode("utf-8", errors="ignore"))
        except (HTTPError, URLError, TimeoutError, ValueError):
            return []

        tracks = []
        for index, item in enumerate(payload.get("results", [])):
            track_id = item.get("trackId") or item.get("collectionId")
            title = item.get("trackName")
            if not title:
                continue
            artwork = item.get("artworkUrl100") or item.get("artworkUrl60") or ""
            if artwork:
                artwork = re.sub(r"\d+x\d+bb", "600x600bb", artwork)
            tracks.append({
                "id": str(track_id or f"itunes-{index}"),
                "name": title,
                "artist": item.get("artistName") or "Unknown artist",
                "album": item.get("collectionName") or "",
                "duration": item.get("trackTimeMillis") or 0,
                "image": artwork,
                "audio": item.get("previewUrl") or "",
                "url": item.get("trackViewUrl") or item.get("collectionViewUrl") or "https://music.apple.com",
                "genre": item.get("primaryGenreName") or "Apple Music",
                "provider": "apple-itunes",
                "score": 100 - index,
            })
        return tracks

    def _search_ytdlp(self, query: str):
        """Fallback search when YouTube Data API quota/rate limits are hit."""
        try:
            import yt_dlp
            options = {
                "quiet": True,
                "no_warnings": True,
                "skip_download": True,
                "extract_flat": "in_playlist",
                "ignoreerrors": True,
                "socket_timeout": 2,
                "retries": 0,
                "extractor_retries": 0,
            }
            with yt_dlp.YoutubeDL(options) as ydl:
                payload = ydl.extract_info(f"ytsearch5:{query}", download=False)
        except Exception:
            return []

        tracks = []
        for index, item in enumerate((payload or {}).get("entries") or []):
            if not item:
                continue
            video_id = item.get("id")
            if not video_id:
                continue
            title = item.get("title") or "YouTube Track"
            channel = item.get("channel") or item.get("uploader") or "YouTube"
            duration_seconds = int(item.get("duration") or 0)
            track_url = f"https://www.youtube.com/watch?v={video_id}"
            tracks.append({
                "id": video_id,
                "name": title,
                "artist": channel,
                "album": channel,
                "duration": duration_seconds * 1000,
                "image": item.get("thumbnail") or "",
                "audio": track_url,
                "url": track_url,
                "genre": "YouTube",
                "videoId": video_id,
                "provider": "youtube",
                "score": 100 - index,
            })
        return tracks

    def search(self, query: str):
        clean_query = (query or "").strip()
        if not clean_query:
            return []

        if not YOUTUBE_API_KEY:
            return self._search_itunes(clean_query)

        search_params = urlencode({
            "part": "snippet",
            "q": clean_query,
            "type": "video",
            "videoEmbeddable": "true",
            "videoCategoryId": "10",
            # Keep fallback searches fast while still checking several alternate channels.
            "maxResults": 10,
            "order": "relevance",
            "safeSearch": "moderate",
            "key": YOUTUBE_API_KEY,
        })

        search_url = f"https://www.googleapis.com/youtube/v3/search?{search_params}"
        search_request = Request(
            search_url,
            headers={
                "User-Agent": "VISIONARY-NEXUS/1.0",
                "Accept": "application/json",
            },
            method="GET",
        )

        try:
            with urlopen(search_request, timeout=2) as response:
                search_data = json.loads(response.read().decode("utf-8", errors="ignore"))
        except (HTTPError, URLError, TimeoutError, ValueError) as exc:
            # YouTube quota/rate-limit errors (including HTTP 429) must not crash
            # music search. Fall back to yt-dlp's independent search extractor.
            if isinstance(exc, HTTPError) and exc.code not in (403, 429, 500, 502, 503, 504):
                raise
            return self._search_ytdlp(clean_query)

        items = search_data.get("items", [])
        video_ids = [item.get("id", {}).get("videoId") for item in items if item.get("id", {}).get("videoId")]

        if not video_ids:
            return []

        detail_params = urlencode({
            "part": "snippet,contentDetails,status",
            "id": ",".join(video_ids),
            "key": YOUTUBE_API_KEY,
        })
        detail_url = f"https://www.googleapis.com/youtube/v3/videos?{detail_params}"
        detail_request = Request(
            detail_url,
            headers={
                "User-Agent": "VISIONARY-NEXUS/1.0",
                "Accept": "application/json",
            },
            method="GET",
        )

        try:
            with urlopen(detail_request, timeout=2) as response:
                detail_data = json.loads(response.read().decode("utf-8", errors="ignore"))
        except (HTTPError, URLError, TimeoutError, ValueError) as exc:
            if isinstance(exc, HTTPError) and exc.code not in (403, 429, 500, 502, 503, 504):
                raise
            return self._search_ytdlp(clean_query)

        detail_map = {
            item.get("id"): item
            for item in detail_data.get("items", [])
            if item.get("id")
        }

        tracks = []
        for index, item in enumerate(items):
            video_id = item.get("id", {}).get("videoId")
            if not video_id:
                continue

            snippet = item.get("snippet", {})
            detail = detail_map.get(video_id, {})
            status = detail.get("status", {})
            if not status.get("embeddable", True):
                continue

            title = snippet.get("title") or "YouTube Track"
            artist = snippet.get("channelTitle") or "YouTube"
            thumbnails = snippet.get("thumbnails", {})
            image = ""
            for size in ["maxres", "high", "medium", "default"]:
                candidate = thumbnails.get(size)
                if candidate:
                    image = candidate.get("url") or ""
                    break

            duration_raw = detail.get("contentDetails", {}).get("duration")
            duration_seconds = 0
            if duration_raw:
                values = [int(value) for value in re.findall(r"(\d+)", duration_raw)]
                if len(values) == 3:
                    duration_seconds = values[0] * 3600 + values[1] * 60 + values[2]
                elif len(values) == 2:
                    duration_seconds = values[0] * 60 + values[1]
                elif len(values) == 1:
                    duration_seconds = values[0]

            track_url = f"https://www.youtube.com/watch?v={video_id}"
            tracks.append({
                "id": video_id,
                "name": title,
                "artist": artist,
                "album": artist,
                "duration": duration_seconds * 1000,
                "image": image,
                "audio": track_url,
                "url": track_url,
                "genre": "YouTube",
                "videoId": video_id,
                "provider": "youtube",
                "score": 100 - index,
            })

        # Prefer the requested song in a normal-length upload over a 1-hour,
        # ultra-slowed, or otherwise altered upload unless the user asked for it.
        query_terms = set(re.findall(r"[a-z0-9]+", clean_query.casefold()))
        asks_for_altered_version = bool(query_terms & {
            "slowed", "ultra", "super", "speed", "sped", "nightcore", "remix",
            "reverb", "extended", "hour", "hours", "1hr", "1hour", "loop", "looped",
        })
        altered_title_pattern = re.compile(
            r"\b(?:ultra[ -]?slowed|super[ -]?slowed|slowed(?:[ -]+(?:and|\+|with)?[ -]*reverb)?|"
            r"\d+\s*(?:hours?|hrs?|hr)\b|one[ -]?hour|1[ -]?hour|extended[ -]?mix|"
            r"10[ -]?hours?|looped?)\b",
            re.IGNORECASE,
        )

        def youtube_rank(track):
            title = str(track.get("name") or "").casefold()
            title_terms = set(re.findall(r"[a-z0-9]+", title))
            duration_seconds = int(track.get("duration") or 0) // 1000
            exact_phrase = bool(clean_query) and clean_query.casefold() in title
            token_overlap = len(query_terms & title_terms)
            altered_penalty = 0 if asks_for_altered_version or not altered_title_pattern.search(title) else 500
            # Prefer ordinary song lengths when available; do not reject live versions.
            duration_penalty = 0 if asks_for_altered_version else (250 if duration_seconds > 900 else 0)
            normal_song_bonus = 20 if 90 <= duration_seconds <= 600 else 0
            return (int(exact_phrase) * 1000 + token_overlap * 30 + normal_song_bonus
                    - altered_penalty - duration_penalty + int(track.get("score", 0)))

        tracks.sort(key=youtube_rank, reverse=True)
        return tracks[:20]


class AudiusMusicProvider(BaseMusicProvider):
    """Free, public-catalog music search and full-track streaming via Audius."""

    BASE_URL = "https://discoveryprovider.audius.co/v1"

    def _request(self, path: str, params: dict | None = None):
        query = urlencode(params or {})
        url = f"{self.BASE_URL}/{path.lstrip('/')}" + (f"?{query}" if query else "")
        request = Request(
            url,
            headers={"User-Agent": "VISIONARY-NEXUS/1.0", "Accept": "application/json"},
            method="GET",
        )
        with urlopen(request, timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8", errors="ignore"))
        return payload.get("data") or []

    def search(self, query: str):
        clean_query = (query or "").strip()
        if not clean_query:
            return []

        # Correct common phonetic spelling of the Portuguese word "montagem"
        # while preserving the rest of the user's words.
        normalized_query = re.sub(r"\bmontegam\b", "montagem", clean_query, flags=re.IGNORECASE)
        queries = [normalized_query]
        if normalized_query.casefold() != clean_query.casefold():
            queries.append(clean_query)

        raw_tracks = []
        seen_ids = set()
        for candidate_query in queries:
            try:
                results = self._request("tracks/search", {"query": candidate_query, "limit": 10})
            except (HTTPError, URLError, TimeoutError, ValueError):
                continue
            for item in results:
                track_id = str(item.get("track_id") or item.get("id") or "")
                if not track_id or track_id in seen_ids:
                    continue
                if not item.get("is_streamable", True) or item.get("is_stream_gated", False):
                    continue
                seen_ids.add(track_id)
                raw_tracks.append(item)
            if raw_tracks:
                break

        tracks = []
        for index, item in enumerate(raw_tracks[:10]):
            track_id = str(item.get("track_id") or item.get("id") or "")
            title = item.get("title") or "Untitled track"
            user = item.get("user") or {}
            artist = user.get("name") or user.get("handle") or "Audius artist"
            artwork = item.get("artwork") or {}
            image = artwork.get("480x480") or artwork.get("150x150") or ""
            stream = item.get("stream") or {}
            audio_url = stream.get("url") if isinstance(stream, dict) else ""
            if not audio_url and track_id:
                audio_url = f"{self.BASE_URL}/tracks/{quote(track_id)}/stream"
            if not audio_url:
                continue
            tracks.append({
                "id": track_id,
                "name": title,
                "artist": artist,
                "album": "",
                "duration": int(item.get("duration") or 0) * 1000,
                "image": image,
                "audio": audio_url,
                "url": f"https://audius.co{item.get('permalink')}" if item.get("permalink") else "https://audius.co",
                "genre": item.get("genre") or "Audius",
                "provider": "audius",
                "score": 100 - index,
            })
        return tracks


class NavidromeMusicProvider(BaseMusicProvider):
    def __init__(self):
        self.base_url = NAVIDROME_URL or "http://127.0.0.1:4533"
        self.username = NAVIDROME_USERNAME
        self.password = NAVIDROME_PASSWORD
        self.enabled = NAVIDROME_ENABLED and bool(self.base_url) and bool(self.username)

    def _request(self, endpoint: str, params: dict):
        if not self.enabled:
            raise RuntimeError("Navidrome is not configured.")

        query = dict(params)
        query.update({
            "u": self.username,
            "p": self.password,
            "c": "SmartGlasses",
            "v": "1.16.1",
            "f": "json",
        })
        request_url = f"{self.base_url}/rest/{endpoint}?{urlencode(query)}"
        request = Request(request_url, headers={"User-Agent": "VISIONARY-NEXUS/1.0"}, method="GET")

        with urlopen(request, timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8", errors="ignore"))

        response_data = payload.get("subsonic-response", {})
        status = response_data.get("status")
        if status != "ok":
            error = response_data.get("error") or {}
            message = error.get("message") or "Navidrome request failed."
            raise RuntimeError(message)

        return response_data

    def _stream_url(self, track_id: str) -> str:
        if not track_id:
            return ""
        params = {
            "u": self.username,
            "p": self.password,
            "v": "1.16.1",
            "c": "SmartGlasses",
            "id": str(track_id),
        }
        return f"{self.base_url}/rest/stream?{urlencode(params)}"

    def _track_score(self, query: str, song: dict) -> int:
        clean_query = (query or "").strip().lower()
        if not clean_query:
            return 0

        query_tokens = set(re.split(r"\s+", re.sub(r"[^a-z0-9]+", " ", clean_query).strip())) - {""}
        title = (song.get("title") or "").lower()
        artist = (song.get("artist") or "").lower()
        album = (song.get("album") or "").lower()

        title_tokens = set(re.split(r"\s+", re.sub(r"[^a-z0-9]+", " ", title).strip())) - {""}
        artist_tokens = set(re.split(r"\s+", re.sub(r"[^a-z0-9]+", " ", artist).strip())) - {""}
        album_tokens = set(re.split(r"\s+", re.sub(r"[^a-z0-9]+", " ", album).strip())) - {""}

        score = 0
        for token in query_tokens:
            if token in title_tokens:
                score += 40
            if token in artist_tokens:
                score += 18
            if token in album_tokens:
                score += 12

        if title == clean_query:
            score += 25
        if artist and clean_query in artist:
            score += 12
        return score

    def search(self, query: str):
        clean_query = (query or "").strip()
        if not clean_query:
            return []
        if not self.enabled:
            return []

        try:
            payload = self._request("search3", {"query": clean_query, "songCount": 20})
        except (HTTPError, URLError, RuntimeError, ValueError):
            return []

        songs = payload.get("searchResult3", {}).get("song", [])
        if isinstance(songs, dict):
            songs = [songs]
        if not songs:
            return []

        tracks = []
        for song in songs:
            song_id = song.get("id")
            title = song.get("title") or "Untitled Track"
            artist = song.get("artist") or "Unknown Artist"
            album = song.get("album") or "Unknown Album"
            duration_ms = int((song.get("duration") or 0) * 1000)
            image = ""
            cover_art = song.get("coverArt")
            if cover_art:
                image = f"{self.base_url}/rest/getCoverArt?u={quote(self.username)}&p={quote(self.password)}&v=1.16.1&c=SmartGlasses&id={cover_art}&size=600"

            track = {
                "id": str(song_id),
                "name": title,
                "artist": artist,
                "album": album,
                "duration": duration_ms,
                "image": image,
                "audio": self._stream_url(str(song_id)),
                "url": self._stream_url(str(song_id)),
                "genre": song.get("genre") or "Navidrome",
                "provider": "navidrome",
                "trackId": str(song_id),
                "score": self._track_score(clean_query, song),
            }
            tracks.append(track)

        tracks.sort(key=lambda item: item.get("score", 0), reverse=True)
        return tracks[:10]


class MusicService:
    def __init__(self, provider: BaseMusicProvider | None = None):
        if provider is None:
            if NAVIDROME_ENABLED and NAVIDROME_URL and NAVIDROME_USERNAME:
                provider = NavidromeMusicProvider()
            elif APPLE_MUSIC_PROVIDER == "mock":
                provider = MockMusicProvider()
            elif not YOUTUBE_API_KEY:
                # Audius offers a free public music catalogue and streamable tracks
                # without requiring a YouTube API key or a music subscription.
                provider = AudiusMusicProvider()
            else:
                provider = RealMusicProvider()
        self.provider = provider

    def search(self, query: str):
        normalized = (query or "").strip()
        tracks = self.provider.search(normalized)
        source_name = "mock"
        notice = "Mock music mode enabled."

        if isinstance(self.provider, NavidromeMusicProvider):
            source_name = "navidrome"
            notice = "Navidrome library results are ready for playback."
        elif isinstance(self.provider, AudiusMusicProvider):
            source_name = "audius"
            notice = (
                "Full-track streaming from Audius. If the exact song is unavailable, "
                "no short preview will be substituted."
            )
        elif isinstance(self.provider, RealMusicProvider):
            source_name = "youtube" if YOUTUBE_API_KEY else "apple-itunes"
            notice = (
                "YouTube search results are returned for browser playback."
                if YOUTUBE_API_KEY
                else "Apple catalogue results include short previews where available."
            )

        # Rank against the user's original query, but also account for the
        # phonetic spelling correction used by the Audius provider.
        query_tokens = set(re.findall(r"[a-z0-9]+", normalized.casefold()))
        match_query = normalized
        if isinstance(self.provider, AudiusMusicProvider):
            match_query = re.sub(r"\bmontegam\b", "montagem", normalized, flags=re.IGNORECASE)
        query_tokens_for_match = set(re.findall(r"[a-z0-9]+", match_query.casefold()))

        asks_for_variant = bool(query_tokens_for_match & {
            "slowed", "ultra", "super", "speed", "sped", "nightcore", "remix",
            "reverb", "extended", "hour", "hours", "1hr", "1hour", "loop", "looped",
        })
        altered_title_pattern = re.compile(
            r"\b(?:ultra[ -]?slowed|super[ -]?slowed|slowed(?:[ -]+(?:and|\+|with)?[ -]*reverb)?|"
            r"\d+\s*(?:hours?|hrs?|hr)\b|one[ -]?hour|1[ -]?hour|extended[ -]?mix|10[ -]?hours?|looped?)\b",
            re.IGNORECASE,
        )
        is_youtube_search = isinstance(self.provider, RealMusicProvider) and bool(YOUTUBE_API_KEY)

        def track_rank(track):
            title = str(track.get("name") or "").casefold()
            artist = str(track.get("artist") or "").casefold()
            title_tokens = set(re.findall(r"[a-z0-9]+", title))
            artist_tokens = set(re.findall(r"[a-z0-9]+", artist))
            matched_title = len(query_tokens_for_match & title_tokens)
            matched_artist = len(query_tokens_for_match & artist_tokens)
            duration = int(track.get("duration") or 0)
            exact_phrase = bool(match_query) and match_query.casefold() in title
            altered = bool(altered_title_pattern.search(title))
            prefer_requested_version = int(not is_youtube_search or asks_for_variant or not altered)
            avoid_hour_loop = int(not is_youtube_search or asks_for_variant or duration <= 900000)
            normal_song_bonus = int(is_youtube_search and 90000 <= duration <= 600000)
            return (
                prefer_requested_version,
                avoid_hour_loop,
                int(exact_phrase),
                matched_title,
                matched_artist,
                normal_song_bonus,
                int(duration >= 60000),
                duration,
            )

        if tracks:
            # Do not report a completely unrelated Audius result as a successful
            # match for a multi-word song title (e.g. "montegam elder" -> "Sem Demora").
            # Single-word genre searches such as "phonk" remain broad by design.
            if isinstance(self.provider, AudiusMusicProvider) and len(query_tokens_for_match) >= 2:
                relevant_tracks = [
                    track for track in tracks
                    if query_tokens_for_match
                    & (
                        set(re.findall(r"[a-z0-9]+", str(track.get("name") or "").casefold()))
                        | set(re.findall(r"[a-z0-9]+", str(track.get("artist") or "").casefold()))
                    )
                ]
                tracks = relevant_tracks

            tracks.sort(key=track_rank, reverse=True)
            tracks_at_least_one_minute = [
                track for track in tracks
                if int(track.get("duration") or 0) >= 60000
            ]
            if tracks_at_least_one_minute:
                tracks = tracks_at_least_one_minute
            if any(query_tokens_for_match & set(re.findall(r"[a-z0-9]+", str(track.get("name") or "").casefold())) for track in tracks):
                notice = notice + " Short clips under 60 seconds are excluded when longer matches are available."

        return {
            "success": bool(tracks),
            "query": normalized,
            "tracks": tracks,
            "source": source_name,
            "notice": notice,
        }

    def play(self, query: str):
        # Remove command phrasing before searching. Otherwise searching
        # "play spooky" can return a podcast episode about spooky season instead
        # of searching for the song title "spooky".
        search_query = re.sub(
            r"^\s*(?:(?:please\s+)?play|listen\s+to|put\s+on)\s+",
            "",
            (query or "").strip(),
            flags=re.IGNORECASE,
        ).strip()
        result = self.search(search_query)
        tracks = result.get("tracks") or []
        if not result.get("success") or not tracks:
            return {"success": False, "message": "I couldn't find that song.", "tracks": []}

        # Never start an unrelated first search result. If the user says
        # "title by artist", validate title and artist against separate fields;
        # a cover whose title contains the artist's name is not the requested artist.
        stop_words = {"play", "please", "song", "music", "track", "the", "a", "an", "by", "on", "for", "me"}
        artist_match = re.search(r"\bby\s+(.+)$", search_query, re.IGNORECASE)
        title_query = search_query[:artist_match.start()].strip() if artist_match else search_query
        title_tokens = set(re.findall(r"[a-z0-9]+", title_query.casefold())) - stop_words
        artist_tokens = (
            set(re.findall(r"[a-z0-9]+", artist_match.group(1).casefold())) - stop_words
            if artist_match else set()
        )
        query_tokens = title_tokens | artist_tokens
        if query_tokens:
            def covers_query(track):
                track_title_tokens = set(re.findall(r"[a-z0-9]+", str(track.get("name", "")).casefold()))
                track_artist_tokens = set(re.findall(r"[a-z0-9]+", str(track.get("artist", "")).casefold()))
                if artist_tokens:
                    return title_tokens.issubset(track_title_tokens) and artist_tokens.issubset(track_artist_tokens)
                return title_tokens.issubset(track_title_tokens) or title_tokens.issubset(track_artist_tokens)

            matching_tracks = [track for track in tracks if covers_query(track)]
            if not matching_tracks:
                return {
                    "success": False,
                    "message": (
                        f"I found related results, but none matched all the requested title/artist words "
                        f"for '{query}'. I won't play an unrelated track."
                    ),
                    "tracks": tracks,
                    "source": result.get("source"),
                    "needs_confirmation": True,
                }
            tracks = matching_tracks

        track = tracks[0]
        return {
            "success": True,
            "message": f"Playing {track.get('name', 'track')} by {track.get('artist', 'Unknown artist')}",
            "track": track,
            "tracks": tracks,
            "source": result["source"],
        }

    def pause(self):
        return {"success": True, "message": "Music paused."}

    def resume(self):
        return {"success": True, "message": "Music resumed."}

    def next(self):
        return {"success": True, "message": "Playing the next song."}

    def previous(self):
        return {"success": True, "message": "Playing the previous song."}


class BaseWeatherProvider:
    def get_current(self, city: str):
        raise NotImplementedError

    def get_forecast(self, city: str):
        raise NotImplementedError


class MockWeatherProvider(BaseWeatherProvider):
    def get_current(self, city: str):
        city_name = (city or "Bengaluru").strip() or "Bengaluru"
        now = datetime.utcnow().isoformat()
        return {
            "success": True,
            "location": city_name,
            "region": "Mock Region",
            "country": "Mock Country",
            "temperature_c": 28,
            "feels_like_c": 30,
            "humidity": 58,
            "wind_kph": 12,
            "condition": "Partly cloudy",
            "condition_icon": "//cdn.weatherapi.com/weather/64x64/day/116.png",
            "last_updated": now,
            "source": "mock",
            "forecast": [],
        }

    def get_forecast(self, city: str):
        current = self.get_current(city)
        current["forecast"] = [
            {"date": "today", "condition": "Partly cloudy", "temperature_c": 28},
            {"date": "tomorrow", "condition": "Rain likely", "temperature_c": 27},
        ]
        current["source"] = "mock"
        return current


class RealWeatherProvider(BaseWeatherProvider):
    @staticmethod
    def _weather_code_to_text(code):
        mapping = {
            0: "Clear sky",
            1: "Mostly clear",
            2: "Partly cloudy",
            3: "Overcast",
            45: "Foggy",
            48: "Rime fog",
            51: "Light drizzle",
            53: "Moderate drizzle",
            55: "Dense drizzle",
            56: "Freezing drizzle",
            57: "Heavy freezing drizzle",
            61: "Slight rain",
            63: "Moderate rain",
            65: "Heavy rain",
            66: "Freezing rain",
            67: "Heavy freezing rain",
            71: "Slight snow",
            73: "Moderate snow",
            75: "Heavy snow",
            77: "Snow grains",
            80: "Rain showers",
            81: "Heavy rain showers",
            82: "Violent rain showers",
            85: "Snow showers",
            86: "Heavy snow showers",
            95: "Thunderstorm",
            96: "Thunderstorm with hail",
            99: "Severe thunderstorm",
        }
        return mapping.get(code, "Unknown")

    @staticmethod
    def _geo_lookup(city: str):
        city_name = (city or "").strip()
        if not city_name:
            return None

        params = urlencode({"name": city_name, "count": 1, "language": "en", "format": "json"})
        url = f"https://geocoding-api.open-meteo.com/v1/search?{params}"
        request = Request(url, headers={"User-Agent": "VISIONARY-NEXUS/1.0"})
        with urlopen(request, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8"))

        results = data.get("results") or []
        if not results:
            return None

        place = results[0]
        return {
            "location": place.get("name", city_name),
            "region": place.get("admin1", ""),
            "country": place.get("country", ""),
            "latitude": float(place.get("latitude", 0)),
            "longitude": float(place.get("longitude", 0)),
        }

    def get_current(self, city: str):
        city_name = (city or "Bengaluru").strip() or "Bengaluru"

        if WEATHER_API_KEY:
            params = urlencode({
                "key": WEATHER_API_KEY,
                "q": city_name,
                "aqi": "no",
                "alerts": "no",
            })
            url = f"{WEATHER_BASE_URL}/v1/current.json?{params}"
            request = Request(url, headers={"User-Agent": "VISIONARY-NEXUS/1.0"})

            try:
                with urlopen(request, timeout=10) as response:
                    data = json.loads(response.read().decode("utf-8"))
            except HTTPError:
                data = {}
            except URLError:
                data = {}

            if data.get("current"):
                current = data.get("current", {})
                location = data.get("location", {})
                return {
                    "success": True,
                    "location": location.get("name", city_name),
                    "region": location.get("region", ""),
                    "country": location.get("country", ""),
                    "temperature_c": current.get("temp_c"),
                    "feels_like_c": current.get("feelslike_c"),
                    "humidity": current.get("humidity"),
                    "wind_kph": current.get("wind_kph"),
                    "condition": current.get("condition", {}).get("text", "Unknown"),
                    "condition_icon": current.get("condition", {}).get("icon"),
                    "last_updated": current.get("last_updated"),
                    "source": "weatherapi",
                    "forecast": [],
                }

        geocode = self._geo_lookup(city_name)
        if not geocode:
            return {"success": False, "message": f"Could not find weather for '{city_name}'."}

        params = urlencode({
            "latitude": geocode["latitude"],
            "longitude": geocode["longitude"],
            "current": "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code",
            "timezone": "auto",
            "forecast_days": 1,
        })
        url = f"https://api.open-meteo.com/v1/forecast?{params}"
        request = Request(url, headers={"User-Agent": "VISIONARY-NEXUS/1.0"})

        with urlopen(request, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8"))

        current = data.get("current", {})
        weather_code = current.get("weather_code", 0)
        return {
            "success": True,
            "location": geocode["location"],
            "region": geocode["region"],
            "country": geocode["country"],
            "temperature_c": current.get("temperature_2m"),
            "feels_like_c": current.get("apparent_temperature"),
            "humidity": current.get("relative_humidity_2m"),
            "wind_kph": current.get("wind_speed_10m"),
            "condition": self._weather_code_to_text(weather_code),
            "condition_icon": "",
            "last_updated": current.get("time"),
            "source": "open-meteo",
            "forecast": [],
        }

    def get_forecast(self, city: str):
        city_name = (city or "Bengaluru").strip() or "Bengaluru"

        if WEATHER_API_KEY:
            params = urlencode({"key": WEATHER_API_KEY, "q": city_name, "days": 3, "aqi": "no", "alerts": "no"})
            url = f"{WEATHER_BASE_URL}/v1/forecast.json?{params}"
            request = Request(url, headers={"User-Agent": "VISIONARY-NEXUS/1.0"})

            try:
                with urlopen(request, timeout=10) as response:
                    data = json.loads(response.read().decode("utf-8"))
            except HTTPError:
                data = {}
            except URLError:
                data = {}

            if data.get("forecast"):
                forecast = data.get("forecast", {}).get("forecastday", [])
                items = []
                for day in forecast:
                    day_data = day.get("day", {})
                    items.append({
                        "date": day.get("date", ""),
                        "condition": day_data.get("condition", {}).get("text", "Unknown"),
                        "temperature_c": day_data.get("avgtemp_c"),
                        "max_c": day_data.get("maxtemp_c"),
                        "min_c": day_data.get("mintemp_c"),
                        "rain_chance": day_data.get("daily_chance_of_rain"),
                    })

                current = self.get_current(city_name)
                current["forecast"] = items
                current["source"] = "weatherapi"
                return current

        geocode = self._geo_lookup(city_name)
        if not geocode:
            return {"success": False, "message": f"Could not find weather for '{city_name}'."}

        params = urlencode({
            "latitude": geocode["latitude"],
            "longitude": geocode["longitude"],
            "daily": "weather_code,temperature_2m_max,temperature_2m_min",
            "timezone": "auto",
            "forecast_days": 3,
        })
        url = f"https://api.open-meteo.com/v1/forecast?{params}"
        request = Request(url, headers={"User-Agent": "VISIONARY-NEXUS/1.0"})

        with urlopen(request, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8"))

        current = self.get_current(city_name)
        daily = data.get("daily", {})
        forecast = []
        items = list(zip(
            daily.get("time", []),
            daily.get("weather_code", []),
            daily.get("temperature_2m_max", []),
            daily.get("temperature_2m_min", []),
        ))
        for day_date, code, max_temp, min_temp in items:
            forecast.append({
                "date": day_date,
                "condition": self._weather_code_to_text(code),
                "temperature_c": round((max_temp + min_temp) / 2, 1) if max_temp is not None and min_temp is not None else None,
                "max_c": max_temp,
                "min_c": min_temp,
                "rain_chance": None,
            })

        current["forecast"] = forecast
        current["source"] = "open-meteo"
        return current


class WeatherService:
    def __init__(self, provider: BaseWeatherProvider | None = None):
        if provider is None:
            provider = MockWeatherProvider() if WEATHER_PROVIDER == "mock" else RealWeatherProvider()
        self.provider = provider

    def get_current(self, city: str):
        result = self.provider.get_current(city)
        if result.get("success") is False and WEATHER_PROVIDER == "mock":
            return MockWeatherProvider().get_current(city)
        return result

    def get_forecast(self, city: str):
        result = self.provider.get_forecast(city)
        if result.get("success") is False and WEATHER_PROVIDER == "mock":
            return MockWeatherProvider().get_forecast(city)
        return result


class BaseNavigationProvider:
    def search(self, destination: str, latitude: float | None = None, longitude: float | None = None):
        raise NotImplementedError

    def route(self, destination: str, latitude: float | None = None, longitude: float | None = None):
        raise NotImplementedError


class MockNavigationProvider(BaseNavigationProvider):
    def search(self, destination: str, latitude: float | None = None, longitude: float | None = None):
        place = (destination or "Bengaluru").strip() or "Bengaluru"
        return {
            "success": True,
            "destination": place,
            "destination_coordinates": {"latitude": 12.9716, "longitude": 77.5946},
            "distance_km": 4.2,
            "duration_minutes": 12,
            "steps": [{"instruction": f"Head toward {place}", "type": "depart", "modifier": "straight", "distance_meters": 4200}],
            "source": "mock",
        }

    def route(self, destination: str, latitude: float | None = None, longitude: float | None = None):
        return self.search(destination, latitude, longitude)


class RealNavigationProvider(BaseNavigationProvider):
    @staticmethod
    def _normalize_bangalore_alias(destination: str) -> str:
        text = (destination or "").strip()
        if not text:
            return ""

        normalized = re.sub(r"\s+", " ", text).strip()
        lowered = normalized.lower()
        if lowered in {"bengalore", "bangalore", "bengaluru"}:
            return "Bengaluru"
        if lowered in {"bengalore city", "bangalore city", "bengaluru city"}:
            return "Bengaluru"
        return normalized

    @staticmethod
    def _is_city_only_destination(destination: str) -> bool:
        text = (destination or "").strip()
        if not text:
            return False

        lowered = re.sub(r"\s+", " ", text).strip().lower()
        city_aliases = {
            "bengalore",
            "bangalore",
            "bengaluru",
            "bengalore city",
            "bangalore city",
            "bengaluru city",
        }
        return lowered in city_aliases

    @staticmethod
    def _rank_nominatim_result(place: dict, query: str) -> tuple[int, int, str]:
        place_type = (place.get("type") or "").lower()
        place_class = (place.get("class") or "").lower()
        display_name = (place.get("display_name") or "").lower()
        query_lower = (query or "").lower()

        city_like = place_class in {"boundary", "place"} and place_type in {"city", "town", "village", "administrative", "state", "country"}
        landmark_like = (
            any(keyword in place_type for keyword in ["airport", "railway", "station", "landmark", "monument", "museum", "harbour", "aerodrome", "historic", "palace"])
            or any(keyword in display_name for keyword in ["airport", "railway", "station", "landmark", "palace", "whitefield"])
        )
        street_like = (
            any(keyword in place_type for keyword in ["street", "road", "address", "house", "building", "residential"])
            or any(keyword in display_name for keyword in ["road", "street", "lane", "main"])
        )

        if city_like:
            category = 0
        elif landmark_like:
            category = 1
        elif street_like:
            category = 2
        else:
            category = 3

        exact_name_bonus = 0 if query_lower in display_name else 1
        return (category, exact_name_bonus, display_name)

    @staticmethod
    def _query_keyword_matches(place: dict, query: str) -> bool:
        query_lower = (query or "").lower()
        display_name = (place.get("display_name") or "").lower()
        keywords = [
            "airport", "palace", "whitefield", "railway", "station", "landmark",
            "market", "temple", "museum", "hospital", "school"
        ]
        for keyword in keywords:
            if keyword in query_lower and keyword in display_name:
                return True
        return False

    @staticmethod
    def _specific_place_priority(item: dict, query: str) -> tuple[int, int, str]:
        display_name = (item.get("display_name") or "").lower()
        query_lower = (query or "").lower()

        keyword_order = ["airport", "palace", "whitefield", "railway", "station", "landmark", "market", "temple", "museum", "hospital", "school"]
        keyword_index = 999
        for position, keyword in enumerate(keyword_order):
            if keyword in query_lower:
                if keyword in display_name:
                    keyword_index = position
                    break

        if keyword_index == 999:
            return (1, 0, display_name)

        return (0, keyword_index, display_name)

    @staticmethod
    def _is_place_specific_query(query: str) -> bool:
        query_lower = (query or "").lower()
        keywords = ["airport", "palace", "whitefield", "railway", "station", "landmark", "market", "temple", "museum", "hospital", "school"]
        return any(keyword in query_lower for keyword in keywords)

    def search(self, destination: str, latitude: float | None = None, longitude: float | None = None):
        if not destination:
            return {"success": False, "message": "Please provide a destination."}

        raw_query = (destination or "").strip()
        normalized_query = self._normalize_bangalore_alias(raw_query)
        city_only = self._is_city_only_destination(raw_query)
        geocode_query = normalized_query if city_only else raw_query

        params = urlencode({"q": geocode_query, "format": "jsonv2", "limit": 8 if city_only else 10})
        url = f"{NAVIGATION_BASE_URL}/search?{params}"
        request = Request(url, headers={"User-Agent": "VISIONARY-NEXUS/1.0"})
        with urlopen(request, timeout=10) as response:
            results = json.loads(response.read().decode("utf-8"))

        if not results:
            return {"success": False, "message": f"Could not find '{destination}'."}

        if city_only:
            ranked_results = sorted(results, key=lambda item: self._rank_nominatim_result(item, geocode_query))
            place = ranked_results[0]
        else:
            if self._is_place_specific_query(geocode_query):
                keyword_matches = [item for item in results if self._query_keyword_matches(item, geocode_query)]
                if keyword_matches:
                    place = sorted(keyword_matches, key=lambda item: self._specific_place_priority(item, geocode_query))[0]
                else:
                    ranked_results = sorted(results, key=lambda item: self._rank_nominatim_result(item, geocode_query))
                    place = ranked_results[0]
            else:
                ranked_results = sorted(results, key=lambda item: self._rank_nominatim_result(item, geocode_query))
                place = ranked_results[0]

        return {
            "success": True,
            "destination": place.get("display_name", destination),
            "destination_coordinates": {"latitude": float(place.get("lat", 0)), "longitude": float(place.get("lon", 0))},
            "source": "nominatim",
        }

    def route(self, destination: str, latitude: float | None = None, longitude: float | None = None):
        geocoded = self.search(destination, latitude, longitude)
        if not geocoded.get("success"):
            return geocoded

        coords = geocoded["destination_coordinates"]
        origin_lat = latitude if latitude is not None else 12.9716
        origin_lon = longitude if longitude is not None else 77.5946

        route_url = (
            "https://router.project-osrm.org/route/v1/driving/"
            f"{origin_lon},{origin_lat};{coords['longitude']},{coords['latitude']}"
            "?overview=false&steps=true"
        )
        route_request = Request(route_url, headers={"User-Agent": "VISIONARY-NEXUS/1.0"})
        with urlopen(route_request, timeout=15) as response:
            route_data = json.loads(response.read().decode("utf-8"))

        if route_data.get("code") != "Ok":
            return {"success": False, "message": "Could not calculate route."}

        route = route_data.get("routes", [{}])[0]
        return {
            "success": True,
            "destination": geocoded["destination"],
            "destination_coordinates": coords,
            "distance_km": round(route.get("distance", 0) / 1000, 2),
            "duration_minutes": round(route.get("duration", 0) / 60),
            "steps": [{
                "instruction": step.get("name") or "Continue",
                "type": step.get("maneuver", {}).get("type"),
                "modifier": step.get("maneuver", {}).get("modifier"),
                "distance_meters": round(step.get("distance", 0)),
            } for leg in route.get("legs", []) for step in leg.get("steps", [])],
            "source": "osrm",
        }


class NavigationService:
    def __init__(self, provider: BaseNavigationProvider | None = None):
        if provider is None:
            provider = MockNavigationProvider() if NAVIGATION_PROVIDER == "mock" else RealNavigationProvider()
        self.provider = provider

    def search(self, destination: str, latitude: float | None = None, longitude: float | None = None):
        return self.provider.search(destination, latitude, longitude)

    def route(self, destination: str, latitude: float | None = None, longitude: float | None = None):
        return self.provider.route(destination, latitude, longitude)


music_service = MusicService()
weather_service = WeatherService()
navigation_service = NavigationService()


groq = None

if GROQ_API_KEY:
    groq = Groq(
        api_key=GROQ_API_KEY
    )
else:
    print(
        "WARNING: GROQ_API_KEY is not configured."
    )


# =========================================================
# FASTAPI
# =========================================================

app = FastAPI(
    title="VISIONARY NEXUS API",
    version="7.0.0"
)


# =========================================================
# DEVICE LIFECYCLE ROUTES
# =========================================================
#
# Provisioning / registration / heartbeat live in backend/device_api.py.
# They are deliberately idempotent: one physical device == one row.

app.include_router(device_router)


# =========================================================
# CAMERA ROUTES
# =========================================================
#
# ESP32-CAM / webcam pipeline lives in backend/camera_api.py, backed by the
# camera/ package. The board is optional: these routes answer with useful JSON
# when nothing is connected, and never block startup.

app.include_router(camera_router)


# =========================================================
# VISION / ML ROUTES
# =========================================================
#
# Laptop-webcam object detection lives in backend/vision_api.py, backed by the
# ml/ package (Ultralytics YOLO). Additive only:
#
#   * one managed capture+inference worker is shared by every request
#   * JSON status/health/detections answer even when the ML extras, the camera
#     or the model are missing, so nothing here blocks startup
#   * raw webcam frames are served only when VISION_STREAM_TOKEN is configured
#     and presented - never to an unauthenticated client
#   * the worker is shut down (and the camera released) on app shutdown

app.include_router(vision_router)


def _shutdown_vision_worker() -> None:
    """Release the laptop webcam when the backend stops."""

    try:
        from backend.vision_api import shutdown_vision
    except ImportError:
        from vision_api import shutdown_vision

    shutdown_vision()


# Wrap the existing lifespan instead of registering a deprecated on_event
# handler, so whatever startup/shutdown the app already has keeps working.
from contextlib import asynccontextmanager as _asynccontextmanager

_original_lifespan = app.router.lifespan_context


@_asynccontextmanager
async def _lifespan_with_vision_cleanup(application):
    async with _original_lifespan(application):
        try:
            yield
        finally:
            _shutdown_vision_worker()


app.router.lifespan_context = _lifespan_with_vision_cleanup


# =========================================================
# CORS
# =========================================================

app.add_middleware(
    CORSMiddleware,

    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
        "http://localhost:8443",
        "http://127.0.0.1:8443",
    ],

    allow_credentials=True,

    allow_methods=["*"],

    allow_headers=["*"],
)


# =========================================================
# REQUEST MODELS
# =========================================================

class AskRequest(BaseModel):
    message: str
    conversation_id: int


class ConversationCreate(BaseModel):
    title: str = "New Chat"


class ConversationRoutingRequest(BaseModel):
    message: str
    conversation_id: int


class ConversationRename(BaseModel):
    title: str


class WakeRequest(BaseModel):
    phrase: str


class NavigationRequest(BaseModel):
    destination: str
    latitude: float
    longitude: float


# =========================================================
# APPLE MUSIC REQUEST
# =========================================================

class MusicSearchRequest(BaseModel):
    query: str


# =========================================================
# ROOT
# =========================================================

@app.get("/")
def root():

    return {
        "status": "online",

        "service":
            "VISIONARY NEXUS API",

        "version":
            "7.0.0",

        "features": [
            "Groq AI",
            "Weather",
            "Apple Music Search",
            "Music Previews",
            "Navigation",
            "SQLite",
            "Wake Word",
        ],
    }


# =========================================================
# HEALTH
# =========================================================

@app.get("/api/health")
def health():

    return {
        "status": "ok",

        "groq_configured":
            groq is not None,

        "weather_configured":
            bool(WEATHER_API_KEY),

        "music":
            "Apple iTunes Search API",

        "navigation":
            "OpenStreetMap + OSRM",

        "timestamp":
            datetime.utcnow().isoformat(),
    }


DEFAULT_APP_SETTINGS = {"wake_word": "Vision", "wake_word_sensitivity": "high", "wake_word_source": "auto"}


@app.get("/api/settings")
def get_app_settings():
    db: Session = SessionLocal()
    try:
        row = db.query(Setting).filter(Setting.user_id == "local_user").first()
        saved = json.loads(row.data) if row and row.data else {}
        return {**DEFAULT_APP_SETTINGS, **saved}
    except (ValueError, TypeError):
        return dict(DEFAULT_APP_SETTINGS)
    finally:
        db.close()


@app.put("/api/settings")
def update_app_settings(payload: dict[str, str]):
    wake_word = str(payload.get("wake_word", DEFAULT_APP_SETTINGS["wake_word"])).strip()
    sensitivity = str(payload.get("wake_word_sensitivity", DEFAULT_APP_SETTINGS["wake_word_sensitivity"])).lower().strip()
    source = str(payload.get("wake_word_source", DEFAULT_APP_SETTINGS["wake_word_source"])).lower().strip()
    if not wake_word or len(wake_word) > 100:
        from fastapi import HTTPException
        raise HTTPException(status_code=422, detail="Wake word must be between 1 and 100 characters.")
    if sensitivity not in {"low", "balanced", "high"}:
        from fastapi import HTTPException
        raise HTTPException(status_code=422, detail="Sensitivity must be low, balanced, or high.")
    if source not in {"auto", "laptop", "glasses"}:
        from fastapi import HTTPException
        raise HTTPException(status_code=422, detail="Wake-word source must be auto, laptop, or glasses.")

    db: Session = SessionLocal()
    try:
        row = db.query(Setting).filter(Setting.user_id == "local_user").first()
        current = json.loads(row.data) if row and row.data else {}
        current.update({"wake_word": wake_word, "wake_word_sensitivity": sensitivity, "wake_word_source": source})
        if row is None:
            row = Setting(user_id="local_user", data=json.dumps(current), updated_at=datetime.utcnow())
            db.add(row)
        else:
            row.data = json.dumps(current)
            row.updated_at = datetime.utcnow()
        db.commit()
        return {**DEFAULT_APP_SETTINGS, **current}
    finally:
        db.close()


# =========================================================
# GET CONVERSATIONS
# =========================================================

@app.get("/api/conversations")
def get_conversations():

    db: Session = SessionLocal()

    try:

        conversations = (
            db.query(Conversation)
            .filter(
                Conversation.user_id
                == "local_user"
            )
            .order_by(
                Conversation.created_at.asc()
            )
            .all()
        )

        return [
            {
                "id":
                    conversation.id,

                "title":
                    conversation.title,

                "created_at":
                    conversation.created_at,
            }

            for conversation
            in conversations
        ]

    except Exception as error:

        print(
            "Get conversations error:",
            str(error)
        )

        return []

    finally:

        db.close()


# =========================================================
# SEMANTIC CONVERSATION ROUTING
# =========================================================

@app.post("/api/conversations/route")
def route_conversation(request: ConversationRoutingRequest):
    """Use conversation context to decide whether a prompt belongs in this chat.

    Ambiguous or contextual follow-ups stay in the current conversation. Only
    a clearly unrelated subject should start a new chat.
    """
    message = (request.message or "").strip()
    if not message:
        return {"success": True, "decision": "continue", "reason": "empty_message"}

    if groq is None:
        # Fail safe: never split a conversation just because classification is unavailable.
        return {"success": True, "decision": "continue", "reason": "ai_unavailable"}

    db: Session = SessionLocal()
    try:
        conversation = (
            db.query(Conversation)
            .filter(
                Conversation.id == request.conversation_id,
                Conversation.user_id == "local_user",
            )
            .first()
        )
        if not conversation:
            return {"success": False, "decision": "continue", "reason": "conversation_not_found"}

        history = (
            db.query(Message)
            .filter(Message.conversation_id == conversation.id)
            .order_by(Message.created_at.desc())
            .limit(10)
            .all()
        )
        history.reverse()
        if not history:
            return {"success": True, "decision": "continue", "reason": "empty_conversation"}

        context = "\n".join(
            f"{item.role}: {item.content[:700]}" for item in history
        )
        completion = groq.chat.completions.create(
            model="openai/gpt-oss-20b",
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You decide whether a user's latest message belongs in the existing conversation or starts a genuinely new topic. "
                        "Return exactly one word: CONTINUE or NEW_CHAT.\n\n"
                        "Choose CONTINUE when the message refers to something discussed earlier, asks a follow-up, requests another detail, "
                        "uses pronouns such as he/she/they/it/his/her/that/this, or is plausibly related to the existing subject. "
                        "For example, after discussing Cristiano Ronaldo, 'what is his salary?' and 'is he the GOAT?' are CONTINUE. "
                        "Choose NEW_CHAT only when the message is clearly about a different, unrelated subject, such as asking for Bengaluru weather "
                        "after a conversation about Ronaldo. When uncertain, always choose CONTINUE. Do not judge based only on keyword mismatch."
                    ),
                },
                {
                    "role": "user",
                    "content": f"EXISTING CONVERSATION:\n{context}\n\nLATEST USER MESSAGE:\n{message}",
                },
            ],
            temperature=0,
            # This reasoning model needs more than a tiny output budget to emit its decision.
            max_completion_tokens=256,
        )
        result = (completion.choices[0].message.content or "").strip().upper()
        decision = "new_chat" if result.startswith("NEW_CHAT") else "continue"
        return {"success": True, "decision": decision, "reason": "semantic_context"}
    except Exception as error:
        print("Conversation routing error:", str(error))
        # Fail safe on API errors to prevent accidental tabs.
        return {"success": True, "decision": "continue", "reason": "routing_error"}
    finally:
        db.close()


# =========================================================
# CREATE CONVERSATION
# =========================================================

@app.post("/api/conversations")
def create_conversation(
    request: ConversationCreate
):

    db: Session = SessionLocal()

    try:

        title = request.title.strip()

        if not title:
            title = "New Chat"

        conversation = Conversation(
            title=title,
            user_id="local_user",
        )

        db.add(conversation)

        db.commit()

        db.refresh(conversation)

        return {
            "success": True,

            "id":
                conversation.id,

            "title":
                conversation.title,

            "created_at":
                conversation.created_at,
        }

    except Exception as error:

        db.rollback()

        print(
            "Create conversation error:",
            str(error)
        )

        return {
            "success": False,

            "message":
                "Failed to create conversation.",

            "error":
                str(error),
        }

    finally:

        db.close()


# =========================================================
# RENAME CONVERSATION
# =========================================================

@app.patch(
    "/api/conversations/{conversation_id}"
)
def rename_conversation(
    conversation_id: int,
    request: ConversationRename
):

    db: Session = SessionLocal()

    try:

        conversation = (
            db.query(Conversation)
            .filter(
                Conversation.id
                == conversation_id,

                Conversation.user_id
                == "local_user"
            )
            .first()
        )

        if not conversation:

            return {
                "success": False,

                "message":
                    "Conversation not found.",
            }

        title = request.title.strip()

        if not title:
            title = "New Chat"

        conversation.title = title[:60]

        db.commit()

        db.refresh(conversation)

        return {
            "success": True,

            "id":
                conversation.id,

            "title":
                conversation.title,
        }

    except Exception as error:

        db.rollback()

        return {
            "success": False,

            "message":
                "Failed to rename conversation.",

            "error":
                str(error),
        }

    finally:

        db.close()


# =========================================================
# DELETE CONVERSATION
# =========================================================

@app.delete(
    "/api/conversations/{conversation_id}"
)
def delete_conversation(
    conversation_id: int
):

    db: Session = SessionLocal()

    try:

        conversation = (
            db.query(Conversation)
            .filter(
                Conversation.id
                == conversation_id,

                Conversation.user_id
                == "local_user"
            )
            .first()
        )

        if not conversation:

            return {
                "success": False,

                "message":
                    "Conversation not found.",
            }

        db.query(Message).filter(
            Message.conversation_id
            == conversation_id
        ).delete(
            synchronize_session=False
        )

        db.delete(conversation)

        db.commit()

        return {
            "success": True,

            "message":
                "Conversation deleted.",

            "conversation_id":
                conversation_id,
        }

    except Exception as error:

        db.rollback()

        return {
            "success": False,

            "message":
                "Failed to delete conversation.",

            "error":
                str(error),
        }

    finally:

        db.close()


# =========================================================
# GET MESSAGES
# =========================================================

@app.get(
    "/api/conversations/{conversation_id}/messages"
)
def get_messages(
    conversation_id: int
):

    db: Session = SessionLocal()

    try:

        conversation = (
            db.query(Conversation)
            .filter(
                Conversation.id
                == conversation_id,

                Conversation.user_id
                == "local_user"
            )
            .first()
        )

        if not conversation:

            return {
                "messages": []
            }

        messages = (
            db.query(Message)
            .filter(
                Message.conversation_id
                == conversation_id
            )
            .order_by(
                Message.created_at.asc()
            )
            .all()
        )

        return {
            "messages": [
                {
                    "id":
                        message.id,

                    "role":
                        message.role,

                    "content":
                        message.content,

                    "created_at":
                        message.created_at,
                }

                for message
                in messages
            ]
        }

    except Exception as error:

        print(
            "Get messages error:",
            str(error)
        )

        return {
            "messages": []
        }

    finally:

        db.close()


# =========================================================
# WEATHER
# =========================================================

@app.get(
    "/api/weather/{city}"
)
def get_weather(
    city: str
):
    result = weather_service.get_current(city)
    if result.get("success"):
        return result

    return {
        "success": False,
        "message": result.get("message", "Could not get weather."),
        "error": result.get("error"),
    }


@app.get(
    "/api/weather/forecast/{city}"
)
def get_weather_forecast(
    city: str
):
    result = weather_service.get_forecast(city)
    if result.get("success"):
        return result

    return {
        "success": False,
        "message": result.get("message", "Could not get forecast."),
        "error": result.get("error"),
    }


# =========================================================
# NAVIGATION
# =========================================================

@app.post(
    "/api/navigation"
)
def navigation(
    request: NavigationRequest
):
    try:
        destination = (request.destination or "").strip()
        if not destination:
            return {"success": False, "message": "Please provide a destination."}

        result = navigation_service.route(
            destination,
            latitude=float(request.latitude),
            longitude=float(request.longitude),
        )

        if result.get("success"):
            return result

        return {
            "success": False,
            "message": result.get("message", "Navigation request failed."),
            "error": result.get("error"),
        }
    except Exception as error:
        return {
            "success": False,
            "message": "Navigation request failed.",
            "error": str(error),
        }


@app.post(
    "/api/navigation/search"
)
def navigation_search(payload: dict):
    destination = str(payload.get("destination", "")).strip()
    if not destination:
        return {"success": False, "message": "Please provide a destination."}

    return navigation_service.search(destination)


@app.get("/api/locations/recent")
def get_recent_locations(kind: str = "navigation"):
    db: Session = SessionLocal()
    try:
        rows = (
            db.query(RecentLocation)
            .filter(RecentLocation.user_id == "local_user", RecentLocation.kind == kind)
            .order_by(RecentLocation.created_at.desc())
            .limit(10)
            .all()
        )
        return {"success": True, "locations": [
            {"kind": row.kind, "query": row.query, "latitude": row.latitude,
             "longitude": row.longitude, "created_at": row.created_at.isoformat() if row.created_at else ""}
            for row in rows
        ]}
    except Exception as error:
        return {"success": False, "locations": [], "message": str(error)}
    finally:
        db.close()

@app.post(
    "/api/navigation/route"
)
def navigation_route(payload: dict):
    destination = str(payload.get("destination", "")).strip()
    latitude = payload.get("latitude")
    longitude = payload.get("longitude")
    if not destination:
        return {"success": False, "message": "Please provide a destination."}

    try:
        lat = float(latitude) if latitude is not None else None
        lon = float(longitude) if longitude is not None else None
    except (TypeError, ValueError):
        lat = None
        lon = None

    result = navigation_service.route(destination, latitude=lat, longitude=lon)
    if result.get("success"):
        db: Session = SessionLocal()
        try:
            db.add(RecentLocation(
                user_id="local_user", kind="navigation", query=destination,
                latitude=str(lat) if lat is not None else None,
                longitude=str(lon) if lon is not None else None,
            ))
            db.commit()
        except Exception:
            db.rollback()
        finally:
            db.close()
    return result


@app.get(
    "/api/navigation/recent"
)
def navigation_recent():
    return {
        "success": True,
        "items": [],
        "message": "No recent destinations yet.",
    }


# =========================================================
# MUSIC HELPERS
# =========================================================

def normalize_music_text(
    value: str
) -> str:

    return (
        value
        .lower()
        .replace("&", " and ")
        .replace("'", "")
        .replace('"', "")
    )


def music_score(
    query: str,
    track_name: str,
    artist_name: str,
    album_name: str
) -> int:

    q = normalize_music_text(
        query
    ).strip()

    title = normalize_music_text(
        track_name
    ).strip()

    artist = normalize_music_text(
        artist_name
    ).strip()

    album = normalize_music_text(
        album_name
    ).strip()

    if not q or not title:
        return 0

    score = 0

    # Exact title
    if title == q:
        score += 500

    # Exact artist
    if artist == q:
        score += 250

    # Title contains query
    if q in title:
        score += 200

    # Query contains title
    if title in q:
        score += 150

    # Album
    if q in album:
        score += 50

    query_words = [
        word
        for word in re.split(
            r"\s+",
            q
        )
        if len(word) > 1
    ]

    title_words = set(
        re.split(
            r"\s+",
            title
        )
    )

    artist_words = set(
        re.split(
            r"\s+",
            artist
        )
    )

    for word in query_words:

        if word in title_words:
            score += 40

        if word in artist_words:
            score += 20

    return score


# =========================================================
# MUSIC CONFIG
# =========================================================

@app.get("/api/music/playlists")
def get_music_playlists():
    """Return persisted playlists and their ordered tracks for the local app user."""
    db = SessionLocal()
    try:
        rows = db.query(MusicPlaylist).filter(
            MusicPlaylist.user_id == "local_user"
        ).order_by(MusicPlaylist.created_at.asc(), MusicPlaylist.id.asc()).all()
        items = []
        for row in rows:
            try:
                tracks = json.loads(row.tracks_json or "[]")
            except (TypeError, json.JSONDecodeError):
                tracks = []
            items.append({"name": row.name, "tracks": tracks})
        return {"success": True, "playlists": items}
    finally:
        db.close()


@app.put("/api/music/playlists")
def save_music_playlists(request: dict):
    """Persist the complete playlist collection without mixing it with playback queue state."""
    incoming = request.get("playlists")
    if not isinstance(incoming, list):
        return {"success": False, "message": "Expected a playlists array."}

    normalized = []
    seen_names = set()
    for item in incoming:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        tracks = item.get("tracks")
        if not name or not isinstance(tracks, list):
            continue
        key = name.casefold()
        if key in seen_names:
            return {"success": False, "message": f"Duplicate playlist name: {name}"}
        seen_names.add(key)
        safe_tracks = [track for track in tracks if isinstance(track, dict)]
        normalized.append((name[:160], safe_tracks))

    db = SessionLocal()
    try:
        existing = db.query(MusicPlaylist).filter(
            MusicPlaylist.user_id == "local_user"
        ).all()
        by_name = {row.name.casefold(): row for row in existing}
        keep_ids = set()
        for name, tracks in normalized:
            row = by_name.get(name.casefold())
            if row is None:
                row = MusicPlaylist(user_id="local_user", name=name, tracks_json="[]")
                db.add(row)
            row.name = name
            row.tracks_json = json.dumps(tracks, ensure_ascii=False)
            row.updated_at = datetime.utcnow()
            db.flush()
            keep_ids.add(row.id)
        for row in existing:
            if row.id not in keep_ids:
                db.delete(row)
        db.commit()
        return {"success": True, "count": len(normalized)}
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


@app.get("/api/music/config")
def music_provider_config():
    navidrome_configured = bool(NAVIDROME_ENABLED and NAVIDROME_URL and NAVIDROME_USERNAME and NAVIDROME_PASSWORD)
    youtube_configured = bool(YOUTUBE_API_KEY)
    itunes_available = bool(APPLE_MUSIC_BASE_URL) and APPLE_MUSIC_PROVIDER != "mock"
    audius_available = not navidrome_configured and not youtube_configured and APPLE_MUSIC_PROVIDER != "mock"
    configured = navidrome_configured or youtube_configured or itunes_available or audius_available
    provider = "navidrome" if navidrome_configured else "youtube" if youtube_configured else "audius" if audius_available else "apple-itunes" if itunes_available else "none"
    return {
        "success": configured,
        "provider": provider,
        "configured": configured,
        "requiresApiKey": False if audius_available else not configured,
        "message": "Navidrome is configured." if navidrome_configured else "YouTube music is configured." if youtube_configured else "Free Audius search and full-track streaming are ready; some mainstream songs may not be in its catalogue." if audius_available else "Apple catalogue search is ready; playback uses short previews where available." if itunes_available else "No music provider is configured.",
        "apiKeyConfigured": youtube_configured or navidrome_configured,
    }


# =========================================================
# MUSIC SEARCH / PLAYBACK ROUTES
# =========================================================

@app.post(
    "/api/music/play"
)
def music_play(request: MusicSearchRequest):
    query = (request.query or "").strip()
    if not query:
        return {"success": False, "message": "Music search query is empty.", "tracks": []}
    return music_service.play(query)


@app.post(
    "/api/music/pause"
)
def music_pause():
    return music_service.pause()


@app.post(
    "/api/music/resume"
)
def music_resume():
    return music_service.resume()


@app.post(
    "/api/music/next"
)
def music_next():
    return music_service.next()


@app.post(
    "/api/music/previous"
)
def music_previous():
    return music_service.previous()


def correct_music_search_query(query: str) -> str:
    """Correct likely song/artist spelling mistakes without inventing a different request."""
    if groq is None or not query.strip():
        return query.strip()
    try:
        completion = groq.chat.completions.create(
            model="openai/gpt-oss-20b",
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are correcting a possibly phonetic or badly misspelled song title/artist query. "
                        "Infer the most likely intended real song or artist, correcting spelling aggressively when the sound is clear. "
                        "Reply with only the corrected search phrase, no explanation and no quotes. "
                        "Do not append generic words or invent an unrelated song. "
                        "If no plausible correction can be inferred, repeat the original phrase exactly."
                    ),
                },
                {"role": "user", "content": query},
            ],
            temperature=0,
            max_completion_tokens=256,
        )
        corrected = (completion.choices[0].message.content or "").strip().strip('"').strip("'")
        if corrected and len(corrected) <= max(160, len(query) * 3):
            return corrected
    except Exception as error:
        print("Music query correction error:", str(error))
    return query.strip()


@app.post(
    "/api/music/search"
)
def music_search(
    request: MusicSearchRequest
):
    query = (request.query or "").strip()

    if not query:
        return {
            "success": False,
            "message": "Music search query is empty.",
            "tracks": [],
        }

    # Keep search on the critical playback path deterministic and fast.
    # Never block a music search on a remote LLM spelling-correction request;
    # the original query is preserved for the catalogue provider.
    search_query = query
    result = music_service.search(search_query)

    # Short YouTube clips/Shorts are not suitable results when the user asked
    # to play a song. Prefer normal-length tracks; if needed, retry a full-song
    # query rather than returning a 15–30 second clip as the best match.
    if result.get("success") and result.get("tracks"):
        tracks = result["tracks"]
        if result.get("source") == "youtube":
            full_tracks = [
                track for track in tracks
                if not track.get("duration") or int(track.get("duration") or 0) >= 60000
            ]
            if not full_tracks:
                retry_query = f"{search_query} official audio full song"
                retry_result = music_service.search(retry_query)
                retry_tracks = retry_result.get("tracks") or []
                full_tracks = [
                    track for track in retry_tracks
                    if not track.get("duration") or int(track.get("duration") or 0) >= 60000
                ]
                if full_tracks:
                    result = retry_result
                    result["query"] = search_query
            if full_tracks:
                result["tracks"] = full_tracks
                result["success"] = True
            else:
                result["tracks"] = []
                result["success"] = False
                result["message"] = "I found only very short clips. Try the song title plus the artist name."

    # If correction didn't help, preserve the original query as a fallback.
    if not result.get("success") and search_query.casefold() != query.casefold():
        original_result = music_service.search(query)
        if original_result.get("success") and original_result.get("tracks"):
            result = original_result
            search_query = query

    # "montegam elder itis" is too ambiguous to identify a specific song safely.
    # Offer related Audius results for the likely word "montagem", but mark them
    # as suggestions so the frontend does not accidentally play the wrong track.
    if (
        not result.get("success")
        and isinstance(music_service.provider, AudiusMusicProvider)
        and re.search(r"\bmontegam\b", query, re.IGNORECASE)
    ):
        suggestions = music_service.search("montagem")
        suggestion_tracks = suggestions.get("tracks") or []
        # Keep fallback suggestions tied to the corrected term; do not show
        # unrelated tracks merely because the provider returned some results.
        relevant_suggestions = [
            track for track in suggestion_tracks
            if re.search(
                r"\bmontagem\b|\bmontegam\b",
                f"{track.get('name') or ''} {track.get('artist') or ''}",
                re.IGNORECASE,
            )
        ]
        suggestions["tracks"] = relevant_suggestions
        suggestions["success"] = bool(relevant_suggestions)
        if relevant_suggestions:
            suggestions["needs_confirmation"] = True
            suggestions["original_query"] = query
            suggestions["corrected_query"] = "montagem"
            suggestions["notice"] = (
                "I couldn't confidently identify the full song title. "
                "These are related Montagem tracks; choose the exact title before playback."
            )
            return suggestions

    if result.get("success"):
        result["original_query"] = query
        result["corrected_query"] = search_query
        if search_query.casefold() != query.casefold():
            result["notice"] = f"Search corrected to: {search_query}"
        return result

    return {
        "success": False,
        "query": query,
        "corrected_query": search_query,
        "tracks": [],
        "source": getattr(music_service.provider, "__class__", type(music_service.provider)).__name__,
        "message": result.get("message") or "No music results were returned for that query.",
    }


# =========================================================
# WAKE WORD
# =========================================================

@app.post(
    "/api/wake"
)
def wake(
    request: WakeRequest
):

    phrase = (
        request.phrase
        .strip()
        .lower()
    )

    # Read the persisted custom phrase rather than a hard-coded allowlist.
    db: Session = SessionLocal()
    try:
        row = db.query(Setting).filter(Setting.user_id == "local_user").first()
        saved = json.loads(row.data) if row and row.data else {}
        configured = str(saved.get("wake_word", DEFAULT_APP_SETTINGS["wake_word"])).strip()
    except (ValueError, TypeError):
        configured = DEFAULT_APP_SETTINGS["wake_word"]
    finally:
        db.close()

    import re
    normalized_phrase = " ".join(re.sub(r"[^\w\s]", " ", phrase).split())
    normalized_wake = " ".join(re.sub(r"[^\w\s]", " ", configured.lower()).split())
    padded_phrase = f" {normalized_phrase} "
    detected = bool(normalized_wake) and f" {normalized_wake} " in padded_phrase

    return {"detected": detected, "phrase": request.phrase, "wake_word": configured}


# =========================================================
# AI TITLE GENERATOR
# =========================================================

def generate_ai_title(
    message: str
) -> str:

    if groq is None:
        return "New Chat"

    try:

        completion = (
            groq.chat.completions.create(

                model=
                    "openai/gpt-oss-20b",

                messages=[

                    {
                        "role":
                            "system",

                        "content":
                            """
Create a short, useful title for the conversation using the conversation context below.
Capture its main topic, not a verbatim copy of the latest prompt. Consider the
earlier messages and latest exchange together.

Rules:

- 2 to 4 words
- Maximum 30 characters
- Return ONLY the title
- No quotation marks
- No punctuation
- Do not use the word Chat
- Do not copy the user's sentence

Examples:

Weather in Bengaluru
-> Bengaluru Weather

Teach Python loops
-> Python Loops

Explain binomial surds
-> Binomial Surds

ESP32 camera problem
-> ESP32 Camera Issue

Smart glasses project
-> Smart Glasses Project
"""
                    },

                    {
                        "role":
                            "user",

                        "content":
                            message
                    }
                ],

                temperature=
                    0.3,

                # Reasoning models may consume most of a tiny token budget
                # before producing the actual title. Leave room for the answer.
                max_completion_tokens=
                    256
            )
        )

        title = (
            completion
            .choices[0]
            .message
            .content
        )

        if not title:
            return "New Chat"

        title = (
            title
            .strip()
            .replace('"', "")
            .replace("'", "")
            .replace("\n", " ")
            .replace("\r", " ")
            .strip()
        )

        title = title.rstrip(
            ".?!,:;-"
        ).strip()

        if len(title) > 30:

            title = (
                title[:30]
                .rsplit(
                    " ",
                    1
                )[0]
            )

        return title or "New Chat"

    except Exception as error:

        print(
            "AI title error:",
            str(error)
        )

        return "New Chat"


# =========================================================
# AI-BASED FEATURE INTENT ROUTER
# =========================================================
@app.post("/api/intent/classify")
def classify_feature_intent(request: dict):
    message = str(request.get("message") or "").strip()
    context = request.get("context") if isinstance(request.get("context"), dict) else {}
    active_tab = str(context.get("active_tab") or "").strip().lower()
    if not message:
        return {"intent": "general", "action": "none", "destination": "", "query": "", "polished_text": ""}
    normalized_fallback = " ".join(message.lower().split())
    if re.search(r"\b(?:listen to|hear)\s+(?:something|anything|some music|music|a song|some songs)\b", normalized_fallback):
        return {"intent": "music", "action": "open", "destination": "", "query": "", "polished_text": message}
    if any(phrase in normalized_fallback for phrase in (
        "listen to it", "listen to that", "listen to this", "hear it", "hear that",
        "hear this", "play that again", "put that on", "play it again",
    )):
        return {"intent": "music", "action": "resume", "destination": "", "query": "", "polished_text": message}
    if groq is None:
        return {"intent": "general", "action": "none", "destination": "", "query": message, "polished_text": message}

    try:
        completion = groq.chat.completions.create(
            model="openai/gpt-oss-20b",
            messages=[
                {
                    "role": "system",
                    "content": """
You are the natural-language understanding engine for Visionary Nexus smart glasses. Interpret what the user MEANS, not just exact command wording. People speak in fragments, polite requests, long sentences, and pronouns.
Return JSON only:
{"intent":"music|weather|navigation|vision|audio|dashboard|ai|notifications|device|settings|general","action":"play|pause|resume|next|previous|search|open|none","destination":"string","query":"string","polished_text":"string"}.

Rules:
- MUSIC: any request to listen to, put on, play, resume, find, or search for music, a song, artist, genre, or playlist. "I want to listen to phonk", "could you put my phonk on", and "play phonk" all mean music action=play, query="phonk". Strip filler like "some music", "a song", "please play", and generic words such as "playlist"/"song"/"music" when they are not part of the actual title. Preserve real titles. A question asking what a genre or artist means is general, not music playback.
- HARD RULE: "I want to listen to it", "let me listen to it", "I want to hear it", "play that again", or "put that on" are music intents when referring to music/playback. Return intent=music, action=resume or play, query="". Never send these to general/AI merely because the target is a pronoun. If context.active_tab is music, resolve "it/that" to the current song or selected playlist.
- Music controls: pause/stop => pause; continue/resume => resume; skip/next => next; previous/back => previous.
- Use supplied context.active_tab as conversation context, not as an absolute rule. When a pronoun such as "it/that one" refers to the current playback and active_tab is music, choose music and the relevant playback action.
- WEATHER: requests about current weather, rain, temperature, or forecasts. query is the requested location or subject.
- NAVIGATION: only when the user wants directions or a route. Extract destination, never invent it.
- VISION: asks what they are looking at, identify an object, or describe a scene.
- AUDIO, DASHBOARD, NOTIFICATIONS, DEVICE, SETTINGS: choose when the user wants that feature opened or controlled.
- AI: only when explicitly asking to open the AI assistant. Ordinary questions such as "what is 2 plus 2?" and "what is AI?" must be general.
- GENERAL: calculations, explanations, and normal questions. Preserve the user's full meaning in polished_text.
- Do not use exact phrase matching as the deciding rule. "I want to listen to" is a music intent even if it does not begin with "play".
- polished_text: rewrite the complete utterance in clear, natural English, correcting speech-recognition errors and grammar without changing meaning, removing details, shortening long prompts, or answering the request. For a voice command, retain the user's intended command as a concise natural sentence.
- Formatting is an AI decision: keep a simple question or ordinary thought as a paragraph. Use bullets only when the user has several distinct requirements, requested items, steps, or points that are genuinely easier to scan as a list. Do not force bullets onto every message.
- For multi-part prompts, preserve every requirement and example; prefer clear bullets when they improve readability. Do not summarize long prompts or omit repeated details that may be meaningful.
- query should contain only the music target or requested destination/subject, not the full command. For general intent, query and polished_text should preserve the complete user request.
- Never hallucinate missing names or targets. If unsure, choose general unless the speech clearly expresses a feature intent.
""".strip(),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {"message": message, "context": {"active_tab": active_tab}},
                        ensure_ascii=False,
                    ),
                },
            ],
            temperature=0,
            # Allow enough output for the complete polished version of long prompts.
            max_completion_tokens=min(6000, max(1200, len(message) // 2)),
            response_format={"type": "json_object"},
        )
        parsed = json.loads(completion.choices[0].message.content or "{}")
        allowed = {"music", "weather", "navigation", "vision", "audio", "dashboard", "ai", "notifications", "device", "settings", "general"}
        actions = {"play", "pause", "resume", "next", "previous", "search", "open", "none"}
        intent = str(parsed.get("intent") or "general").lower()
        if intent not in allowed:
            intent = "general"
        action = str(parsed.get("action") or "none").lower()
        if action not in actions:
            action = "none"
        destination = str(parsed.get("destination") or "").strip()
        query = str(parsed.get("query") or "").strip()
        polished_text = str(parsed.get("polished_text") or message).strip()

        # Resolve generic listening requests as navigation, not an accidental
        # search for the literal word "something" or an unintended autoplay.
        normalized_voice_request = " ".join(message.lower().split())
        generic_listen_request = bool(re.search(
            r"\b(?:i want to|i would like to|let me|can i|could i)?\s*(?:listen to|hear)\s+(?:something|anything|some music|music|a song|some songs)\b",
            normalized_voice_request,
        ))
        if generic_listen_request:
            intent = "music"
            action = "open"
            query = ""

        # Context-dependent pronouns are music actions when the utterance
        # explicitly asks to listen/hear/play; the Music UI resolves the
        # reference to current playback or the selected saved playlist.
        pronoun_playback_reference = any(phrase in normalized_voice_request for phrase in (
            "listen to it", "listen to that", "listen to this",
            "hear it", "hear that", "hear this", "play that again",
            "put that on", "play it again",
        ))
        if pronoun_playback_reference:
            intent = "music"
            action = "resume"
            query = ""

        if intent == "navigation" and not destination:
            intent = "general"
        return {
            "intent": intent,
            "action": action,
            "destination": destination,
            "query": query,
            "polished_text": polished_text,
        }
    except Exception as error:
        print("Feature intent classification error:", str(error))
        # Preserve the essential playback reference even if the AI provider
        # temporarily fails to return valid structured JSON.
        normalized_voice_request = " ".join(message.lower().split())
        if any(phrase in normalized_voice_request for phrase in (
            "listen to it", "listen to that", "listen to this",
            "hear it", "hear that", "hear this", "play that again",
        )):
            return {
                "intent": "music",
                "action": "resume",
                "destination": "",
                "query": "",
                "polished_text": "Resume the current music.",
            }

    return {"intent": "general", "action": "none", "destination": "", "query": message, "polished_text": message}


@app.post("/api/dictation/polish")
def polish_dictation(request: dict):
    raw_text = str(request.get("text") or "")
    language = str(request.get("language") or "auto").strip()
    if not raw_text.strip():
        return {"success": True, "polished_text": ""}
    # Keep long dictated prompts intact; do not silently truncate them.
    if groq is None:
        return {"success": True, "polished_text": raw_text.strip(), "fallback": True}
    if language.lower() in {"auto", "", "detect"}:
        language_instruction = "Detect the language from the transcript and keep the corrected text in that same language and script."
    else:
        language_instruction = f"The selected speech language is {language}. Keep the corrected text in that language and script; do not translate it into English."
    try:
        completion = groq.chat.completions.create(
            model="openai/gpt-oss-20b",
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a careful multilingual dictation editor. " + language_instruction + " "
                        "Rewrite the user's entire speech transcript as clear, polished, natural writing in the same language. "
                        "Correct grammar, punctuation, capitalization, and obvious speech-recognition errors. Remove only filler or repetitions that clearly add no meaning. "
                        "Preserve every detail, requirement, example, name, technical term, intent, tone, and the full meaning of the original. "
                        "Never summarize or shorten a long transcript, and never invent missing words or instructions. "
                        "Choose formatting intelligently: keep simple thoughts as paragraphs; use bullets only when the speaker clearly lists multiple distinct points, requirements, or steps and bullets improve readability. Do not force a list when it is not needed. "
                        "If uncertain whether a phrase is a recognition error or meaningful content, preserve it rather than deleting it. "
                        "If the input is already clear, make minimal corrections. Return only the corrected text, without quotes or commentary."
                    ),
                },
                {"role": "user", "content": raw_text},
            ],
            temperature=0,
            max_completion_tokens=min(6000, max(500, len(raw_text) // 2)),
        )
        polished = (completion.choices[0].message.content or "").strip()
        # A surprisingly short result often means the model dropped dictated details.
        # Preserve the original rather than silently losing part of the user's request.
        if len(raw_text.strip()) >= 180 and len(polished) < len(raw_text.strip()) * 0.72:
            return {"success": True, "polished_text": raw_text.strip(), "fallback": True, "reason": "possible_omission"}
        return {"success": bool(polished), "polished_text": polished or raw_text.strip()}
    except Exception as error:
        print("Dictation polish error:", str(error))
        return {"success": True, "polished_text": raw_text.strip(), "fallback": True}


# =========================================================
# COMMAND CLASSIFICATION
# =========================================================

def classify_user_command(message: str) -> dict:
    raw_text = (message or "").strip()
    text = re.sub(r"[^a-z0-9\s\+\-]", " ", raw_text.lower())
    text = re.sub(r"\s+", " ", text).strip()

    if not text:
        return {"intent": "general", "query": ""}

    music_play_match = re.match(
        r"^(?:play|play song|play the song|play music|play track|listen to)\s+(?:the\s+)?(.+)$",
        raw_text,
        re.IGNORECASE,
    )
    if music_play_match:
        query = music_play_match.group(1).strip()
        return {"intent": "music_play", "query": query}

    music_search_match = re.match(
        r"^(?:search for|find|look for|look up|search)\s+(?:the\s+)?(.+)$",
        raw_text,
        re.IGNORECASE,
    )
    if music_search_match:
        query = music_search_match.group(1).strip()
        if query and not any(keyword in query.lower() for keyword in ["weather", "forecast", "navigate", "directions", "route"]):
            return {"intent": "music_search", "query": query}

    if text in {"pause music", "stop music", "pause", "stop"} or re.match(r"^(?:pause|stop)\s*(?:music)?$", text):
        return {"intent": "music_pause", "query": ""}

    if text in {"resume music", "continue music", "resume"} or re.match(r"^(?:resume|continue)\s*(?:music)?$", text):
        return {"intent": "music_resume", "query": ""}

    if text in {"next song", "next track", "next", "skip", "skip song"} or re.match(r"^(?:next|skip)\s*(?:song|track)?$", text):
        return {"intent": "music_next", "query": ""}

    if text in {"previous song", "previous track", "previous", "last song"} or re.match(r"^(?:previous|last)\s*(?:song|track)?$", text):
        return {"intent": "music_previous", "query": ""}

    weather_match = re.search(r"\b(?:weather|temperature|forecast)\b", text)
    if weather_match:
        city_match = re.search(r"(?:weather|temperature|forecast)\s+(?:in|at|for)\s+(.+)$", raw_text, re.IGNORECASE)
        if city_match:
            city = city_match.group(1).strip()
        else:
            city = ""

        if "tomorrow" in text or "today" in text or "forecast" in text or re.search(r"weather\s+(?:tomorrow|today)", text):
            intent = "weather_forecast"
        else:
            intent = "weather"
        return {"intent": intent, "city": city, "query": city or text}

    navigation_match = re.search(r"\b(?:navigate|navigation|directions|route|take me to|how do i get to|how can i get to|find directions to)\b", text)
    if navigation_match:
        destination = ""
        for pattern in [
            r"^(?:navigate|navigation|route)\s+(?:to\s+)?(.+)$",
            r"^(?:directions to|find directions to|take me to|how do i get to|how can i get to)\s+(.+)$",
        ]:
            match = re.match(pattern, raw_text, re.IGNORECASE)
            if match:
                destination = match.group(1).strip()
                break
        if not destination:
            destination = raw_text
        return {"intent": "navigation", "destination": destination}

    return {"intent": "general", "query": raw_text}


# =========================================================
# ASK AI
# =========================================================

@app.post(
    "/api/ask"
)
def ask(
    request: AskRequest
):

    message = (
        request.message
        .strip()
    )

    if not message:

        return {

            "response":
                "Please enter a command.",

            "source":
                "FastAPI",
        }

    classification = classify_user_command(message)
    intent = classification.get("intent", "general")

    if intent == "music_play":
        result = music_service.play(classification.get("query", message))
        return {
            "response": result.get("message", "I couldn't play that song."),
            "source": "Music",
            "intent": intent,
            "result": result,
        }

    if intent == "music_search":
        result = music_service.search(classification.get("query", message))
        return {
            "response": (
                f"I found {len(result.get('tracks', []))} music matches for '{classification.get('query', message)}'."
                if result.get("tracks")
                else f"I couldn't find any matches for '{classification.get('query', message)}'."
            ),
            "source": "Music",
            "intent": intent,
            "result": result,
        }

    if intent == "music_pause":
        return {"response": music_service.pause().get("message", "Music paused."), "source": "Music", "intent": intent}

    if intent == "music_resume":
        return {"response": music_service.resume().get("message", "Music resumed."), "source": "Music", "intent": intent}

    if intent == "music_next":
        return {"response": music_service.next().get("message", "Playing the next song."), "source": "Music", "intent": intent}

    if intent == "music_previous":
        return {"response": music_service.previous().get("message", "Playing the previous song."), "source": "Music", "intent": intent}

    if intent in {"weather", "weather_forecast"}:
        city = classification.get("city") or classification.get("query") or "Bengaluru"
        if intent == "weather_forecast":
            result = weather_service.get_forecast(city)
            if result.get("success"):
                forecast = result.get("forecast") or []
                first_forecast = forecast[0] if forecast else {}
                response = (
                    f"Weather forecast for {result.get('location', city)}: "
                    f"{result.get('condition', 'Unknown')} with a high of {first_forecast.get('max_c', result.get('temperature_c', 'unknown'))}°C."
                    if forecast
                    else f"Forecast for {city} is not available right now."
                )
            else:
                response = result.get("message", "I couldn't get a forecast for that location.")
            return {"response": response, "source": "Weather", "intent": intent, "result": result}

        result = weather_service.get_current(city)
        if result.get("success"):
            response = (
                f"Weather in {result.get('location', city)}: {result.get('condition', 'Unknown')} at {result.get('temperature_c', 'unknown')}°C. "
                f"Feels like {result.get('feels_like_c', 'unknown')}°C with {result.get('humidity', 'unknown')}% humidity."
            )
        else:
            response = result.get("message", "I couldn't get the weather for that location.")
        return {"response": response, "source": "Weather", "intent": intent, "result": result}

    if intent == "navigation":
        destination = classification.get("destination") or message
        result = navigation_service.route(destination, latitude=12.9716, longitude=77.5946)
        if result.get("success"):
            response = (
                f"Route to {result.get('destination', destination)}: "
                f"{result.get('distance_km', 'unknown')} km in about {result.get('duration_minutes', 'unknown')} minutes."
            )
        else:
            response = result.get("message", "I couldn't find a route to that destination.")
        return {"response": response, "source": "Navigation", "intent": intent, "result": result}

    if groq is None:

        return {

            "response":
                (
                    "Groq is not configured. "
                    "Check GROQ_API_KEY in .env."
                ),

            "source":
                "FastAPI",
        }

    db: Session = SessionLocal()

    try:

        conversation = (
            db.query(Conversation)
            .filter(

                Conversation.id
                == request.conversation_id,

                Conversation.user_id
                == "local_user"
            )
            .first()
        )

        if not conversation:

            return {

                "response":
                    "Conversation not found.",

                "source":
                    "FastAPI",
            }

        message_count = (
            db.query(Message)
            .filter(
                Message.conversation_id
                == conversation.id
            )
            .count()
        )

        first_message = (
            message_count == 0
        )

        user_message = Message(

            conversation_id=
                conversation.id,

            user_id=
                "local_user",

            role=
                "user",

            content=
                message,
        )

        db.add(
            user_message
        )

        db.commit()

        history = (
            db.query(Message)
            .filter(
                Message.conversation_id
                == conversation.id
            )
            .order_by(
                Message.created_at.asc()
            )
            .all()
        )

        messages = [
            {
                "role": "system",
                "content": (
                    "You are Visionary Nexus, a precise and helpful assistant. "
                    "Answer the user's actual request. When the user asks to paraphrase, polish, rewrite, or improve a paragraph, "
                    "rewrite the complete text while preserving all facts, examples, names, requirements, nuance, and approximate length; "
                    "do not summarize or omit details. For ordinary questions, answer normally rather than paraphrasing the question. "
                    "Choose formatting based on the content: use a short paragraph for a simple idea, numbered steps for sequences, "
                    "and bullet points when there are multiple distinct items, options, requirements, or takeaways. Do not force bullets "
                    "when prose is clearer. Use headings only when they help scanning. Keep answers well structured and avoid unnecessary filler."
                ),
            },
            *[
                {
                    "role": item.role,
                    "content": item.content,
                }
                for item in history
            ],
        ]

        completion = (
            groq.chat.completions.create(

                model=
                    "openai/gpt-oss-20b",

                messages=
                    messages,

                temperature=
                    0.7,

                max_completion_tokens=
                    1024
            )
        )

        response = (
            completion
            .choices[0]
            .message
            .content
        )

        if not response:

            response = (
                "I did not receive a response."
            )

        response = response.strip()

        assistant_message = Message(

            conversation_id=
                conversation.id,

            user_id=
                "local_user",

            role=
                "assistant",

            content=
                response,
        )

        db.add(
            assistant_message
        )

        db.commit()

        # Refresh the AI-generated title as the conversation develops,
        # using recent user prompts and assistant replies instead of only
        # copying or titling from the first prompt.
        recent_messages = (
            db.query(Message)
            .filter(
                Message.conversation_id == conversation.id
            )
            .order_by(Message.created_at.desc())
            .limit(8)
            .all()
        )
        recent_messages.reverse()

        title_context = "\n".join(
            f"{item.role}: {item.content[:500]}"
            for item in recent_messages
        )

        generated_title = generate_ai_title(title_context)
        conversation_title = None

        if (
            generated_title
            and generated_title != "New Chat"
            and generated_title != conversation.title
        ):
            conversation.title = generated_title[:60]
            db.commit()
            db.refresh(conversation)
            conversation_title = conversation.title

        return {

            "response":
                response,

            "source":
                "Groq",

            "conversation_id":
                conversation.id,

            "conversation_title":
                conversation_title,
        }

    except Exception as error:

        db.rollback()

        print(
            "AI request error:",
            str(error)
        )

        return {

            "response":
                "Sorry, I could not process your request.",

            "source":
                "FastAPI",

            "error":
                str(error),
        }

    finally:

        db.close()


# =========================================================
# RUN DIRECTLY
# =========================================================

if __name__ == "__main__":

    import uvicorn

    # Single source of truth for where the backend listens.
    #
    # Host defaults to 0.0.0.0 so a physical glasses device on the same LAN
    # can reach this API (127.0.0.1 is not reachable from the ESP32).
    # Port defaults to 8000, which is what every other component in this
    # repository already assumes (app/app.js, Settings.tsx, the Vite proxy).
    # Set HOST/PORT to move the whole stack without touching any file.
    uvicorn.run(

        "api:app",

        host=
            os.getenv("HOST", "0.0.0.0"),

        port=
            int(os.getenv("PORT", "8000")),

        reload=
            True
    )