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
    from backend.models import Conversation, Message
    from backend.device_api import router as device_router
except ImportError:
    from database import engine, SessionLocal, Base
    from models import Conversation, Message
    from device_api import router as device_router


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
    def search(self, query: str):
        clean_query = (query or "").strip()
        if not clean_query:
            return []

        if not YOUTUBE_API_KEY:
            return []

        search_params = urlencode({
            "part": "snippet",
            "q": clean_query,
            "type": "video",
            "videoEmbeddable": "true",
            "videoCategoryId": "10",
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

        with urlopen(search_request, timeout=15) as response:
            search_data = json.loads(response.read().decode("utf-8", errors="ignore"))

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

        with urlopen(detail_request, timeout=15) as response:
            detail_data = json.loads(response.read().decode("utf-8", errors="ignore"))

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

        tracks.sort(key=lambda item: item.get("score", 0), reverse=True)
        return tracks[:10]


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

        with urlopen(request, timeout=15) as response:
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
            else:
                provider = RealMusicProvider()
        self.provider = provider

    def search(self, query: str):
        tracks = self.provider.search(query)
        normalized = (query or "").strip()
        source_name = "mock"
        if isinstance(self.provider, NavidromeMusicProvider):
            source_name = "navidrome"
        elif isinstance(self.provider, RealMusicProvider):
            source_name = "youtube"
        return {
            "success": bool(tracks),
            "query": normalized,
            "tracks": tracks,
            "source": source_name,
            "notice": "Navidrome search results are returned for browser playback." if isinstance(self.provider, NavidromeMusicProvider) else "Mock music mode enabled." if isinstance(self.provider, MockMusicProvider) else "YouTube search results are returned for browser playback.",
        }

    def play(self, query: str):
        result = self.search(query)
        if not result["success"] or not result["tracks"]:
            return {"success": False, "message": "I couldn't find that song.", "tracks": []}

        track = result["tracks"][0]
        return {
            "success": True,
            "message": f"Playing {track.get('name', 'track')} by {track.get('artist', 'Unknown artist')}",
            "track": track,
            "tracks": result["tracks"],
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

    return navigation_service.route(destination, latitude=lat, longitude=lon)


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

@app.get("/api/music/config")
def music_provider_config():
    navidrome_configured = bool(NAVIDROME_URL and NAVIDROME_USERNAME and NAVIDROME_PASSWORD)
    youtube_configured = bool(YOUTUBE_API_KEY)
    configured = navidrome_configured or youtube_configured
    provider = "navidrome" if navidrome_configured else "youtube" if youtube_configured else "none"
    return {
        "success": configured,
        "provider": provider,
        "configured": configured,
        "requiresApiKey": not configured,
        "message": "Navidrome is configured." if navidrome_configured else "YouTube music is configured." if youtube_configured else "No music provider is configured. Set NAVIDROME_URL / NAVIDROME_USERNAME / NAVIDROME_PASSWORD or YOUTUBE_API_KEY in the backend environment.",
        "apiKeyConfigured": configured,
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

    result = music_service.search(query)
    if result.get("success"):
        return result

    return {
        "success": False,
        "query": query,
        "tracks": [],
        "source": getattr(music_service.provider, "__class__", type(music_service.provider)).__name__,
        "message": "No music results were returned for that query.",
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

    wake_words = [

        "hey visionary",

        "hey visionary nexus",

        "visionary",

        "visionary nexus",
    ]

    detected = any(

        word in phrase

        for word
        in wake_words
    )

    return {

        "detected":
            detected,

        "phrase":
            request.phrase,
    }


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
Create a short title for
the user's message.

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

                max_completion_tokens=
                    64
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
                "role":
                    item.role,

                "content":
                    item.content,
            }

            for item
            in history
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

        conversation_title = None

        if (
            first_message
            and conversation.title
            .strip()
            .lower()
            ==
            "new chat"
        ):

            generated_title = (
                generate_ai_title(
                    message
                )
            )

            conversation.title = (
                generated_title
            )

            db.commit()

            db.refresh(
                conversation
            )

            conversation_title = (
                conversation.title
            )

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

    uvicorn.run(

        "api:app",

        host=
            "127.0.0.1",

        port=
            8000,

        reload=
            True
    )