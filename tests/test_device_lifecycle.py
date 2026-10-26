# =========================================================
# DEVICE LIFECYCLE / IDEMPOTENCY TESTS
# =========================================================
#
# These tests simulate the exact flow the product requires:
#
#   Add Glasses -> provision Wi-Fi -> transfer the existing credential
#   -> ESP32 registers against THAT device -> heartbeat -> ONLINE
#
# and then repeat it (retry, reload, re-poll, re-flash, concurrent clicks)
# to prove that a second device row is never created.
#
# The database is forced into a throw-away file *before* importing the app,
# so running the suite can never touch smartglasses.db.
# =========================================================

import os
import tempfile
from concurrent.futures import ThreadPoolExecutor

import pytest

_TMP_DIR = tempfile.mkdtemp(prefix="nexus-device-tests-")

os.environ["DATABASE_URL"] = f"sqlite:///{_TMP_DIR}/device-tests.db"
os.environ["DEVICE_TOKEN_PEPPER"] = "test-pepper-do-not-use-in-production"
os.environ["DEVICE_TOKEN_KEY"] = "test-key-do-not-use-in-production"
os.environ["DEVICE_HEARTBEAT_TIMEOUT_SECONDS"] = "30"

from fastapi.testclient import TestClient  # noqa: E402

from backend.api import app  # noqa: E402
from backend.database import Base, SessionLocal, engine  # noqa: E402
from backend.models import Device  # noqa: E402
from backend import device_api  # noqa: E402

HARDWARE_UID = "A0:B1:C2:03:04:05"
SSID = "SG-Network-5G"
PASSWORD = "super-secret-wifi"


@pytest.fixture(autouse=True)
def fresh_database():
    """Every test starts from an empty devices table."""

    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    device_api._pairing_failures.clear()
    yield


@pytest.fixture
def client():
    return TestClient(app)


# =========================================================
# HELPERS
# =========================================================

def device_count() -> int:
    with SessionLocal() as db:
        return db.query(Device).count()


def list_devices(client) -> dict:
    response = client.get("/api/devices")
    assert response.status_code == 200
    return response.json()


def raw_device(device_id: str) -> Device:
    with SessionLocal() as db:
        return db.query(Device).filter(Device.device_id == device_id).one()


