import json

from backend.api import (
    MusicService,
    NavidromeMusicProvider,
    RealNavigationProvider,
    classify_user_command,
)


def test_music_play_detected():
    result = classify_user_command("play spooky")
    assert result["intent"] == "music_play"
    assert result["query"] == "spooky"


def test_music_play_alternative_form():
    result = classify_user_command("play daylight")
    assert result["intent"] == "music_play"
    assert result["query"] == "daylight"


def test_music_search_detected():
    result = classify_user_command("search for spooky")
    assert result["intent"] == "music_search"
    assert result["query"] == "spooky"


def test_music_controls_detected():
    assert classify_user_command("pause music")["intent"] == "music_pause"
    assert classify_user_command("resume music")["intent"] == "music_resume"
    assert classify_user_command("next song")["intent"] == "music_next"


def test_weather_detected():
    assert classify_user_command("weather in Bengaluru")["intent"] == "weather"
    assert classify_user_command("weather in Delhi")["intent"] == "weather"
    assert classify_user_command("temperature in Mumbai")["intent"] == "weather"
    assert classify_user_command("weather tomorrow")["intent"] == "weather_forecast"


def test_navigation_detected():
    assert classify_user_command("navigate to Bengaluru airport")["intent"] == "navigation"
    assert classify_user_command("directions to MG Road")["intent"] == "navigation"
    assert classify_user_command("take me to school")["intent"] == "navigation"


def test_general_ai_not_specialized():
    assert classify_user_command("what is AI")["intent"] == "general"
    assert classify_user_command("what is 7 + 98")["intent"] == "general"
    assert classify_user_command("explain photosynthesis")["intent"] == "general"


def test_navigation_city_aliases_prefer_city_over_business(monkeypatch):
    city_result = {
        "display_name": "Bengaluru, Karnataka, India",
        "lat": "12.9716",
        "lon": "77.5946",
        "class": "boundary",
        "type": "administrative",
    }
    business_result = {
        "display_name": "Bengalore Tyre Service, Banaswadi Road, Bengaluru, Karnataka, India",
        "lat": "13.0100",
        "lon": "77.6200",
        "class": "shop",
        "type": "tyre_service",
    }
    airport_result = {
        "display_name": "Kempegowda International Airport, Bengaluru, Karnataka, India",
        "lat": "13.1986",
        "lon": "77.7066",
        "class": "aeroway",
        "type": "aerodrome",
    }
    palace_result = {
        "display_name": "Bangalore Palace, Bengaluru, Karnataka, India",
        "lat": "12.9989",
        "lon": "77.5928",
        "class": "historic",
        "type": "palace",
    }
    whitefield_result = {
        "display_name": "Whitefield, Bengaluru, Karnataka, India",
        "lat": "12.9698",
        "lon": "77.7499",
        "class": "boundary",
        "type": "village",
    }

    def fake(urlopen_call, *args, **kwargs):
        request = urlopen_call if hasattr(urlopen_call, "full_url") else (args[0] if args else kwargs.get("request"))
        query = request.full_url if hasattr(request, "full_url") else str(request)
        query_text = query.split("q=")[-1].split("&")[0]
        decoded = __import__("urllib.parse").parse.unquote_plus(query_text)

        if decoded.lower() in {"bengalore", "bangalore", "bengaluru"}:
            return json.dumps([city_result, business_result]).encode("utf-8")
        if decoded.lower() == "bengaluru airport":
            return json.dumps([airport_result, city_result]).encode("utf-8")
        if decoded.lower() == "bangalore palace":
            return json.dumps([palace_result, city_result]).encode("utf-8")
        if decoded.lower() == "whitefield":
            return json.dumps([whitefield_result, city_result]).encode("utf-8")
        return json.dumps([city_result]).encode("utf-8")

    class FakeResponse:
        def __init__(self, payload):
            self.payload = payload

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return self.payload

    monkeypatch.setattr("backend.api.NAVIGATION_BASE_URL", "https://nominatim.openstreetmap.org")
    monkeypatch.setattr("backend.api.urlopen", lambda *args, **kwargs: FakeResponse(fake(*args, **kwargs)))

    result = RealNavigationProvider().search("bengalore")
    assert result["success"] is True
    assert "Bengaluru" in result["destination"]
    assert "Tyre Service" not in result["destination"]

    result = RealNavigationProvider().search("bangalore")
    assert result["success"] is True
    assert "Bengaluru" in result["destination"]
    assert "Tyre Service" not in result["destination"]

    result = RealNavigationProvider().search("Bengaluru")
    assert result["success"] is True
    assert "Bengaluru" in result["destination"]

    result = RealNavigationProvider().search("Bangalore")
    assert result["success"] is True
    assert "Bengaluru" in result["destination"]

    result = RealNavigationProvider().search("Bengaluru airport")
    assert result["success"] is True
    assert "Airport" in result["destination"] or "airport" in result["destination"].lower()

    result = RealNavigationProvider().search("Bangalore Palace")
    assert result["success"] is True
    assert "Palace" in result["destination"] or "palace" in result["destination"].lower()

    result = RealNavigationProvider().search("Whitefield")
    assert result["success"] is True
    assert "Whitefield" in result["destination"] or "whitefield" in result["destination"].lower()


def test_navidrome_provider_search_and_play(monkeypatch):
    fake_payload = {
        "subsonic-response": {
            "status": "ok",
            "searchResult3": {
                "song": [{
                    "id": "42",
                    "title": "Bohemian Rhapsody",
                    "artist": "Queen",
                    "album": "A Night at the Opera",
                    "duration": 354,
                    "coverArt": "cover-42",
                    "genre": "Rock",
                }]
            },
        }
    }

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return json.dumps(fake_payload).encode("utf-8")

    monkeypatch.setattr("backend.api.NAVIDROME_URL", "http://127.0.0.1:4533")
    monkeypatch.setattr("backend.api.NAVIDROME_USERNAME", "demo-user")
    monkeypatch.setattr("backend.api.NAVIDROME_PASSWORD", "demo-pass")
    monkeypatch.setattr("backend.api.NAVIDROME_ENABLED", True)
    monkeypatch.setattr("backend.api.urlopen", lambda *args, **kwargs: FakeResponse())

    provider = NavidromeMusicProvider()
    tracks = provider.search("Bohemian Rhapsody")

    assert len(tracks) == 1
    assert tracks[0]["provider"] == "navidrome"
    assert tracks[0]["name"] == "Bohemian Rhapsody"
    assert tracks[0]["audio"].startswith("http://127.0.0.1:4533/rest/stream?")

    service = MusicService(provider)
    result = service.play("Bohemian Rhapsody")
    assert result["success"] is True
    assert result["track"]["artist"] == "Queen"
