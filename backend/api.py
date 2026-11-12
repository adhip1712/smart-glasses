# =========================================================
# VISIONARY NEXUS - BACKEND API
# =========================================================

import base64
import os
import json
import re
import time

from datetime import datetime, timedelta
from urllib.parse import urlencode, quote
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

import jwt

from dotenv import load_dotenv

from fastapi import FastAPI, File, Form, UploadFile, Request as FastAPIRequest
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from pydantic import BaseModel

from groq import Groq

from sqlalchemy.orm import Session

try:
    from backend.database import engine, SessionLocal, Base
    from backend.models import Conversation, Message, RecentLocation, MusicPlaylist, Setting, User
    from backend.auth_api import router as auth_router, authenticate_token
    from backend.device_api import router as device_router
    from backend.camera_api import router as camera_router
    from backend.vision_api import router as vision_router
    from backend.youtube_oauth_api import router as youtube_oauth_router
    from backend.social_auth_api import router as social_auth_router
    from backend.whatsapp_api import router as whatsapp_router
except ImportError:
    from database import engine, SessionLocal, Base
    from models import Conversation, Message, RecentLocation, MusicPlaylist, Setting, User
    from auth_api import router as auth_router, authenticate_token
    from device_api import router as device_router
    from camera_api import router as camera_router
    from vision_api import router as vision_router
    from youtube_oauth_api import router as youtube_oauth_router
    from social_auth_api import router as social_auth_router
    from whatsapp_api import router as whatsapp_router


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
NAVIDROME_URL = os.getenv("NAVIDROME_URL", "http://127.0.0.1:4533").rstrip("/")
NAVIDROME_USERNAME = (os.getenv("NAVIDROME_USERNAME") or "").strip()
NAVIDROME_PASSWORD = (os.getenv("NAVIDROME_PASSWORD") or "").strip()
NAVIDROME_ENABLED = (os.getenv("NAVIDROME_ENABLED", "true") or "true").strip().lower() == "true"
# YouTube is the primary song catalogue; Piped and Invidious are fallbacks.
# Spotify remains an optional Premium library. Legacy provider credentials stay intact.
SPOTIFY_CLIENT_ID = (os.getenv("SPOTIFY_CLIENT_ID") or "").strip()
SPOTIFY_CLIENT_SECRET = (os.getenv("SPOTIFY_CLIENT_SECRET") or "").strip()
YOUTUBE_API_KEY = (os.getenv("YOUTUBE_API_KEY") or "").strip()
AUDIUS_API_KEY = (os.getenv("AUDIUS_API_KEY") or "").strip()
SOUNDCLOUD_CLIENT_ID = (os.getenv("SOUNDCLOUD_CLIENT_ID") or "").strip()
SOUNDCLOUD_CLIENT_SECRET = (os.getenv("SOUNDCLOUD_CLIENT_SECRET") or "").strip()
SOUNDCLOUD_TOKEN_CACHE = {"access_token": "", "expires_at": 0.0}
WEATHER_PROVIDER = os.getenv("WEATHER_PROVIDER", "mock").lower()
NAVIGATION_PROVIDER = os.getenv("NAVIGATION_PROVIDER", "mock").lower()
WEATHER_BASE_URL = os.getenv("WEATHER_BASE_URL", "https://api.weatherapi.com")
NAVIGATION_BASE_URL = os.getenv("NAVIGATION_BASE_URL", "https://nominatim.openstreetmap.org")


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


class JamendoMusicProvider(BaseMusicProvider):
    """Jamendo's non-commercial catalogue and direct MP3 streaming API."""

    BASE_URL = "https://api.jamendo.com/v3.0"

    def __init__(self, client_id: str | None = None):
        self.client_id = (client_id if client_id is not None else os.getenv("JAMENDO_CLIENT_ID", "")).strip()

    def search(self, query: str):
        clean_query = (query or "").strip()
        if not clean_query or not self.client_id:
            return []

        params = urlencode({
            "client_id": self.client_id,
            "format": "json",
            "search": clean_query,
            "limit": 10,
            "type": "single albumtrack",
            "audioformat": "mp32",
            "imagesize": 300,
            "include": "licenses",
        })
        request = Request(
            f"{self.BASE_URL}/tracks/?{params}",
            headers={"User-Agent": "VISIONARY-NEXUS/1.0", "Accept": "application/json"},
            method="GET",
        )
        try:
            with urlopen(request, timeout=4) as response:
                payload = json.loads(response.read().decode("utf-8", errors="ignore"))
        except (HTTPError, URLError, TimeoutError, ValueError):
            return []

        tracks = []
        for item in payload.get("results") or []:
            if not isinstance(item, dict):
                continue
            audio_url = str(item.get("audio") or "").strip()
            if not audio_url.startswith("https://"):
                continue
            track_id = str(item.get("id") or "")
            if not track_id:
                continue
            tracks.append({
                "id": f"jamendo-{track_id}",
                "name": str(item.get("name") or "Unknown track"),
                "artist": str(item.get("artist_name") or "Unknown artist"),
                "album": str(item.get("album_name") or ""),
                "duration": int(item.get("duration") or 0) * 1000,
                "image": str(item.get("image") or item.get("album_image") or ""),
                "audio": audio_url,
                "url": str(item.get("shareurl") or item.get("shorturl") or "https://www.jamendo.com"),
                "genre": "Jamendo",
                "provider": "jamendo",
                "license": str(item.get("license_ccurl") or ""),
                "score": 90 - len(tracks),
            })
        return tracks