def provision(client, **overrides) -> dict:
    payload = {
        "ssid": SSID,
        "password": PASSWORD,
        **overrides,
    }
    response = client.post("/api/device/provision", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def register(client, device_id: str, token: str, **overrides) -> tuple[int, dict]:
    payload = {
        "device_id": device_id,
        "device_token": token,
        "hardware_uid": HARDWARE_UID,
        "firmware": "1.0.0",
        "ip": "192.168.1.47",
        **overrides,
    }
    response = client.post("/api/device/register", json=payload)
    return response.status_code, (response.json() if response.content else {})


def heartbeat(client, device_id: str, token: str, **overrides) -> tuple[int, dict]:
    payload = {
        "device_id": device_id,
        "device_token": token,
        "ip": "192.168.1.47",
        "rssi": -52,
        "battery": 88,
        "uptime_ms": 12000,
        **overrides,
    }
    response = client.post("/api/device/heartbeat", json=payload)
    return response.status_code, (response.json() if response.content else {})


def esp32_full_setup(client, hardware_uid: str = HARDWARE_UID) -> dict:
    """What the real firmware does, end to end."""

    session = client.post("/api/device/session", json={"hardware_uid": hardware_uid})
    assert session.status_code == 200, session.text

    provisioned = provision(client, device_id=session.json()["device"]["device_id"],
                            hardware_uid=hardware_uid)

    device_id = provisioned["device"]["device_id"]
    token = provisioned["device_token"]

    credentials = client.post(
        "/api/device/provision/credentials",
        json={"device_id": device_id, "pairing_code": provisioned["pairing_code"]},
    )
    assert credentials.status_code == 200, credentials.text
    assert credentials.json()["device_token"] == token

    report = client.post(
        "/api/device/provision/report",
        json={
            "device_id": device_id,
            "device_token": token,
            "event": "wifi_connected",
            "ip": "192.168.1.47",
            "rssi": -52,
            "firmware": "1.0.0",
        },
    )
    assert report.status_code == 200, report.text

    status, registered = register(client, device_id, token)
    assert status == 200, registered

    status, beat = heartbeat(client, device_id, token)
    assert status == 200, beat

    return {
        "device_id": device_id,
        "device_token": token,
        "register": registered,
        "heartbeat": beat,
    }


# =========================================================
# THE REPORTED BUG: REPEATED SETUP MUST NOT CREATE DEVICES
# =========================================================

def test_setup_flow_creates_exactly_one_device_and_reuses_it(client):
    counts = {"before": device_count()}
    assert counts["before"] == 0

    first = esp32_full_setup(client)
    device_id, token = first["device_id"], first["device_token"]
    counts["first_setup"] = device_count()

    # Retry: the user runs the whole wizard again.
    retry_session = client.post("/api/device/session", json={})
    retry_provision = provision(client, device_id=device_id)
    counts["retry_setup"] = device_count()

    # Refresh / poll / HMR cycles from the frontend.
    for _ in range(25):
        list_devices(client)
        client.get("/api/device/provision/status", params={"device_id": device_id})
        client.post("/api/device/session", json={"device_id": device_id})
    counts["after_polling"] = device_count()

    # ESP32 registers and heartbeats again (reboot after a re-flash).
    again_status, again = register(client, device_id, token)
    beat_status, beat = heartbeat(client, device_id, token)
    counts["after_reconnect"] = device_count()

    listed = list_devices(client)

    assert counts == {
        "before": 0,
        "first_setup": 1,
        "retry_setup": 1,
        "after_polling": 1,
        "after_reconnect": 1,
    }

    # Same device id everywhere, and the same credential.
    assert retry_session.json()["device"]["device_id"] == device_id
    assert retry_provision["device"]["device_id"] == device_id
    assert retry_provision["device_token"] == token
    assert retry_provision["device_token_reused"] is True

    assert again_status == 200
    assert again["device_id"] == device_id
    assert again["already_registered"] is True

    assert beat_status == 200
    assert beat["device_id"] == device_id
    assert beat["status"] == "online"

    assert listed["count"] == 1
    assert [d["device_id"] for d in listed["devices"]] == [device_id]
    assert listed["devices"][0]["status"] == "online"
    assert listed["devices"][0]["registered"] is True


def test_provision_never_marks_the_device_online(client):
    """Success of /api/device/provision is not proof that the device is alive."""

    provisioned = provision(client)

    assert provisioned["device"]["status"] == "wifi_configuring"
    assert provisioned["device"]["status"] != "online"
    assert provisioned["device"]["online"] is False
    assert list_devices(client)["online_count"] == 0


def test_repeated_provision_attempts_reuse_device_and_token(client):
    first = provision(client)
    device_id = first["device"]["device_id"]
    token = first["device_token"]

    for _ in range(5):
        again = provision(client, device_id=device_id)

        assert again["device"]["device_id"] == device_id
        assert again["device_token"] == token
        assert again["device_token_reused"] is True
        assert again["created"] is False
        assert device_count() == 1

    raw = raw_device(device_id)

    assert raw.setup_attempts == 6
    assert raw.token_generation == 1  # the credential was minted once


def test_session_endpoint_is_find_or_create(client):
    first = client.post("/api/device/session", json={})
    second = client.post("/api/device/session", json={})

    assert first.status_code == second.status_code == 200
    assert first.json()["created"] is True
    assert second.json()["created"] is False
    assert first.json()["device"]["device_id"] == second.json()["device"]["device_id"]
    assert device_count() == 1


# =========================================================
# REGISTRATION / HEARTBEAT IDEMPOTENCY
# =========================================================

def test_registration_requires_the_token_and_never_inserts(client):
    provisioned = provision(client)
    device_id = provisioned["device"]["device_id"]
    token = provisioned["device_token"]

    status, body = register(client, device_id, "sgn_dev_not-the-token")
    assert status == 401
    assert device_count() == 1

    status, body = register(client, "SG-0000-0000", token)
    assert status == 404
    assert device_count() == 1

    status, first = register(client, device_id, token)
    assert status == 200
    assert first["status"] == "registered"
    assert first["already_registered"] is False
    assert first["registration"]["device_token_reused"] is True

    status, second = register(client, device_id, token)
    assert status == 200
    assert second["already_registered"] is True
    assert second["device_id"] == device_id
    assert device_count() == 1

    # Re-registering while online keeps the device online (no demotion).
    heartbeat(client, device_id, token)
    status, third = register(client, device_id, token)

    assert status == 200
    assert third["status"] == "online"
    assert device_count() == 1


def test_heartbeat_updates_the_existing_device_only(client):
    provisioned = provision(client)
    device_id = provisioned["device"]["device_id"]
    token = provisioned["device_token"]

    # Not registered yet: heartbeat must not flip it online.
    status, body = heartbeat(client, device_id, token)
    assert status == 409
    assert device_count() == 1

    register(client, device_id, token)

    for expected in range(1, 6):
        status, body = heartbeat(client, device_id, token)

        assert status == 200
        assert body["device_id"] == device_id
        assert body["status"] == "online"
        assert body["heartbeat"]["count"] == expected

    assert device_count() == 1

    raw = raw_device(device_id)

    assert raw.heartbeat_count == 5
    assert raw.status == "online"
    assert raw.ip_address == "192.168.1.47"
    assert raw.battery == 88


def test_stale_device_goes_offline_then_recovers_on_the_same_row(client):
    setup = esp32_full_setup(client)
    device_id, token = setup["device_id"], setup["device_token"]

    # Pretend the heartbeat is old.
    with SessionLocal() as db:
        device = db.query(Device).filter(Device.device_id == device_id).one()
        device.last_heartbeat_at = device.last_heartbeat_at.replace(year=2020)
        db.commit()

    listed = list_devices(client)

    assert listed["count"] == 1
    assert listed["devices"][0]["status"] == "offline"
    assert listed["online_count"] == 0

    status, body = heartbeat(client, device_id, token)

    assert status == 200
    assert body["status"] == "online"
    assert device_count() == 1


# =========================================================
# IDENTITY: THE HARDWARE UID AND THE MINTED TOKEN
# =========================================================

def test_hardware_uid_is_the_identity_after_an_nvs_wipe(client):
    """A re-flashed ESP32 (no stored device_id) must land on its own device."""

    setup = esp32_full_setup(client)
    original_id = setup["device_id"]

    # The board lost its NVS blob: it only knows its chip id now.
    recovered = client.post("/api/device/session", json={"hardware_uid": HARDWARE_UID})

    assert recovered.status_code == 200
    assert recovered.json()["created"] is False
    assert recovered.json()["device"]["device_id"] == original_id
    assert device_count() == 1

    status, replayed = register(client, original_id, setup["device_token"])

    assert status == 200
    assert replayed["already_registered"] is True
    assert device_count() == 1


def test_second_hardware_uid_cannot_hijack_an_existing_device(client):
    setup = esp32_full_setup(client)

    status, body = register(
        client,
        setup["device_id"],
        setup["device_token"],
        hardware_uid="FF:FF:FF:FF:FF:FF",
    )

    assert status == 409
    assert device_count() == 1


def test_restart_setup_keeps_the_same_row_and_token(client):
    setup = esp32_full_setup(client)
    device_id, token = setup["device_id"], setup["device_token"]

    restarted = client.post(f"/api/devices/{device_id}/setup")

    assert restarted.status_code == 200
    assert restarted.json()["device"]["status"] == "awaiting_setup"
    assert restarted.json()["device"]["device_id"] == device_id
    assert restarted.json()["credentials_preserved"] is True

    reprovisioned = provision(client, device_id=device_id)

    assert reprovisioned["device_token"] == token
    assert reprovisioned["device_token_reused"] is True

    register(client, device_id, token)
    heartbeat(client, device_id, token)

    assert device_count() == 1
    assert list_devices(client)["devices"][0]["status"] == "online"


# =========================================================
# PAIRING CODE
# =========================================================

def test_pairing_code_is_single_purpose_and_dies_after_registration(client):
    provisioned = provision(client)
    device_id = provisioned["device"]["device_id"]
    token = provisioned["device_token"]
    code = provisioned["pairing_code"]

    assert code and len(code) == 9

    wrong = client.post(
        "/api/device/provision/credentials",
        json={"device_id": device_id, "pairing_code": "ZZZZ-ZZZZ"},
    )
    assert wrong.status_code == 401
    assert device_count() == 1

    right = client.post(
        "/api/device/provision/credentials",
        json={"device_id": device_id, "pairing_code": code},
    )
    assert right.status_code == 200
    assert right.json()["device_token"] == token
    assert right.json()["wifi"]["ssid"] == SSID
    assert right.json()["wifi"]["password"] == PASSWORD

    register(client, device_id, token)

    reused = client.post(
        "/api/device/provision/credentials",
        json={"device_id": device_id, "pairing_code": code},
    )
    assert reused.status_code == 401


def test_provision_status_poll_never_leaks_credentials(client):
    provisioned = provision(client)
    body = client.get("/api/device/provision/status").json()

    serialized = str(body)

    assert provisioned["device_token"] not in serialized
    assert PASSWORD not in serialized
    assert body["device"]["device_token_last4"] == provisioned["device_token"][-4:]


# =========================================================
# CONCURRENCY
# =========================================================

def test_concurrent_setup_requests_create_one_device(client):
    """Double clicks / parallel tabs must not race into two rows."""

    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(
            pool.map(
                lambda _: client.post("/api/device/session", json={}),
                range(12),
            )
        )

    assert all(r.status_code == 200 for r in results)
    assert device_count() == 1

    ids = {r.json()["device"]["device_id"] for r in results}
    assert len(ids) == 1

    # Same for provisioning: one token, one row.
    with ThreadPoolExecutor(max_workers=6) as pool:
        propos = list(
            pool.map(
                lambda _: client.post(
                    "/api/device/provision",
                    json={"ssid": SSID, "password": PASSWORD},
                ),
                range(12),
            )
        )

    assert all(r.status_code == 200 for r in propos)
    assert device_count() == 1

    tokens = {r.json()["device_token"] for r in propos}
    assert len(tokens) == 1


# =========================================================
# FINAL REPORT TABLE
# =========================================================

def test_report_table_matches_expected_result(client):
    """The table from the bug report, asserted verbatim."""

    before = device_count()

    first = esp32_full_setup(client)
    after_first = device_count()

    retry = esp32_full_setup(client)
    after_retry = device_count()

    listed = list_devices(client)
    final = listed["devices"][0]

    assert (before, after_first, after_retry) == (0, 1, 1)
    assert first["device_id"] == retry["device_id"] == final["device_id"]
    assert first["device_token"] == retry["device_token"]
    assert retry["register"]["already_registered"] is True
    assert retry["heartbeat"]["status"] == "online"
    assert final["status"] == "online"


# =========================================================
# ZERO-INPUT CLAIM FLOW (physical ESP32 path)
# =========================================================
#
# This is what firmware/camera/camera.ino does on a fresh board. The user
# types only a Wi-Fi SSID + password; the device obtains its credential
# through announcement + approval.

CLAIM_SECRET = "0123456789abcdef0123456789abcdef"


def announce(client, hardware_uid: str = HARDWARE_UID, secret: str = CLAIM_SECRET) -> dict:
    response = client.post(
        "/api/device/claim",
        json={
            "hardware_uid": hardware_uid,
            "claim_secret": secret,
            "firmware": "1.0.0",
            "model": "ESP32-CAM",
            "ap_ssid": "VisionaryNexus-030405",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def poll_claim(client, claim_id: str, secret: str = CLAIM_SECRET) -> tuple[int, dict]:
    response = client.post(
        "/api/device/claim/poll",
        json={"claim_id": claim_id, "claim_secret": secret},
    )
    return response.status_code, (response.json() if response.content else {})


def test_zero_input_claim_flow_end_to_end(client):
    """SSID/password only: announce -> approve -> credential -> register -> heartbeat."""

    # The app reserves the single setup session (no device created yet).
    session = client.post("/api/device/session", json={}).json()
    device_id = session["device"]["device_id"]

    # The board is on Wi-Fi now and announces itself with its chip id.
    announced = announce(client)

    assert announced["claim_state"] == "pending_approval"
    assert announced["reused"] is True
    assert announced["device_id"] == device_id
    assert device_count() == 1

    # The credential is NOT handed out before human approval.
    status, pending = poll_claim(client, announced["claim_id"])

    assert status == 200
    assert pending["claim_state"] == "pending_approval"
    assert "device_token" not in pending

    # The app sees the device waiting for approval and the user approves it.
    listed = list_devices(client)

    assert listed["count"] == 1
    assert listed["devices"][0]["awaiting_approval"] is True
    assert listed["devices"][0]["hardware_uid"] == HARDWARE_UID

    approved = client.post(
        f"/api/devices/{device_id}/claim/approve",
        json={"claim_id": announced["claim_id"], "device": {"token_first": True}},
    )

    assert approved.status_code == 200
    assert approved.json()["claim_state"] == "approved"

    # The device collects its credential.
    status, delivered = poll_claim(client, announced["claim_id"])

    assert status == 200, delivered
    token = delivered["device_token"]
    assert delivered["claim_state"] == "delivered"
    assert delivered["device_id"] == device_id
    assert delivered["backend_url"].startswith("http")
    assert token.startswith("sgn_dev_")

    # Register + heartbeat with the delivered credential, header form first.
    register_response = client.post(
        "/api/device/register",
        json={"device_id": device_id, "hardware_uid": HARDWARE_UID, "firmware": "1.0.0"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert register_response.status_code == 200, register_response.text
    assert register_response.json()["status"] == "registered"
    assert register_response.json()["already_registered"] is False

    heartbeat_response = client.post(
        "/api/device/heartbeat",
        json={"device_id": device_id, "ip": "192.168.1.47", "rssi": -48},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert heartbeat_response.status_code == 200, heartbeat_response.text
    assert heartbeat_response.json()["status"] == "online"
    assert heartbeat_response.json()["device_id"] == device_id
    assert device_count() == 1


def test_claim_flow_is_idempotent_across_retries_and_reboots(client):
    """A rebooting / retrying board never produces a second device."""

    first_session = client.post("/api/device/session", json={}).json()
    device_id = first_session["device"]["device_id"]

    first_claim = announce(client)

    # The board reboots before the user approves: same claim, same row.
    second_claim = announce(client)

    assert second_claim["claim_id"] == first_claim["claim_id"]
    assert second_claim["device_id"] == device_id
    assert device_count() == 1

    client.post(f"/api/devices/{device_id}/claim/approve", json={})

    _, delivered = poll_claim(client, first_claim["claim_id"])
    token = delivered["device_token"]

    # Poll again (the board may have missed the response).
    status, again = poll_claim(client, first_claim["claim_id"])

    assert status == 200
    assert again.get("device_token", token) == token

    # Reboot with NVS intact: re-announce, re-register, heartbeat.
    for _ in range(3):
        announce(client)
        client.post(
            "/api/device/register",
            json={"device_id": device_id, "hardware_uid": HARDWARE_UID},
            headers={"Authorization": f"Bearer {token}"},
        )
        client.post(
            "/api/device/heartbeat",
            json={"device_id": device_id},
            headers={"Authorization": f"Bearer {token}"},
        )

    assert device_count() == 1

    final = list_devices(client)

    assert final["count"] == 1
    assert final["devices"][0]["device_id"] == device_id
    assert final["devices"][0]["status"] == "online"


def test_claim_requires_the_device_generated_secret(client):
    announced = announce(client)
    device_id = announced["device_id"]

    status, body = poll_claim(client, announced["claim_id"], secret="f" * 32)

    assert status == 401
    assert device_count() == 1

    # A board that does not have the pending claim cannot approve itself.
    client.post(f"/api/devices/{device_id}/claim/approve", json={})

    status, _ = poll_claim(client, "clm_does-not-exist")
    assert status == 404
    assert device_count() == 1


def test_rejected_claim_keeps_the_device_row(client):
    announced = announce(client)
    device_id = announced["device_id"]

    rejected = client.post(f"/api/devices/{device_id}/claim/reject", json={})

    assert rejected.status_code == 200
    assert rejected.json()["claim_state"] == "rejected"
    assert device_count() == 1

    status, body = poll_claim(client, announced["claim_id"])

    assert status == 200
    assert body["claim_state"] == "rejected"

    # The same device can be set up again - as the same device.
    re_announced = announce(client)

    assert re_announced["device_id"] == device_id
    assert re_announced["claim_state"] == "pending_approval"
    assert device_count() == 1


def test_backend_info_advertises_lan_urls_without_user_input(client):
    info = client.get("/api/device/backend-info").json()

    assert info["urls"]
    assert info["preferred"].startswith("http")
    assert isinstance(info["port"], int)


def test_claim_never_creates_a_second_device_for_the_same_hardware(client):
    announce(client)
    announce(client)
    announce(client)

    assert device_count() == 1


# =========================================================
# CAMERA READINESS (must come from the sensor, not from Wi-Fi)
# =========================================================

def test_camera_ready_only_after_the_device_reports_it(client):
    setup = esp32_full_setup(client)
    device_id, token = setup["device_id"], setup["device_token"]

    # Online, registered - but the camera has NOT been initialised yet.
    before = list_devices(client)["devices"][0]

    assert before["status"] == "online"
    assert before["camera_ready"] is False
    assert before["camera_sensor"] is None

    response = client.post(
        "/api/device/provision/report",
        json={
            "device_id": device_id,
            "event": "camera_ready",
            "sensor": "0x26",
            "psram": True,
        },
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200, response.text

    after = list_devices(client)["devices"][0]

    assert after["camera_ready"] is True
    assert after["camera_sensor"] == "0x26"
    assert after["status"] == "online"       # camera readiness never alters the lifecycle
    assert device_count() == 1


def test_camera_failure_is_reported_without_going_online(client):
    provisioned = provision(client)
    device_id = provisioned["device"]["device_id"]
    token = provisioned["device_token"]

    client.post(
        "/api/device/register",
        json={"device_id": device_id, "hardware_uid": HARDWARE_UID},
        headers={"Authorization": f"Bearer {token}"},
    )

    failed = client.post(
        "/api/device/provision/report",
        json={"device_id": device_id, "event": "camera_failed", "error": "OV2640 did not initialise"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert failed.status_code == 200

    device = list_devices(client)["devices"][0]

    assert device["camera_ready"] is False
    assert device_count() == 1
