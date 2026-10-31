from fastapi.testclient import TestClient

from backend.api import app, DEFAULT_APP_SETTINGS


def test_default_wake_word_is_vision():
    assert DEFAULT_APP_SETTINGS["wake_word"] == "Vision"
    assert DEFAULT_APP_SETTINGS["wake_word_sensitivity"] == "high"


def test_custom_wake_word_endpoint_matches_multiword_phrase_and_boundaries():
    client = TestClient(app)
    settings = client.put("/api/settings", json={"wake_word": "Hello Blue Planet", "wake_word_sensitivity": "high", "wake_word_source": "auto"})
    assert settings.status_code == 200, settings.text
    assert settings.json()["wake_word"] == "Hello Blue Planet"
    matched = client.post("/api/wake", json={"phrase": "Hey there, hello blue planet, play music"})
    assert matched.status_code == 200, matched.text
    assert matched.json()["detected"] is True
    not_matched = client.post("/api/wake", json={"phrase": "the word helloblueplanet is written here"})
    assert not_matched.status_code == 200, not_matched.text
    assert not_matched.json()["detected"] is False


def test_custom_wake_word_settings_validation():
    client = TestClient(app)
    assert client.put("/api/settings", json={"wake_word": "x" * 101}).status_code == 422
    assert client.put("/api/settings", json={"wake_word": "Orbit", "wake_word_sensitivity": "extreme"}).status_code == 422
