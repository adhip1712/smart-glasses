import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend import api, voice
from backend import security
from backend.models import Base, CommandLog, DeviceRecord, Notification, Setting


@pytest.fixture
def feature_database(monkeypatch):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    sessions = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    monkeypatch.setattr(api, "SessionLocal", sessions)
    yield sessions
    Base.metadata.drop_all(bind=engine)
    engine.dispose()


@pytest.fixture
def client():
    return TestClient(api.app)


# --------------------------------------------------------------------------- #
# Authentication
# --------------------------------------------------------------------------- #

def test_register_login_and_me(client, feature_database):
    registration = client.post(
        "/api/auth/register",
        json={"email": "Nexus@Example.com", "password": "glasses-pass", "display_name": "Nexus"},
    )
    assert registration.status_code == 200
    payload = registration.json()
    assert payload["success"] is True
    assert payload["token"]
    assert payload["user"]["email"] == "nexus@example.com"
    assert "password" not in registration.text
    assert "password_hash" not in registration.text

    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {payload['token']}"})
    assert me.status_code == 200
    assert me.json()["user"]["email"] == "nexus@example.com"

    login = client.post("/api/auth/login", json={"email": "nexus@example.com", "password": "glasses-pass"})
    assert login.status_code == 200
    assert login.json()["token"]

    wrong = client.post("/api/auth/login", json={"email": "nexus@example.com", "password": "wrong-password"})
    assert wrong.status_code == 401

    duplicate = client.post(
        "/api/auth/register",
        json={"email": "nexus@example.com", "password": "another-pass"},
    )
    assert duplicate.status_code == 409

    assert client.get("/api/auth/me").status_code == 401
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer not-a-token"}).status_code == 401


def test_passwords_are_hashed_not_stored(feature_database):
    stored = security.hash_password("glasses-pass")
    assert stored != "glasses-pass"
    assert stored.startswith("pbkdf2_sha256$")
    assert security.verify_password("glasses-pass", stored)
    assert not security.verify_password("nope", stored)
    assert not security.verify_password("glasses-pass", "corrupted")


def test_short_password_is_rejected(client, feature_database):
    response = client.post("/api/auth/register", json={"email": "a@b.co", "password": "short"})
    assert response.status_code == 422


# --------------------------------------------------------------------------- #
# Settings
# --------------------------------------------------------------------------- #

def test_settings_defaults_are_persisted_per_user(client, feature_database):
    defaults = client.get("/api/settings").json()["settings"]
    assert defaults["wake_phrase"] == "Hey Vision"
    assert defaults["ai_provider"] in {"auto", "openai", "groq"}

    updated = client.put("/api/settings", json={"settings": {"weather_city": "Delhi", "speaker_volume": 40}})
    assert updated.status_code == 200
    assert updated.json()["settings"]["weather_city"] == "Delhi"

    again = client.get("/api/settings").json()["settings"]
    assert again["weather_city"] == "Delhi"
    assert again["speaker_volume"] == 40
    assert again["wake_phrase"] == "Hey Vision"

    rejected = client.put("/api/settings", json={"settings": {"not_a_setting": 1}})
    assert rejected.status_code == 422


# --------------------------------------------------------------------------- #
# Notifications
# --------------------------------------------------------------------------- #

def test_notifications_crud_and_read_state(client, feature_database):
    created = client.post("/api/notifications", json={"title": "Camera paired", "kind": "device"})
    assert created.status_code == 200
    notification_id = created.json()["notification"]["id"]

    listing = client.get("/api/notifications").json()
    assert listing["total"] == 1
    assert listing["unread"] == 1

    client.post(f"/api/notifications/{notification_id}/read")
    listing = client.get("/api/notifications").json()
    assert listing["unread"] == 0

    client.post("/api/notifications", json={"title": "Second"})
    client.post("/api/notifications/read-all")
    assert client.get("/api/notifications").json()["unread"] == 0

    assert client.delete(f"/api/notifications/{notification_id}").status_code == 200
    assert client.get("/api/notifications").json()["total"] == 1
    assert client.delete("/api/notifications/99999").status_code == 404


# --------------------------------------------------------------------------- #
# Command history
# --------------------------------------------------------------------------- #

def test_ask_records_command_history(client, feature_database):
    response = client.post("/api/ask", json={"message": "pause music", "conversation_id": 1})
    assert response.status_code == 200
    assert response.json()["intent"] == "music_pause"

    recent = client.get("/api/commands/recent").json()["commands"]
    assert recent
    assert recent[0]["message"] == "pause music"
    assert recent[0]["intent"] == "music_pause"
    assert recent[0]["response"]


# --------------------------------------------------------------------------- #
# Device heartbeat / camera devices
# --------------------------------------------------------------------------- #

def _pair_device(client, device_id="VN-AAAA1111"):
    provisioning = client.post("/api/device/provision", json={"device_id": device_id}).json()
    registration = client.post(
        "/api/device/register",
        json={
            "device_id": device_id,
            "firmware_version": "1.0.0",
            "ip_address": "192.168.1.77",
            "connection_status": "connected",
            "provisioning_status": "provisioned",
            "camera_status": "ready",
            "sensor": "OV3660",
        },
        headers={"Authorization": f"Bearer {provisioning['provisioning_ticket']}"},
    ).json()
    return provisioning, registration