class SpotifyMusicProvider(BaseMusicProvider):
    """Spotify Web API catalogue search (client credentials flow).

    Playback is handled in the frontend by the SpotifyMusic component with the
    user's own OAuth session; this provider only maps search results into the
    shared track shape for the voice/AI music endpoints.
    """

    TOKEN_URL = "https://accounts.spotify.com/api/token"
    SEARCH_URL = "https://api.spotify.com/v1/search"

    def _access_token(self):
        if not SPOTIFY_CLIENT_ID or not SPOTIFY_CLIENT_SECRET:
            return ""
        credentials = f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}".encode("utf-8")
        authorization = base64.b64encode(credentials).decode("ascii")
        request = Request(
            self.TOKEN_URL,
            data=urlencode({"grant_type": "client_credentials"}).encode("utf-8"),
            headers={
                "Authorization": f"Basic {authorization}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=6) as response:
                return json.loads(response.read().decode("utf-8", errors="ignore")).get("access_token") or ""
        except (HTTPError, URLError, TimeoutError, ValueError):
            return ""

    def search(self, query: str):
        clean_query = (query or "").strip()
        token = self._access_token()
        if not clean_query or not token:
            return []

        params = urlencode({"q": clean_query, "type": "track", "limit": 10})
        request = Request(
            f"{self.SEARCH_URL}?{params}",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            method="GET",
        )
        try:
            with urlopen(request, timeout=6) as response:
                payload = json.loads(response.read().decode("utf-8", errors="ignore"))
        except (HTTPError, URLError, TimeoutError, ValueError):
            return []

        tracks = []
        for index, item in enumerate((payload.get("tracks") or {}).get("items") or []):
            track_id = item.get("id") or ""
            title = item.get("name")
            if not track_id or not title:
                continue
            artists = ", ".join(artist.get("name") or "" for artist in item.get("artists") or []) or "Spotify artist"
            album = item.get("album") or {}
            image = ""
            for candidate in album.get("images") or []:
                image = candidate.get("url") or ""
                if image:
                    break
            track_url = (item.get("external_urls") or {}).get("spotify") or "https://open.spotify.com"
            tracks.append({
                "id": f"spotify-{track_id}",
                "name": title,
                "artist": artists,
                "album": album.get("name") or "",
                "duration": item.get("duration_ms") or 0,
                "image": image,
                "audio": item.get("preview_url") or "",
                "url": track_url,
                "genre": "Spotify",
                "provider": "spotify",
                "spotifyId": track_id,
                "score": 100 - index,
            })
        return tracks


class SoundCloudMusicProvider(BaseMusicProvider):
    """Legacy provider retained for compatibility; it is not selected by default."""

    def search(self, query: str):
        soundcloud = music_soundcloud_search(query, 18)
        if soundcloud.get("success") and soundcloud.get("matched"):
            return [
                {**track, "audio": track.get("stream_url", "")}
                for track in (soundcloud.get("tracks") or [])
                if track.get("matched") and track.get("stream_url")
            ]

        audius = music_audius_search(query, 18)
        return [
            {**track, "audio": track.get("stream_url", "")}
            for track in (audius.get("tracks") or [])
            if track.get("matched") and track.get("stream_url")
        ]


class YouTubeMusicProvider(BaseMusicProvider):
    """YouTube-first catalogue with Piped then Invidious as keyless fallbacks."""

    def search(self, query: str):
        result = music_youtube_search(query, 18)
        tracks = result.get("tracks") or []
        message = str(result.get("message") or "")
        if not tracks and (not YOUTUBE_API_KEY or re.search(r"quota|daily.*limit|per.day.*limit", message, re.IGNORECASE)):
            fallback = music_youtube_alternative_search(query, 18)
            tracks = fallback.get("tracks") or []
        normalized = []
        for track in tracks:
            item = dict(track)
            item["videoId"] = item.get("id") or item.get("videoId")
            item["duration"] = int(item.get("durationSeconds") or 0) * 1000
            item["provider"] = "youtube"
            normalized.append(item)
        return normalized


class MusicService:
    def __init__(self, provider: BaseMusicProvider | None = None):
        if provider is None:
            # YouTube is the primary music source. Spotify is opt-in from the
            # dedicated library UI and never replaces the default catalogue.
            provider = YouTubeMusicProvider()
        self.provider = provider

    def search(self, query: str):
        normalized = (query or "").strip()
        tracks = self.provider.search(normalized)
        if isinstance(self.provider, SpotifyMusicProvider):
            source_name = "spotify"
            notice = (
                "Spotify catalogue results are ready for playback."
                if SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET
                else "Spotify search is not configured yet; add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to backend/.env."
            )
        elif isinstance(self.provider, YouTubeMusicProvider):
            source_name = "youtube"
            notice = (
                "YouTube results found. Piped and Invidious are used when YouTube API quota is unavailable."
                if tracks
                else "No matching YouTube tracks were found."
            )
        elif isinstance(self.provider, SoundCloudMusicProvider):
            source_name = tracks[0].get("provider", "soundcloud") if tracks else "soundcloud"
            notice = (
                "SoundCloud catalogue match found."
                if source_name == "soundcloud"
                else "No close SoundCloud match; using the Audius fallback."
                if tracks
                else "No sufficiently close playable match was found on SoundCloud or Audius."
            )
        elif isinstance(self.provider, MockMusicProvider):
            source_name = "mock"
            notice = "Mock music mode enabled."
        else:
            source_name = "unavailable"
            notice = "No active music catalogue is available."

        query_tokens = set(re.findall(r"[a-z0-9]+", normalized.casefold()))
        def track_rank(track):
            title = str(track.get("name") or "").casefold()
            artist = str(track.get("artist") or "").casefold()
            title_tokens = set(re.findall(r"[a-z0-9]+", title))
            artist_tokens = set(re.findall(r"[a-z0-9]+", artist))
            return (int(bool(normalized) and normalized.casefold() in title), len(query_tokens & title_tokens), len(query_tokens & artist_tokens), int(track.get("duration") or 0))

        if tracks:
            tracks.sort(key=track_rank, reverse=True)
            longer_tracks = [track for track in tracks if int(track.get("duration") or 0) >= 60000]
            if longer_tracks:
                tracks = longer_tracks

        return {"success": bool(tracks), "query": normalized, "tracks": tracks, "source": source_name, "notice": notice}

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
                    # Some Audius uploads include the original artist in the
                    # track title while the uploader profile is a distributor.
                    return title_tokens.issubset(track_title_tokens) and artist_tokens.issubset(track_artist_tokens | track_title_tokens)
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
        highs = [28, 27, 29, 28, 27, 29, 30]
        lows = [20, 20, 21, 20, 19, 20, 21]
        conditions = [
            "Partly cloudy", "Light rain", "Mostly clear", "Cloudy",
            "Partly cloudy", "Clear sky", "Mostly clear",
        ]
        current["forecast"] = [
            {
                "date": (datetime.utcnow().date() + timedelta(days=offset)).isoformat(),
                "condition": conditions[offset],
                "temperature_c": highs[offset],
                "max_c": highs[offset],
                "min_c": lows[offset],
            }
            for offset in range(7)
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

    @staticmethod
    def _wttr_fallback(city_name: str):
        """Use wttr.in as a live fallback when the primary weather APIs reject a request."""
        url = "https://wttr.in/" + quote(city_name) + "?format=j1"
        request = Request(url, headers={"User-Agent": "VISIONARY-NEXUS/1.0"})
        with urlopen(request, timeout=12) as response:
            data = json.loads(response.read().decode("utf-8"))

        current_rows = data.get("current_condition") or []
        if not current_rows:
            return {"success": False, "message": "No live weather data was returned for '" + city_name + "'."}
        current = current_rows[0]
        nearest_rows = data.get("nearest_area") or []
        nearest = nearest_rows[0] if nearest_rows else {}
        area_name = (nearest.get("areaName") or [{}])[0].get("value", city_name)
        region = (nearest.get("region") or [{}])[0].get("value", "")
        country = (nearest.get("country") or [{}])[0].get("value", "")
        description = (current.get("weatherDesc") or [{}])[0].get("value", "Unknown")

        def number(value):
            try:
                return float(value)
            except (TypeError, ValueError):
                return None

        forecast = []
        for day in data.get("weather") or []:
            hourly = day.get("hourly") or []
            rain_values = [number(hour.get("chanceofrain")) for hour in hourly]
            rain_values = [value for value in rain_values if value is not None]
            forecast.append({
                "date": day.get("date", ""),
                "condition": ((hourly[4].get("weatherDesc") or [{}])[0].get("value", "Unknown") if len(hourly) > 4 else description),
                "temperature_c": number(day.get("avgtempC")),
                "max_c": number(day.get("maxtempC")),
                "min_c": number(day.get("mintempC")),
                "rain_chance": max(rain_values) if rain_values else None,
            })

        return {
            "success": True,
            "location": area_name,
            "region": region,
            "country": country,
            "temperature_c": number(current.get("temp_C")),
            "feels_like_c": number(current.get("FeelsLikeC")),
            "humidity": number(current.get("humidity")),
            "wind_kph": number(current.get("windspeedKmph")),
            "condition": str(description).strip(),
            "condition_icon": "",
            "last_updated": current.get("localObsDateTime") or current.get("observation_time"),
            "source": "wttr.in fallback",
            "forecast": forecast,
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

        try:
            geocode = self._geo_lookup(city_name)
        except (HTTPError, URLError):
            return self._wttr_fallback(city_name)
        if not geocode:
            return self._wttr_fallback(city_name)

        params = urlencode({
            "latitude": geocode["latitude"],
            "longitude": geocode["longitude"],
            "current": "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code",
            "timezone": "auto",
            "forecast_days": 1,
        })
        url = f"https://api.open-meteo.com/v1/forecast?{params}"
        request = Request(url, headers={"User-Agent": "VISIONARY-NEXUS/1.0"})

        try:
            with urlopen(request, timeout=10) as response:
                data = json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError):
            return self._wttr_fallback(city_name)

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
            params = urlencode({"key": WEATHER_API_KEY, "q": city_name, "days": 7, "aqi": "no", "alerts": "no"})
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

        try:
            geocode = self._geo_lookup(city_name)
        except (HTTPError, URLError):
            return self._wttr_fallback(city_name)
        if not geocode:
            return self._wttr_fallback(city_name)

        params = urlencode({
            "latitude": geocode["latitude"],
            "longitude": geocode["longitude"],
            "daily": "weather_code,temperature_2m_max,temperature_2m_min",
            "timezone": "auto",
            "forecast_days": 7,
        })
        url = f"https://api.open-meteo.com/v1/forecast?{params}"
        request = Request(url, headers={"User-Agent": "VISIONARY-NEXUS/1.0"})

        try:
            with urlopen(request, timeout=10) as response:
                data = json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError):
            return self._wttr_fallback(city_name)

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

app.include_router(auth_router)
app.include_router(youtube_oauth_router)
app.include_router(social_auth_router)
app.include_router(whatsapp_router)


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
# APPLICATION AUTHENTICATION
# =========================================================

@app.middleware("http")
async def require_account_session(request: FastAPIRequest, call_next):
    path = request.url.path
    public_prefixes = (
        "/api/auth/login", "/api/auth/register", "/api/auth/providers", "/api/auth/oauth/", "/api/health",
        "/api/device/", "/api/camera/", "/api/vision/", "/api/music/youtube-oauth/callback", "/api/music/audius-stream/",
        "/api/music/youtube-oauth/status", "/api/weather/",
    )
    is_public = path == "/" or any(path == prefix or path.startswith(prefix) for prefix in public_prefixes)
    if path.startswith("/api/") and not is_public:
        authorization = request.headers.get("authorization", "")
        scheme, _, token = authorization.partition(" ")
        user = authenticate_token(token) if scheme.lower() == "bearer" and token else None
        if not user:
            return JSONResponse(status_code=401, content={"detail": "Sign in to access Visionary Nexus."})
        request.state.auth_user = user
    return await call_next(request)


# =========================================================
# CORS
# =========================================================

app.add_middleware(
    CORSMiddleware,

    allow_origins=list(dict.fromkeys([
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
        "http://localhost:8443",
        "http://127.0.0.1:8443",
        "https://visionary-vexus.vercel.app",
        "https://localhost",
        "capacitor://localhost",
    ] + [
        origin.strip()
        for origin in os.getenv("CORS_ORIGINS", "").split(",")
        if origin.strip()
    ])),

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
# MUSIC REQUEST
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
            "YouTube Music",
            "Optional Spotify Premium library",
            "Full-track playback",
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
    """Report the provider that is actually selected by MusicService."""
    provider = getattr(music_service, "provider", None)
    if isinstance(provider, SpotifyMusicProvider):
        music_provider = (
            "Spotify catalogue search"
            if SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET
            else "Spotify search not configured (add SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET to .env)"
        )
    elif isinstance(provider, MockMusicProvider):
        music_provider = "Mock music provider"
    else:
        music_provider = type(provider).__name__ if provider is not None else "Unavailable"

    return {
        "status": "ok",
        "groq_configured": groq is not None,
        "weather_configured": bool(WEATHER_API_KEY),
        "music": music_provider,
        "navigation": "OpenStreetMap + OSRM",
        "timestamp": datetime.utcnow().isoformat(),
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
    try:
        result = weather_service.get_current(city)
    except Exception as exc:
        return JSONResponse(status_code=503, content={
            "success": False,
            "message": "Live weather is temporarily unavailable for '" + city + "'. Please retry shortly.",
            "error": type(exc).__name__,
        })
    if result.get("success"):
        return result

    return JSONResponse(status_code=503, content={
        "success": False,
        "message": result.get("message", "Could not get weather."),
        "error": result.get("error"),
    })


@app.get(
    "/api/weather/forecast/{city}"
)
def get_weather_forecast(
    city: str
):
    try:
        result = weather_service.get_forecast(city)
    except Exception as exc:
        return JSONResponse(status_code=503, content={
            "success": False,
            "message": "Live forecast is temporarily unavailable for '" + city + "'. Please retry shortly.",
            "error": type(exc).__name__,
        })
    if result.get("success"):
        return result

    return JSONResponse(status_code=503, content={
        "success": False,
        "message": result.get("message", "Could not get forecast."),
        "error": result.get("error"),
    })


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
    # YouTube is always the primary music experience. The official Data API
    # improves catalogue search; Piped and Invidious remain keyless fallbacks.
    # Spotify is exposed only as an optional connected Premium library.
    youtube_api_configured = bool(YOUTUBE_API_KEY)
    spotify_configured = bool(SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET)
    return {
        "success": True,
        "provider": "youtube",
        "configured": True,
        "youtubeApiConfigured": youtube_api_configured,
        "fallbackProvider": ["piped", "invidious"],
        "requiresApiKey": False,
        "message": (
            "YouTube is primary. Piped and Invidious are fallback search sources."
            if youtube_api_configured
            else "YouTube API search is not configured; keyless Piped and Invidious search will be used."
        ),
        "apiKeyConfigured": youtube_api_configured,
        "spotifyAvailable": spotify_configured,
    }


def _soundcloud_access_token():
    """Reuse a cached app token; SoundCloud limits client-credentials token creation."""
    if not SOUNDCLOUD_CLIENT_ID or not SOUNDCLOUD_CLIENT_SECRET:
        return ""
    if SOUNDCLOUD_TOKEN_CACHE["access_token"] and time.time() < SOUNDCLOUD_TOKEN_CACHE["expires_at"]:
        return SOUNDCLOUD_TOKEN_CACHE["access_token"]

    credentials = f"{SOUNDCLOUD_CLIENT_ID}:{SOUNDCLOUD_CLIENT_SECRET}".encode("utf-8")
    request = Request(
        "https://secure.soundcloud.com/oauth/token",
        data=urlencode({"grant_type": "client_credentials"}).encode("utf-8"),
        headers={
            "Authorization": "Basic " + base64.b64encode(credentials).decode("ascii"),
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
        method="POST",
    )
    with urlopen(request, timeout=10) as response:
        payload = json.loads(response.read().decode("utf-8", errors="replace"))
    token = str(payload.get("access_token") or "")
    if not token:
        return ""
    expires_in = int(payload.get("expires_in") or 3600)
    SOUNDCLOUD_TOKEN_CACHE["access_token"] = token
    SOUNDCLOUD_TOKEN_CACHE["expires_at"] = time.time() + max(60, expires_in - 90)
    return token


def _soundcloud_stream_url(track: dict, token: str) -> str:
    """Resolve SoundCloud's authenticated stream redirect to a browser-playable URL."""
    track_id = track.get("id")
    stream_endpoint = track.get("stream_url")
    if not stream_endpoint and track_id:
        stream_endpoint = f"https://api.soundcloud.com/tracks/{quote(str(track_id), safe='')}/stream"
    if not stream_endpoint:
        return ""
    request = Request(
        stream_endpoint,
        headers={"Authorization": f"OAuth {token}", "Accept": "application/json, */*"},
        method="GET",
    )
    with urlopen(request, timeout=10) as response:
        final_url = response.geturl()
        body = response.read()
    # Some API versions return a list of transcoding descriptors instead of redirecting.
    try:
        payload = json.loads(body.decode("utf-8", errors="replace"))
        transcodings = payload if isinstance(payload, list) else payload.get("transcodings", [])
        if isinstance(transcodings, list) and transcodings:
            preferred = next(
                (item for item in transcodings
                 if (item.get("format") or {}).get("protocol") == "progressive"),
                transcodings[0],
            )
            transcoding_url = preferred.get("url") or ""
            if transcoding_url:
                transcode_request = Request(
                    transcoding_url,
                    headers={"Authorization": f"OAuth {token}", "Accept": "application/json, */*"},
                    method="GET",
                )
                with urlopen(transcode_request, timeout=10) as streamed:
                    return streamed.geturl()
    except (ValueError, AttributeError, TypeError):
        pass
    return final_url if final_url != stream_endpoint else ""


@app.get("/api/music/soundcloud-search")
def music_soundcloud_search(q: str = "", limit: int = 18):
    """Search playable SoundCloud tracks and mark only sufficiently close matches."""
    query = (q or "").strip()
    if not query:
        return {"success": False, "configured": bool(SOUNDCLOUD_CLIENT_ID and SOUNDCLOUD_CLIENT_SECRET),
                "matched": False, "tracks": [], "message": "Enter a song or artist to search."}
    if not SOUNDCLOUD_CLIENT_ID or not SOUNDCLOUD_CLIENT_SECRET:
        return {"success": False, "configured": False, "matched": False, "tracks": [],
                "message": "SoundCloud is not configured yet. Add SOUNDCLOUD_CLIENT_ID and SOUNDCLOUD_CLIENT_SECRET to the project .env file."}

    try:
        token = _soundcloud_access_token()
        if not token:
            raise RuntimeError("SoundCloud did not issue an access token.")
        params = urlencode({
            "q": query,
            "access": "playable",
            "limit": max(1, min(int(limit or 18), 30)),
            "linked_partitioning": "true",
        })
        request = Request(
            "https://api.soundcloud.com/tracks?" + params,
            headers={"Authorization": f"OAuth {token}", "Accept": "application/json"},
            method="GET",
        )
        with urlopen(request, timeout=12) as response:
            payload = json.loads(response.read().decode("utf-8", errors="replace"))
        raw_tracks = payload.get("collection") or payload.get("data") or []
        query_tokens = set(re.findall(r"[a-z0-9]+", query.casefold())) - {
            "a", "an", "and", "by", "for", "from", "i", "listen", "me", "my",
            "of", "on", "or", "play", "please", "song", "the", "to", "track", "want",
        }
        tracks = []
        for item in raw_tracks:
            if not isinstance(item, dict) or item.get("access") == "blocked":
                continue
            title = str(item.get("title") or "").strip()
            user = item.get("user") or {}
            artist = str(item.get("metadata_artist") or user.get("username") or user.get("full_name") or "Unknown artist")
            genre = str(item.get("genre") or "")
            title_tokens = set(re.findall(r"[a-z0-9]+", title.casefold()))
            artist_tokens = set(re.findall(r"[a-z0-9]+", artist.casefold()))
            genre_tokens = set(re.findall(r"[a-z0-9]+", genre.casefold()))
            all_tokens = title_tokens | artist_tokens | genre_tokens
            coverage = len(query_tokens & all_tokens) / len(query_tokens) if query_tokens else 0.0
            title_coverage = len(query_tokens & title_tokens) / len(query_tokens) if query_tokens else 0.0
            artist_coverage = len(query_tokens & artist_tokens) / len(query_tokens) if query_tokens else 0.0
            genre_coverage = len(query_tokens & genre_tokens) / len(query_tokens) if query_tokens else 0.0
            matched = bool(query_tokens) and coverage >= 0.60 and (
                title_coverage >= 0.50 or artist_coverage >= 0.70
                or (len(query_tokens) == 1 and genre_coverage >= 0.80)
            )
            # Do not resolve streams for unrelated search hits; this keeps the
            # primary search fast and prevents unrelated tracks being surfaced.
            if not matched:
                continue
            stream_url = _soundcloud_stream_url(item, token)
            if not stream_url:
                continue
            artwork = item.get("artwork_url") or ""
            if artwork:
                artwork = re.sub(r"-large\.", "-t500x500.", artwork)
            tracks.append({
                "id": str(item.get("urn") or item.get("id") or ""),
                "name": title or "Untitled track",
                "artist": artist,
                "image": artwork,
                "url": str(item.get("permalink_url") or ""),
                "stream_url": stream_url,
                "duration": int(item.get("duration") or 0),
                "genre": genre,
                "provider": "soundcloud",
                "match_score": round(coverage, 3),
                "matched": matched,
            })
        tracks.sort(key=lambda track: (track["matched"], track["match_score"]), reverse=True)
        matched = any(track["matched"] for track in tracks)
        return {
            "success": True,
            "configured": True,
            "matched": matched,
            "tracks": tracks,
            "query": query,
            "message": f"Found {len(tracks)} playable SoundCloud tracks." if tracks else "No playable SoundCloud tracks found.",
        }
    except HTTPError as error:
        return {"success": False, "configured": True, "matched": False, "tracks": [],
                "message": f"SoundCloud returned HTTP {error.code}."}
    except (URLError, TimeoutError, ValueError, RuntimeError) as error:
        print("SoundCloud search error:", str(error))
        return {"success": False, "configured": True, "matched": False, "tracks": [],
                "message": "SoundCloud is temporarily unavailable. Audius fallback can be used."}
    except Exception as error:
        print("SoundCloud search error:", str(error))
        return {"success": False, "configured": True, "matched": False, "tracks": [],
                "message": "SoundCloud search failed. Audius fallback can be used."}


@app.get("/api/music/audius-search")
def music_audius_search(q: str = "", limit: int = 12):
    """Search Audius' public catalogue and return streamable track metadata."""
    query = (q or "").strip()
    if not query:
        return {"success": False, "tracks": [], "message": "Enter a song, artist or genre to search."}

    params = {"query": query, "limit": max(1, min(int(limit or 12), 30))}
    if AUDIUS_API_KEY:
        params["api_key"] = AUDIUS_API_KEY
    request_url = "https://api.audius.co/v1/tracks/search?" + urlencode(params)
    try:
        request = Request(
            request_url,
            headers={"Accept": "application/json", "User-Agent": "VisionaryNexus/1.0"},
        )
        with urlopen(request, timeout=12) as response:
            payload = json.loads(response.read().decode("utf-8"))
        raw_tracks = payload.get("data") or []
        query_tokens = set(re.findall(r"[a-z0-9]+", query.casefold())) - {
            "a", "an", "and", "by", "for", "from", "i", "listen", "me", "my",
            "of", "on", "or", "play", "please", "song", "the", "to", "track", "want",
        }
        tracks = []
        for item in raw_tracks:
            if not isinstance(item, dict) or not item.get("id"):
                continue
            user = item.get("user") or {}
            artwork = item.get("artwork") or item.get("cover_art") or {}
            stream = item.get("stream") or {}
            stream_url = stream.get("url") if isinstance(stream, dict) else None
            if not stream_url or not item.get("is_streamable", True):
                continue
            title = str(item.get("title") or "Unknown track")
            artist = str(user.get("name") or user.get("handle") or "Unknown artist")
            title_tokens = set(re.findall(r"[a-z0-9]+", title.casefold()))
            artist_tokens = set(re.findall(r"[a-z0-9]+", artist.casefold()))
            genre_tokens = set(re.findall(r"[a-z0-9]+", str(item.get("genre") or "").casefold()))
            coverage = len(query_tokens & (title_tokens | artist_tokens | genre_tokens)) / len(query_tokens) if query_tokens else 0.0
            title_coverage = len(query_tokens & title_tokens) / len(query_tokens) if query_tokens else 0.0
            artist_coverage = len(query_tokens & artist_tokens) / len(query_tokens) if query_tokens else 0.0
            genre_coverage = len(query_tokens & genre_tokens) / len(query_tokens) if query_tokens else 0.0
            matched = bool(query_tokens) and coverage >= 0.60 and (
                title_coverage >= 0.50 or artist_coverage >= 0.70
                or (len(query_tokens) == 1 and genre_coverage >= 0.80)
            )
            permalink = item.get("permalink") or ""
            tracks.append({
                "id": str(item["id"]),
                "name": title,
                "artist": artist,
                "image": artwork.get("480x480") or artwork.get("150x150") or "",
                "url": "https://audius.co" + permalink if permalink.startswith("/") else (permalink or "https://audius.co"),
                "stream_url": f"/api/music/audius-stream/{quote(str(item['id']), safe='')}",
                "audio": f"/api/music/audius-stream/{quote(str(item['id']), safe='')}",
                "duration": int(item.get("duration") or 0),
                "genre": str(item.get("genre") or ""),
                "play_count": int(item.get("play_count") or 0),
                "provider": "audius",
                "match_score": round(coverage, 3),
                "matched": matched,
            })
        return {
            "success": True,
            "tracks": tracks,
            "query": query,
            "message": f"Found {len(tracks)} Audius tracks." if tracks else "No streamable Audius tracks found. Try another search.",
        }
    except HTTPError as error:
        return {"success": False, "tracks": [], "message": f"Audius search returned HTTP {error.code}."}
    except (URLError, TimeoutError, ValueError) as error:
        print("Audius search error:", str(error))
        return {"success": False, "tracks": [], "message": "Audius is temporarily unavailable. Please try again."}
    except Exception as error:
        print("Audius search error:", str(error))
        return {"success": False, "tracks": [], "message": "Audius search failed. Please try again."}

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
            timeout=2.5,
        )
        corrected = (completion.choices[0].message.content or "").strip().strip('"').strip("'")
        if corrected and len(corrected) <= max(160, len(query) * 3):
            return corrected
    except Exception as error:
        print("Music query correction error:", str(error))
    return query.strip()


def music_search_relevance(query: str, tracks: list[dict]) -> float:
    """Estimate whether returned titles/artists actually match the requested song."""
    ignored = {"a", "an", "and", "by", "for", "from", "i", "listen", "me", "my", "of", "on", "or", "please", "song", "the", "to", "track", "want"}
    tokens = set(re.findall(r"[a-z0-9]+", (query or "").casefold())) - ignored
    if not tokens:
        return 1.0
    best = 0.0
    for track in tracks or []:
        searchable = " ".join(str(track.get(key) or "") for key in ("name", "artist", "album", "genre"))
        found = set(re.findall(r"[a-z0-9]+", searchable.casefold()))
        best = max(best, len(tokens & found) / len(tokens))
    return best


@app.get("/api/music/youtube-search")
def music_youtube_search(q: str = "", limit: int = 12):
    """Search the official YouTube Data API; playback stays in the embedded YouTube player."""
    query = (q or "").strip()
    if not query:
        return {"success": False, "tracks": [], "message": "Enter a song, artist or genre to search."}
    if not YOUTUBE_API_KEY:
        return {"success": False, "tracks": [], "message": "YouTube search is not configured. Add YOUTUBE_API_KEY to the project .env file."}

    def search_videos(term: str, duration_filter: str = "short"):
        params = urlencode({
            "part": "snippet",
            "type": "video",
            "videoEmbeddable": "true",
            # Search short videos first so hour-long mixes never crowd out
            # the actual song. A second medium pass below catches longer songs.
            "videoDuration": duration_filter,
            "safeSearch": "moderate",
            "regionCode": "IN",
            "maxResults": max(1, min(int(limit or 12), 20)),
            "order": "relevance",
            "q": term,
            "key": YOUTUBE_API_KEY,
        })
        request = Request(
            "https://www.googleapis.com/youtube/v3/search?" + params,
            headers={"Accept": "application/json", "User-Agent": "VisionaryNexus/1.0"},
            method="GET",
        )
        with urlopen(request, timeout=8) as response:
            return json.loads(response.read().decode("utf-8", errors="replace"))

    searched_query = query
    try:
        # Combine short and medium YouTube results. This avoids hour-long
        # uploads dominating a title search while still allowing songs longer
        # than four minutes.
        payload = search_videos(query, "short")
        items = payload.get("items") or []
        seen_video_ids = {
            str((item.get("id") or {}).get("videoId") or "")
            for item in items
        }
        try:
            medium_payload = search_videos(query, "medium")
        except (HTTPError, URLError, TimeoutError, ValueError) as medium_error:
            print("YouTube medium-duration search unavailable:", str(medium_error))
            medium_payload = {}
        for item in medium_payload.get("items") or []:
            video_id = str((item.get("id") or {}).get("videoId") or "")
            if video_id and video_id not in seen_video_ids:
                items.append(item)
                seen_video_ids.add(video_id)

        if not items:
            corrected = correct_music_search_query(query)
            if corrected and corrected.casefold() != query.casefold():
                retry_short = search_videos(corrected, "short")
                retry_items = retry_short.get("items") or []
                try:
                    retry_medium = search_videos(corrected, "medium")
                except (HTTPError, URLError, TimeoutError, ValueError) as medium_error:
                    print("Corrected YouTube medium-duration search unavailable:", str(medium_error))
                    retry_medium = {}
                retry_seen = {
                    str((item.get("id") or {}).get("videoId") or "")
                    for item in retry_items
                }
                for item in retry_medium.get("items") or []:
                    video_id = str((item.get("id") or {}).get("videoId") or "")
                    if video_id and video_id not in retry_seen:
                        retry_items.append(item)
                        retry_seen.add(video_id)
                if retry_items:
                    items = retry_items
                    searched_query = corrected

        # Fetch duration for candidate videos so Shorts/clips are not blindly
        # selected as full songs. This also supplies stable metadata to ranking.
        video_ids = [
            str((item.get("id") or {}).get("videoId") or "").strip()
            for item in items
        ]
        video_ids = [video_id for video_id in video_ids if video_id]
        details_by_id = {}
        if video_ids:
            detail_params = urlencode({
                "part": "contentDetails,snippet",
                "id": ",".join(video_ids),
                "key": YOUTUBE_API_KEY,
            })
            detail_request = Request(
                "https://www.googleapis.com/youtube/v3/videos?" + detail_params,
                headers={"Accept": "application/json", "User-Agent": "VisionaryNexus/1.0"},
                method="GET",
            )
            try:
                with urlopen(detail_request, timeout=8) as detail_response:
                    detail_payload = json.loads(detail_response.read().decode("utf-8", errors="replace"))
                details_by_id = {
                    str(video.get("id")): video
                    for video in (detail_payload.get("items") or [])
                }
            except (HTTPError, URLError, TimeoutError, ValueError):
                details_by_id = {}

        def duration_seconds(value):
            match = re.fullmatch(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", str(value or ""))
            if not match:
                return 0
            hours, minutes, seconds = (int(part or 0) for part in match.groups())
            return hours * 3600 + minutes * 60 + seconds

        tracks = []
        for item in items:
            video_id = str((item.get("id") or {}).get("videoId") or "").strip()
            snippet = item.get("snippet") or {}
            if not video_id:
                continue
            detail = details_by_id.get(video_id) or {}
            detail_snippet = detail.get("snippet") or snippet
            duration = duration_seconds((detail.get("contentDetails") or {}).get("duration"))
            title = str(detail_snippet.get("title") or snippet.get("title") or "YouTube video")
            if (
                (duration and (duration <= 60 or duration > 900))
                or re.search(r"\bshorts?\b|#shorts|\b(?:1|one)\s*hour\b|\b60\s*min(?:ute)?s?\b|extended\s*mix|\bloops?\b", title, re.IGNORECASE)
            ):
                continue
            thumbnails = (detail_snippet.get("thumbnails") or snippet.get("thumbnails") or {})
            image = (
                (thumbnails.get("high") or {}).get("url")
                or (thumbnails.get("medium") or {}).get("url")
                or (thumbnails.get("default") or {}).get("url")
                or ""
            )
            tracks.append({
                "id": video_id,
                "name": title,
                "artist": str(detail_snippet.get("channelTitle") or snippet.get("channelTitle") or "YouTube"),
                "durationSeconds": duration,
                "image": image,
                "url": "https://www.youtube.com/watch?v=" + video_id,
                "provider": "youtube",
            })
        return {
            "success": bool(tracks),
            "tracks": tracks,
            "query": query,
            "corrected_query": searched_query,
            "message": "" if tracks else "No embeddable YouTube videos were found for that search.",
        }
    except HTTPError as error:
        detail = "YouTube search request failed."
        try:
            body = json.loads(error.read().decode("utf-8", errors="replace"))
            detail = str((body.get("error") or {}).get("message") or detail)
        except Exception:
            pass
        return {"success": False, "tracks": [], "message": detail}
    except (URLError, TimeoutError, ValueError) as error:
        print("YouTube music search error:", str(error))
        return {"success": False, "tracks": [], "message": "Could not reach YouTube search. Check the backend internet connection and try again."}


@app.get("/api/music/youtube-alternative-search")
def music_youtube_alternative_search(q: str = "", limit: int = 18):
    """Search public Piped and Invidious instances after official YouTube API quota limits."""
    query = (q or "").strip()
    if not query:
        return {"success": False, "tracks": [], "source": "", "message": "Enter a song, artist or genre to search."}

    max_results = max(1, min(int(limit or 18), 20))
    headers = {"Accept": "application/json", "User-Agent": "VisionaryNexus/1.0"}
    # Public instance availability changes frequently. Keep several known
    # API hosts in rotation and continue immediately when one is offline.
    piped_instances = [
        "https://pipedapi.kavin.rocks",
        "https://pipedapi.nosebs.ru",
        "https://piped-api.privacy.com.de",
        "https://api.piped.yt",
        "https://pipedapi.leptons.xyz",
        "https://pipedapi.adminforge.de",
    ]
    invidious_instances = [
        "https://invidious.tiekoetter.com",
        "https://yt.chocolatemoo53.com",
        "https://invidious.nerdvpn.de",
        "https://inv.nadeko.net",
    ]

    def clean_video_id(value):
        text = str(value or "")
        match = re.search(r"(?:v=|/watch/|/shorts/|^)([A-Za-z0-9_-]{11})(?:\b|$)", text)
        return match.group(1) if match else ""

    def valid_track(track):
        title = str(track.get("name") or "")
        duration = int(track.get("durationSeconds") or 0)
        return bool(
            track.get("id") and title
            and not re.search(
                r"\bshorts?\b|#shorts|\b(?:1|one)\s*hour\b|\b60\s*min(?:ute)?s?\b|extended\s*mix|\bloops?\b",
                title,
                re.IGNORECASE,
            )
            and not (duration and (duration <= 60 or duration > 900))
        )

    # Piped first: it exposes YouTube search metadata without consuming the
    # official YouTube Data API quota.
    for instance in piped_instances:
        try:
            params = urlencode({"q": query, "filter": "music_songs"})
            request = Request(instance + "/search?" + params, headers=headers)
            with urlopen(request, timeout=3) as response:
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
            with urlopen(request, timeout=3) as response:
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


@app.post("/api/music/correct-query")
def music_correct_query(request: MusicSearchRequest):
    """Return an AI-corrected song/artist phrase for the Spotify client."""
    query = (request.query or "").strip()
    if not query:
        return {"success": False, "query": "", "corrected_query": ""}
    corrected = correct_music_search_query(query)
    return {"success": True, "query": query, "corrected_query": corrected}


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

    # Search the user's original words first. Only ask AI to correct spelling
    # when the catalogue returns no convincing title/artist match, so normal
    # searches stay fast and the model cannot rewrite a query unnecessarily.
    search_query = query
    result = music_service.search(search_query)
    initial_tracks = result.get("tracks") or []
    if music_search_relevance(query, initial_tracks) < 0.75:
        corrected_query = correct_music_search_query(query)
        if corrected_query and corrected_query.casefold() != query.casefold():
            corrected_result = music_service.search(corrected_query)
            corrected_tracks = corrected_result.get("tracks") or []
            corrected_relevance = music_search_relevance(corrected_query, corrected_tracks)
            if corrected_result.get("success") and corrected_tracks and corrected_relevance > music_search_relevance(query, initial_tracks) and corrected_relevance > 0:
                result = corrected_result
                search_query = corrected_query

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
        if suggestions.get("tracks"):
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
    # Natural-language WhatsApp fallbacks for when the AI provider is unavailable.
    # The primary path below uses the language model to understand varied phrasing.
    natural_whatsapp_patterns = (
        r"^(?:please\s+)?(?:can you|could you|i need to|i want to)?\s*tell\s+([A-Za-z][A-Za-z0-9 .'-]*?)\s+(?:that\s+)?(.+)$",
        r"^(?:please\s+)?(?:can you|could you|i need to|i want to)?\s*let\s+([A-Za-z][A-Za-z0-9 .'-]*?)\s+know\s+(.+)$",
        r"^(?:please\s+)?(?:can you|could you|i need to|i want to)?\s*inform\s+([A-Za-z][A-Za-z0-9 .'-]*?)\s+(?:that\s+)?(.+)$",
    )
    for pattern in natural_whatsapp_patterns:
        natural_match = re.match(pattern, message, flags=re.IGNORECASE)
        if natural_match:
            recipient, body = (part.strip(" \t\r\n.!?") for part in natural_match.groups())
            if recipient and body and recipient.casefold() not in {"me", "myself", "us"}:
                canonical_command = f"send {body} to {recipient}"
                return {
                    "intent": "whatsapp", "action": "send", "destination": "",
                    "query": "", "polished_text": message, "recipient": recipient,
                    "message_text": body, "channel": "personal",
                    "command_text": canonical_command,
                }

    # Deterministic parsing also supports the canonical command format:
    # "send [message] to [person]".
    send_to_match = re.match(
        r"^(?:please\s+)?(?:send|message|text)\s+(.+)\s+to\s+([A-Za-z][A-Za-z0-9 .'-]*)[.!?]*$",
        message,
        flags=re.IGNORECASE,
    )
    if send_to_match:
        body = send_to_match.group(1).strip(" \t\r\n.!")
        recipient = send_to_match.group(2).strip(" \t\r\n.!?")
        # Email addresses imply an email channel; let the AI planner choose
        # Gmail/Outlook instead of incorrectly routing them to WhatsApp.
        if body and recipient and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", recipient):
            return {
                "intent": "whatsapp",
                "action": "send",
                "destination": "",
                "query": "",
                "polished_text": message,
                "recipient": recipient,
                "message_text": body,
                "channel": "personal",
                "command_text": f"send {body} to {recipient}",
            }

    # Supports "send a message to Hamsa saying ..." and
    # "send Hamsa a message saying ...".
    patterns = (
        r"^(?:please\s+)?(?:send|message|text)(?:\s+(?:a|the))?\s+(?:whatsapp\s+)?message\s+to\s+(.+?)\s+(?:saying|that says|with the message)\s+(.+)$",
        r"^(?:please\s+)?(?:send|message|text)\s+(.+?)\s+a\s+message\s+(?:saying|that says)\s+(.+)$",
    )
    for pattern in patterns:
        match = re.match(pattern, message, flags=re.IGNORECASE)
        if match:
            recipient, body = (part.strip(" \t\r\n.!?") for part in match.groups())
            if recipient and body:
                return {
                    "intent": "whatsapp", "action": "send", "destination": "",
                    "query": "", "polished_text": message, "recipient": recipient,
                    "message_text": body, "channel": "personal",
                    "command_text": f"send {body} to {recipient}",
                }

    email_recipient = re.search(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}", message, flags=re.IGNORECASE)
    email_action = bool(re.search(r"\\b(?:send|email|mail|write|compose)\\b", message, flags=re.IGNORECASE))
    if email_recipient and email_action:
        before_recipient = message[:email_recipient.start()]
        body_match = re.search(r"\\b(?:send|email|mail|write|compose)\\s+(.+?)\\s+(?:to|for)\\s*$", before_recipient, flags=re.IGNORECASE)
        body = body_match.group(1).strip(" \\t\\r\\n,.:;!?") if body_match else ""
        if body:
            return {
                "intent": "app_action", "action": "compose_email", "destination": "gmail",
                "query": "", "polished_text": message, "recipient": email_recipient.group(0),
                "message_text": body, "channel": "email",
            }

    if groq is None:
        # Registry-driven fallback: preserve an app-action request when the
        # language model is offline instead of passing it to conversational AI.
        app_aliases = (
            (("gmail", "google mail", "email", "inbox"), "gmail"),
            (("outlook",), "outlook"),
            (("whatsapp", "whats app"), "whatsapp"),
            (("calendar", "google calendar"), "calendar"),
            (("youtube", "you tube"), "youtube"),
            (("google maps", "maps"), "maps"),
            (("spotify",), "spotify"),
            (("google drive", "drive"), "drive"),
            (("github",), "github"),
        )
        normalized_app_request = normalized_fallback
        app_destination = next(
            (app for aliases, app in app_aliases if any(re.search(r"\b" + re.escape(alias) + r"\b", normalized_app_request) for alias in aliases)),
            "",
        )
        if app_destination and re.search(r"\b(?:open|launch|start|go to|switch to|search|find|create|schedule|add|send|message|write|compose)\\b", normalized_app_request):
            app_action = "open"
            if app_destination == "calendar" and re.search(r"\b(?:create|schedule|add)\\b", normalized_app_request):
                app_action = "create_event"
            elif app_destination == "calendar" and re.search(r"\b(?:find|search|show)\\b", normalized_app_request):
                app_action = "find_event"
            elif re.search(r"\b(?:search|find)\\b", normalized_app_request):
                app_action = "search"
            return {"intent": "app_action", "action": app_action, "destination": app_destination, "query": message, "polished_text": message, "recipient": "", "message_text": "", "channel": ""}
        return {"intent": "general", "action": "none", "destination": "", "query": message, "polished_text": message, "recipient": "", "message_text": "", "channel": ""}

    try:
        completion = groq.chat.completions.create(
            model="openai/gpt-oss-20b",
            messages=[
                {
                    "role": "system",
                    "content": """
You are the natural-language understanding engine for Visionary Nexus smart glasses. Interpret what the user MEANS, not just exact command wording. People speak in fragments, polite requests, long sentences, and pronouns.
Return JSON only:
{"intent":"app_action|whatsapp|music|weather|navigation|vision|audio|dashboard|ai|notifications|device|settings|general","action":"compose_email|open_chat|find_conversation|create_event|find_event|send|play|pause|resume|next|previous|search|open|capture|analyze|none","destination":"app/service name","query":"string","polished_text":"string","recipient":"string","message_text":"string","channel":"personal|business|"}.

Rules:
- APP ACTIONS: When the user asks you to do something inside an external app or service, return intent=app_action and identify the destination app in destination. Infer the intended app from context, recipient type, and task; do not require exact app-command wording. If the recipient is an email address or the user says email/mail, choose Gmail unless Outlook is explicitly named. For a request to send/write an email, choose action=compose_email, put the email address in recipient and the exact intended message body in message_text. This creates a draft only; never claim it was sent. For requests to open a person's chat or find a conversation in Gmail, choose action=open_chat or find_conversation and put the person/email in query or recipient. For other apps, select a meaningful action such as create_event, find_event, search, or open. If the app/task is not supported, still identify the intended app so the frontend can open it and explain the missing capability. Never turn an app-action request into a generic written answer merely because a connection is missing. Do not invent recipients, message content, dates, or other details.
- WHATSAPP: In Visionary Nexus, a command to send/message/text a named person defaults to WhatsApp unless the user explicitly specifies email, SMS, or another channel. Choose intent=whatsapp and action=send, including natural phrasing and wake-word dictation. Extract the recipient's name into recipient. Extract ONLY the actual message body into message_text, excluding command wording such as "send a message to", "the message is", and wake words. Preserve the dictated message exactly in meaning and detail; do not answer it or rewrite it. Example: "Hey Vision, send the following message to Adhiksh. The message is I am going to be late" => recipient="Adhiksh", message_text="I am going to be late". If the user explicitly says WhatsApp Business/business account, channel="business"; if they say personal WhatsApp, channel="personal"; otherwise channel="" so the app can use its configured default. Never invent a phone number. If the recipient or message body is missing/ambiguous, still return intent=whatsapp but leave that field empty so the app can ask for it. Do not confuse requests that merely mention WhatsApp with send commands.
- MUSIC: any request to listen to, put on, play, resume, find, or search for music, a song, artist, genre, or playlist. "I want to listen to phonk", "could you put my phonk on", and "play phonk" all mean music action=play, query="phonk". Strip filler like "some music", "a song", "please play", and generic words such as "playlist"/"song"/"music" when they are not part of the actual title. Preserve real titles. A question asking what a genre or artist means is general, not music playback.
- HARD RULE: "I want to listen to it", "let me listen to it", "I want to hear it", "play that again", or "put that on" are music intents when referring to music/playback. Return intent=music, action=resume or play, query="". Never send these to general/AI merely because the target is a pronoun. If context.active_tab is music, resolve "it/that" to the current song or selected playlist.
- Music controls: pause/stop => pause; continue/resume => resume; skip/next => next; previous/back => previous.
- Use supplied context.active_tab as conversation context, not as an absolute rule. When a pronoun such as "it/that one" refers to the current playback and active_tab is music, choose music and the relevant playback action.
- WEATHER: requests about current weather, rain, temperature, or forecasts. query is the requested location or subject.
- NAVIGATION: only when the user wants directions or a route. Extract destination, never invent it.
- VISION: when a user asks what is visible, identify an item, or describe the view, use action=analyze. When a user asks to take or click a picture, use action=capture. This is an AI interpretation, not a fixed phrase list.
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
        allowed = {"app_action", "whatsapp", "music", "weather", "navigation", "vision", "audio", "dashboard", "ai", "notifications", "device", "settings", "general"}
        actions = {"compose_email", "open_chat", "find_conversation", "create_event", "find_event", "send", "play", "pause", "resume", "next", "previous", "search", "open", "capture", "analyze", "none"}
        intent = str(parsed.get("intent") or "general").lower()
        if intent not in allowed:
            intent = "general"
        action = str(parsed.get("action") or "none").lower()
        if action not in actions:
            action = "none"
        destination = str(parsed.get("destination") or "").strip()
        query = str(parsed.get("query") or "").strip()
        polished_text = str(parsed.get("polished_text") or message).strip()
        recipient = str(parsed.get("recipient") or "").strip()
        message_text = str(parsed.get("message_text") or "").strip()
        channel = str(parsed.get("channel") or "").strip().lower()
        if channel not in {"personal", "business"}:
            channel = ""

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
            "recipient": recipient,
            "message_text": message_text,
            "channel": channel,
            # Canonical internal representation, independent of how the user phrased it.
            "command_text": (
                f"send {message_text} to {recipient}"
                if intent == "whatsapp" and action == "send" and recipient and message_text
                else ""
            ),
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


@app.post("/api/voice/synthesize")
def synthesize_voice_endpoint(request: dict):
    """Generate speech audio server-side; provider credentials never reach the browser."""
    text = str(request.get("text") or "").strip()
    if not text:
        return {"success": False, "engine": "unavailable", "message": "There is no text to speak."}
    try:
        try:
            from backend.voice import synthesize as synthesize_audio
        except ImportError:
            from voice import synthesize as synthesize_audio
        return synthesize_audio(text)
    except Exception as error:
        print("Voice synthesis endpoint failed:", type(error).__name__)
        return {"success": False, "engine": "unavailable", "message": "Voice synthesis is temporarily unavailable."}


@app.post("/api/voice/transcribe")
async def transcribe_voice_audio_endpoint(
    audio: UploadFile = File(...),
    language: str = Form("auto"),
):
    """Transcribe recorded microphone audio with the configured cloud STT provider."""
    payload = await audio.read()
    if not payload:
        return {"success": False, "engine": "unavailable", "text": "", "message": "No audio was uploaded."}
    try:
        try:
            from backend.voice import transcribe as transcribe_audio
        except ImportError:
            from voice import transcribe as transcribe_audio
        result = transcribe_audio(
            payload,
            filename=audio.filename or "dictation.webm",
            content_type=audio.content_type or "audio/webm",
        )
        # Do not expose provider exceptions, request headers, or credentials to clients.
        if not result.get("success"):
            result["message"] = "Cloud transcription was unavailable. You can retry or use browser recognition."
        result["language"] = language
        return result
    finally:
        await audio.close()


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