def test_heartbeat_requires_device_token_and_updates_last_seen(client, feature_database):
    _, registration = _pair_device(client)
    device_token = registration["device_token"]

    missing = client.post("/api/device/heartbeat", json={"device_id": "VN-AAAA1111"})
    assert missing.status_code == 401

    invalid = client.post(
        "/api/device/heartbeat",
        json={"device_id": "VN-AAAA1111"},
        headers={"Authorization": "Bearer wrong"},
    )
    assert invalid.status_code == 401

    beat = client.post(
        "/api/camera/heartbeat",
        json={"device_id": "VN-AAAA1111", "camera_status": "ready", "sensor": "OV3660"},
        headers={"Authorization": f"Bearer {device_token}"},
    )
    assert beat.status_code == 200
    assert beat.json()["success"] is True
    assert beat.json()["sensor"] == "OV3660"

    devices = client.get("/api/camera/devices").json()["devices"]
    assert devices[0]["device_id"] == "VN-AAAA1111"
    assert devices[0]["sensor"] == "OV3660"
    assert devices[0]["camera_ready"] is True


def test_camera_status_reports_registered_sensor(client, feature_database):
    _pair_device(client)
    status = client.get("/api/camera/status").json()
    assert status["connected"] is True
    assert status["sensor"] == "OV3660"
    assert status["provider"] == "esp32"


# --------------------------------------------------------------------------- #
# Wake phrase
# --------------------------------------------------------------------------- #

def test_wake_phrase_is_hey_vision(client, feature_database):
    assert client.post("/api/wake", json={"phrase": "hey vision"}).json()["detected"] is True
    assert client.post("/api/wake", json={"phrase": "Hey Vision, what's the weather?"}).json()["detected"] is True
    assert client.post("/api/wake", json={"phrase": "hey orion"}).json()["detected"] is False
    assert voice.detect_wake_phrase("hey visionary") is True
    assert voice.detect_wake_phrase("") is False


# --------------------------------------------------------------------------- #
# Voice + vision fallbacks
# --------------------------------------------------------------------------- #

def test_voice_status_and_unavailable_fallbacks(client, feature_database, monkeypatch):
    for key in ("OPENAI_API_KEY", "GROQ_API_KEY", "VOICE_STT_PROVIDER", "VOICE_TTS_PROVIDER"):
        monkeypatch.delenv(key, raising=False)

    status = client.get("/api/voice/status").json()
    assert status["success"] is True
    assert status["wake_phrase"] == "Hey Vision"
    assert status["stt"] == "unavailable"

    tts = client.post("/api/voice/tts", json={"text": "hello"}).json()
    assert tts["success"] is False
    assert "OPENAI_API_KEY" in tts["message"]

    empty = client.post("/api/voice/tts", json={"text": "   "}).json()
    assert empty["success"] is False

    missing = client.post("/api/voice/tts", json={})
    assert missing.status_code == 422


def test_vision_ocr_without_camera_explains_what_is_missing(client, feature_database, monkeypatch):
    monkeypatch.delenv("CAMERA_STREAM_URL", raising=False)
    result = client.post("/api/vision/ocr", json={}).json()
    assert result["success"] is False
    assert result["engine"] == "unavailable"
    assert "camera" in result["message"].lower()


def test_ask_read_this_routes_to_ocr(client, feature_database, monkeypatch):
    monkeypatch.delenv("CAMERA_STREAM_URL", raising=False)
    response = client.post("/api/ask", json={"message": "read this", "conversation_id": 1}).json()
    assert response["intent"] == "camera_vision"
    assert response["available"] is False
    assert "camera" in response["response"].lower()


# --------------------------------------------------------------------------- #
# CORS
# --------------------------------------------------------------------------- #

def test_cors_allows_local_frontend_origins(client, feature_database):
    preflight = client.options(
        "/api/health",
        headers={
            "Origin": "http://192.168.1.77:8443",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert preflight.status_code == 200
    assert preflight.headers.get("access-control-allow-origin") == "http://192.168.1.77:8443"

    blocked = client.options(
        "/api/health",
        headers={
            "Origin": "https://evil.example.com",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert blocked.headers.get("access-control-allow-origin") is None


# --------------------------------------------------------------------------- #
# AI provider selection
# --------------------------------------------------------------------------- #

def test_openai_provider_is_primary_when_key_is_configured(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    provider, name = api._select_ai_provider()
    assert name == "OpenAI"
    assert provider.api_key == "sk-test"

    monkeypatch.setenv("AI_PROVIDER", "groq")
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    provider, name = api._select_ai_provider()
    assert provider is None and name is None


def test_openai_provider_uses_injected_client():
    class Message:
        content = "  openai says hi  "

    class Choice:
        message = Message()

    class Completion:
        choices = [Choice()]

    class Completions:
        def create(self, **_kwargs):
            return Completion()

    class Client:
        chat = type("Chat", (), {"completions": Completions()})()

    from backend.ai_providers import OpenAIProvider

    provider = OpenAIProvider(api_key="sk-test", client=Client())
    text = provider.complete(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "hi"}],
        temperature=0.0,
        max_completion_tokens=16,
    )
    assert text == "openai says hi"


def test_chat_model_follows_active_provider(monkeypatch):
    monkeypatch.setattr(api, "ai_provider_name", "OpenAI")
    monkeypatch.setattr(api, "OPENAI_MODEL", "gpt-4o")
    assert api.chat_model() == "gpt-4o"

    monkeypatch.setattr(api, "ai_provider_name", "Groq")
    assert api.chat_model() == api.GROQ_TEXT_MODEL
