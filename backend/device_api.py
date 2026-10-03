# =========================================================
# VISIONARY NEXUS - DEVICE LIFECYCLE API
# =========================================================
#
# Provisioning, registration and heartbeat for the glasses.
#
# The whole module is written around one invariant:
#
#     ONE PHYSICAL DEVICE == ONE ROW IN `devices`
#
# Every entry point is find-or-update, never "insert another one":
#
#   POST /api/device/session             find-or-create the single setup session
#   POST /api/device/provision           reuse that session, queue Wi-Fi credentials,
#                                        hand back the EXISTING device token
#   GET  /api/device/provision/status    read-only poll (never creates, never returns secrets)
#   POST /api/device/provision/credentials
#                                        device-side pickup of the token + Wi-Fi credentials
#                                        using the short lived pairing code
#   POST /api/device/provision/report    ESP32 reports wifi_connected / *_failed
#   POST /api/device/register            idempotent registration of the EXISTING device
#   POST /api/device/heartbeat           updates the EXISTING device to `online`
#   GET  /api/devices                    list (the "Registered Devices" section)
#   GET  /api/devices/{device_id}        single device
#   POST /api/devices/{device_id}/setup  restart setup on the SAME device row
#
# Lifecycle (see docs/device-lifecycle.md):
#
#   awaiting_setup -> wifi_configuring -> connecting -> awaiting_registration
#                  -> registered -> online
#
#   failure states: wifi_failed, pairing_failed, registration_failed,
#                   camera_failed, offline
#
# `/api/device/provision` NEVER marks a device online. Only a heartbeat from
# a registered device does that.
# =========================================================

from __future__ import annotations

import os
import secrets as _secrets
import threading
from datetime import datetime, timedelta
from enum import Enum
from typing import Any, Iterator, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

try:
    from backend import security
    from backend.database import get_db
    from backend.models import Device
except ImportError:  # pragma: no cover - allows `python backend/api.py`
    import security
    from database import get_db
    from models import Device


# =========================================================
# CONFIGURATION
# =========================================================

HEARTBEAT_INTERVAL_SECONDS = int(
    os.getenv("DEVICE_HEARTBEAT_INTERVAL_SECONDS", "10")
)

# A device that stops sending heartbeats for this long is reported as
# `offline` (lazily, on read) - the row itself is never duplicated.
HEARTBEAT_TIMEOUT_SECONDS = int(
    os.getenv("DEVICE_HEARTBEAT_TIMEOUT_SECONDS", "30")
)

MAX_PAIRING_CODE_FAILURES = int(
    os.getenv("DEVICE_PAIRING_CODE_MAX_FAILURES", "10")
)

# Every lifecycle transition is a read-modify-write on the device row
# (status, attempts, token, pairing code). Serialising them in-process keeps
# double clicks, parallel tabs and a chatty firmware from interleaving:
# e.g. two concurrent /provision calls must never both mint a token.
#
# A plain Lock (not RLock) is used deliberately: FastAPI may run the setup and
# the teardown of a yield-dependency in different threadpool threads, and
# threading.RLock refuses to be released by a thread that did not acquire it
# ("cannot release un-acquired lock"). Lock has no thread affinity, so the
# release always succeeds.
_WRITE_LOCK = threading.Lock()


def _serialize_device_writes() -> Iterator[None]:
    """Dependency that serialises device lifecycle mutations."""

    with _WRITE_LOCK:
        yield


# =========================================================
# LIFECYCLE
# =========================================================

class DeviceStatus(str, Enum):
    AWAITING_SETUP = "awaiting_setup"
    WIFI_CONFIGURING = "wifi_configuring"
    CONNECTING = "connecting"
    AWAITING_REGISTRATION = "awaiting_registration"
    REGISTERED = "registered"
    ONLINE = "online"

    WIFI_FAILED = "wifi_failed"
    PAIRING_FAILED = "pairing_failed"
    REGISTRATION_FAILED = "registration_failed"
    CAMERA_FAILED = "camera_failed"
    OFFLINE = "offline"


# States in which the device is still being set up. While a device is in one
# of these states it owns the single "pending setup slot" (see Device.setup_slot),
# which is what makes duplicate rows impossible.
SETUP_STATES = {
    DeviceStatus.AWAITING_SETUP.value,
    DeviceStatus.WIFI_CONFIGURING.value,
    DeviceStatus.CONNECTING.value,
    DeviceStatus.AWAITING_REGISTRATION.value,
    DeviceStatus.WIFI_FAILED.value,
    DeviceStatus.PAIRING_FAILED.value,
    DeviceStatus.REGISTRATION_FAILED.value,
    DeviceStatus.CAMERA_FAILED.value,
}

# Happy path order, used both for documentation and for the UI progress bar.
HAPPY_PATH = [
    DeviceStatus.AWAITING_SETUP.value,
    DeviceStatus.WIFI_CONFIGURING.value,
    DeviceStatus.CONNECTING.value,
    DeviceStatus.AWAITING_REGISTRATION.value,
    DeviceStatus.REGISTERED.value,
    DeviceStatus.ONLINE.value,
]

FAILURE_STATES = {
    DeviceStatus.WIFI_FAILED.value,
    DeviceStatus.PAIRING_FAILED.value,
    DeviceStatus.REGISTRATION_FAILED.value,
    DeviceStatus.CAMERA_FAILED.value,
    DeviceStatus.OFFLINE.value,
}


def _log_transition(device: Device, previous: str, reason: str) -> None:

    if previous == device.status:
        return

    print(
        f"[device] {device.device_id} {previous} -> {device.status} ({reason})"
    )


def _set_status(
    device: Device,
    new_status: str,
    *,
    detail: str | None = None,
    error: str | None = None,
    clear_error: bool = False,
) -> None:
    """Move a device through the lifecycle without ever touching its identity.

    The `device_id`, `hardware_uid` and device token are deliberately not
    modified here - state changes must never imply a new device.
    """

    previous = device.status
    device.status = new_status

    if new_status in SETUP_STATES:
        device.setup_slot = "pending"
    elif new_status in (
        DeviceStatus.REGISTERED.value,
        DeviceStatus.ONLINE.value,
        DeviceStatus.OFFLINE.value,
    ):
        device.setup_slot = None

    if detail is not None:
        device.status_detail = detail

    if error is not None:
        device.last_error = error
    elif clear_error:
        device.last_error = None

    _log_transition(device, previous, detail or "state change")


# =========================================================
# SERIALIZATION
# =========================================================

def _iso(moment: datetime | None) -> str | None:

    return moment.isoformat() if moment else None


def device_public(device: Device, now: datetime | None = None) -> dict[str, Any]:
    """Everything the frontend may see. Never contains credentials."""

    now = now or security.utcnow()
    code_active = bool(
        device.pairing_code_hash
        and not security.is_expired(device.pairing_code_expires_at, now)
    )

    return {
        "id": device.id,
        "device_id": device.device_id,
        "hardware_uid": device.hardware_uid,
        "name": device.name,
        "model": device.model,
        "firmware": device.firmware,

        "status": device.status,
        "status_detail": device.status_detail,
        "last_error": device.last_error,
        "is_setup_pending": device.status in SETUP_STATES,
        "is_failure": device.status in FAILURE_STATES,
        "registered": bool(device.registered),
        "online": device.status == DeviceStatus.ONLINE.value,

        "setup_slot": device.setup_slot,
        "setup_attempts": device.setup_attempts,
        "registration_count": device.registration_count,
        "heartbeat_count": device.heartbeat_count,

        "created_at": _iso(device.created_at),
        "updated_at": _iso(device.updated_at),
        "session_started_at": _iso(device.session_started_at),
        "provisioned_at": _iso(device.provisioned_at),
        "wifi_configured_at": _iso(device.wifi_configured_at),
        "credentials_collected_at": _iso(device.credentials_collected_at),
        "registered_at": _iso(device.registered_at),
        "last_heartbeat_at": _iso(device.last_heartbeat_at),
        "last_seen_at": _iso(device.last_seen_at),

        "wifi_ssid": device.wifi_ssid,
        "ip_address": device.ip_address,
        "rssi": device.rssi,
        "battery": device.battery,
        "temperature": device.temperature,
        "uptime_ms": device.uptime_ms,

        # Credential metadata only - the values themselves never leave the
        # backend except through the pairing-code handshake.
        "has_device_token": bool(device.device_token_hash),
        "device_token_last4": device.device_token_last4,
        "token_generation": device.token_generation,
        "pairing_code_expires_at": _iso(device.pairing_code_expires_at),
        "pairing_code_active": code_active,
        "has_pairing_credential": bool(device.pairing_credential_hash),

        # Camera: true only after a successful OV2640 initialisation.
        "camera_ready": bool(device.camera_ready),
        "camera_sensor": device.camera_sensor,
        "camera_initialized_at": _iso(device.camera_initialized_at),

        # Zero-input claim flow (device announces itself, user approves).
        "claim_state": device.claim_state,
        "claim_id": device.claim_id,
        "claim_requested_at": _iso(device.claim_requested_at),
        "claim_approved_at": _iso(device.claim_approved_at),
        "awaiting_approval": device.claim_state == "pending_approval",
    }


def device_summary(device: Device, now: datetime | None = None) -> dict[str, Any]:
    """Compact representation for the Registered Devices list."""

    now = now or security.utcnow()
    last_heartbeat = device.last_heartbeat_at
    age = (
        int((now - last_heartbeat).total_seconds())
        if last_heartbeat
        else None
    )

    return {
        "id": device.id,
        "device_id": device.device_id,
        "hardware_uid": device.hardware_uid,
        "name": device.name,
        "model": device.model,
        "firmware": device.firmware,
        "status": device.status,
        "status_detail": device.status_detail,
        "registered": bool(device.registered),
        "online": device.status == DeviceStatus.ONLINE.value,
        "created_at": _iso(device.created_at),
        "registered_at": _iso(device.registered_at),
        "last_heartbeat_at": _iso(last_heartbeat),
        "heartbeat_age_seconds": age,
        "ip_address": device.ip_address,
        "wifi_ssid": device.wifi_ssid,
        "rssi": device.rssi,
        "battery": device.battery,
        "temperature": device.temperature,
        "registration_count": device.registration_count,
        "heartbeat_count": device.heartbeat_count,
        "setup_attempts": device.setup_attempts,
        "is_setup_pending": device.status in SETUP_STATES,
        "device_token_last4": device.device_token_last4,
        "claim_state": device.claim_state,
        "awaiting_approval": device.claim_state == "pending_approval",
        "camera_ready": bool(device.camera_ready),
        "camera_sensor": device.camera_sensor,
    }


# =========================================================
# QUERIES
# =========================================================

def _all_devices(db: Session) -> list[Device]:

    return db.query(Device).order_by(Device.id.asc()).all()


def _count_devices(db: Session) -> int:

    return int(db.query(Device).count())


def _get_device(db: Session, device_id: str | None) -> Device | None:

    if not device_id:
        return None

    return (
        db.query(Device)
        .filter(Device.device_id == device_id)
        .one_or_none()
    )


def _get_by_hardware_uid(db: Session, hardware_uid: str | None) -> Device | None:

    if not hardware_uid:
        return None

    return (
        db.query(Device)
        .filter(Device.hardware_uid == hardware_uid)
        .one_or_none()
    )


def _pending_device(db: Session) -> Device | None:
    """The device currently inside the setup lifecycle, if any."""

    return (
        db.query(Device)
        .filter(Device.setup_slot == "pending")
        .order_by(Device.id.asc())
        .first()
    )


# =========================================================
# DEVICE RESOLUTION (the duplicate prevention core)
# =========================================================

def _resolve_setup_device(
    db: Session,
    *,
    device_id: str | None = None,
    hardware_uid: str | None = None,
    create: bool = True,
) -> tuple[Device, bool, str | None]:
    """Return the device a setup request belongs to.

    Returns ``(device, created, warning)``.

    Resolution order - strongest identifier first:

      1. ``hardware_uid``  - the ESP32 chip id, i.e. the physical device itself
      2. ``device_id``     - the identity we assigned during a previous setup
      3. the single device that is currently inside the setup lifecycle
      4. the only device in the database (a re-run of setup on a device that
         is already registered)
      5. otherwise: create exactly ONE new pending device

    Steps 1-4 means a retry, a reload, an HMR refresh or a re-flashed ESP32
    always lands on the same row instead of inserting another one.
    """

    warning: str | None = None

    by_hardware = _get_by_hardware_uid(db, hardware_uid)
    by_device_id = _get_device(db, device_id)

    if by_hardware is not None:
        if by_device_id is not None and by_device_id.id != by_hardware.id:
            warning = (
                f"device_id {by_device_id.device_id} does not match hardware_uid "
                f"{hardware_uid}; reusing the device bound to the hardware id"
            )

        return by_hardware, False, warning

    if by_device_id is not None:
        # Learn the hardware id the first time the ESP32 tells us.
        if hardware_uid and not by_device_id.hardware_uid:
            by_device_id.hardware_uid = hardware_uid
            warning = f"bound hardware_uid {hardware_uid} to an existing device"

        return by_device_id, False, warning

    if device_id and device_id.strip():
        warning = (
            f"device_id {device_id} is unknown; the setup session was matched "
            f"by lifecycle state instead"
        )

    pending = _pending_device(db)

    if pending is not None:
        if hardware_uid and not pending.hardware_uid:
            pending.hardware_uid = hardware_uid

        return pending, False, warning

    devices = _all_devices(db)

    if len(devices) == 1:
        only = devices[0]

        if hardware_uid and not only.hardware_uid:
            only.hardware_uid = hardware_uid

        return only, False, warning

    if not create:
        raise HTTPException(
            status_code=404,
            detail="no device is waiting for setup; start one with POST /api/device/session",
        )

    device = Device(
        device_id=security.new_device_id(hardware_uid),
        hardware_uid=hardware_uid,
        name="Visionary Nexus Glasses",
        model="ESP32-CAM",
        status=DeviceStatus.AWAITING_SETUP.value,
        status_detail="Waiting for setup to start",
        setup_slot="pending",
        session_started_at=security.utcnow(),
        setup_attempts=0,
    )

    db.add(device)

    try:
        db.commit()
    except IntegrityError:
        # Another request created the pending device first (or the same
        # hardware uid was registered concurrently). The unique indexes did
        # their job - adopt the existing row instead of inserting.
        db.rollback()

        existing = _get_by_hardware_uid(db, hardware_uid) or _pending_device(db)

        if existing is None:
            raise

        return existing, False, "concurrent setup request reused the existing device"

    db.refresh(device)
    print(f"[device] {device.device_id} created (pending setup)")

    return device, True, warning


# =========================================================
# CREDENTIALS
# =========================================================

def _ensure_device_token(
    device: Device,
    *,
    rotate: bool = False,
) -> tuple[str | None, bool]:
    """Return ``(token, reused)`` - the token of *this* device.

    The token is minted exactly once per device. Retries get the very same
    credential back (decrypted from storage), which is what lets the ESP32
    re-register after a reboot without a new device identity.
    """

    if device.device_token_hash and not rotate:
        existing = security.decrypt_secret(device.device_token_encrypted)

        if existing and security.verify_device_token(existing, device.device_token_hash):
            return existing, True

        if not existing:
            # Credential cannot be recovered (key rotated / corrupted row).
            # Mint a replacement rather than failing the setup.
            print(
                f"[device] {device.device_id} stored token is unreadable - issuing a new one"
            )

    token = security.new_device_token()

    device.device_token_hash = security.hash_device_token(token)
    device.device_token_encrypted = security.encrypt_secret(token)
    device.device_token_last4 = security.token_last4(token)
    device.token_generation = (device.token_generation or 0) + 1
    device.token_issued_at = security.utcnow()

    print(
        f"[device] {device.device_id} device token issued "
        f"(generation {device.token_generation})"
    )

    return token, False


def _ensure_pairing_credential(device: Device) -> tuple[str | None, bool]:

    if device.pairing_credential_hash:
        existing = security.decrypt_secret(device.pairing_credential_encrypted)

        if existing and security.verify_device_token(
            existing, device.pairing_credential_hash
        ):
            return existing, True

    credential = security.new_pairing_credential()

    device.pairing_credential_hash = security.hash_device_token(credential)
    device.pairing_credential_encrypted = security.encrypt_secret(credential)
    device.pairing_credential_last4 = security.token_last4(credential)

    return credential, False


def _canonical_token(
    db: Session,
    device_id: str,
    fallback: str | None = None,
) -> str | None:
    """Read back the credential that is actually stored for a device.

    Two racing requests must hand out the *same* token - whoever wrote last
    wins, and everybody returns the winner's value. Falls back to the token
    that was just minted if storage is (unexpectedly) not readable.
    """

    db.expire_all()

    device = _get_device(db, device_id)

    if device is None:
        return fallback

    stored = security.decrypt_secret(device.device_token_encrypted)

    if stored and security.verify_device_token(stored, device.device_token_hash):
        return stored

    return fallback


def _issue_pairing_code(device: Device) -> str:
    """Mint the short lived code that lets the device pick up its credentials."""

    code = security.new_pairing_code()

    device.pairing_code_hash = security.hash_pairing_code(code)
    device.pairing_code_expires_at = security.pairing_code_expiry()

    return code


def _pairing_code_matches(device: Device, code: str | None) -> bool:

    if not code:
        return False

    if security.is_expired(device.pairing_code_expires_at):
        return False

    return security.verify_pairing_code(code, device.pairing_code_hash)


def bearer_token(authorization: str | None) -> str | None:
    """Pull the device token out of a standard `Authorization: Bearer` header."""

    if not authorization:
        return None

    scheme, _, value = authorization.partition(" ")

    if scheme.lower() != "bearer" or not value.strip():
        return None

    return value.strip()


def _authenticate_device(
    db: Session,
    device_id: str | None,
    token: str | None,
    *,
    hardware_uid: str | None = None,
) -> Device:
    """Resolve a device from the credentials the ESP32 presents.

    Identity comes from the token we assigned, never from a user typed id.
    Unknown tokens can never create a row here.
    """

    device = _get_device(db, device_id)

    if device is None:
        device = _get_by_hardware_uid(db, hardware_uid)

    if device is None:
        raise HTTPException(
            status_code=404,
            detail=(
                "unknown device; run POST /api/device/provision first so the "
                "device receives its token"
            ),
        )

    if not security.verify_device_token(token, device.device_token_hash):
        raise HTTPException(
            status_code=401,
            detail="invalid device token for this device",
        )

    return device


# =========================================================
# STALENESS (online -> offline)
# =========================================================

def _refresh_stale(db: Session, devices: list[Device]) -> bool:
    """Report devices that stopped sending heartbeats as offline.

    Only the status column changes - the row (and the token) is untouched.
    """

    now = security.utcnow()
    changed = False

    for device in devices:
        if device.status != DeviceStatus.ONLINE.value:
            continue

        if not device.last_heartbeat_at:
            continue

        age = (now - device.last_heartbeat_at).total_seconds()

        if age > HEARTBEAT_TIMEOUT_SECONDS:
            _set_status(
                device,
                DeviceStatus.OFFLINE.value,
                detail=f"No heartbeat for {int(age)}s",
            )
            changed = True

    if changed:
        db.commit()

    return changed


def _advance_provisioning(device: Device) -> None:
    """Walk the setup states deterministically, independent of event order.

    Both halves of the setup can happen in either order (credentials first
    over BLE, then the Wi-Fi join - or the Wi-Fi join first in cloud mode),
    so the state is derived from what the backend has actually observed:

        nothing observed              -> wifi_configuring
        Wi-Fi up                      -> connecting
        Wi-Fi up + credentials taken  -> awaiting_registration

    Registration is the only thing that leaves this helper, and it can only
    be triggered by the device presenting its token to /api/device/register.
    """

    if device.status in (DeviceStatus.REGISTERED.value, DeviceStatus.ONLINE.value):
        return

    if device.credentials_collected_at and device.wifi_configured_at:
        _set_status(
            device,
            DeviceStatus.AWAITING_REGISTRATION.value,
            detail="Credential transferred - waiting for the device to register",
        )
    elif device.wifi_configured_at:
        _set_status(
            device,
            DeviceStatus.CONNECTING.value,
            detail="Wi-Fi up - waiting for the device to collect its credential",
        )
    else:
        _set_status(
            device,
            DeviceStatus.WIFI_CONFIGURING.value,
            detail=f"Wi-Fi credentials queued for {device.wifi_ssid or 'the device'}",
        )


# =========================================================
# REQUEST MODELS
# =========================================================

class SessionRequest(BaseModel):
    """Start (or resume) the one setup session. Idempotent."""

    device_id: Optional[str] = None
    hardware_uid: Optional[str] = None


class ProvisionRequest(BaseModel):
    ssid: Optional[str] = None
    password: Optional[str] = None
    device_id: Optional[str] = None
    hardware_uid: Optional[str] = None
    transport: str = Field(default="wifi")
    rotate_token: bool = Field(
        default=False,
        description="Only set this to deliberately replace an existing credential.",
    )


class CredentialRequest(BaseModel):
    pairing_code: str
    device_id: Optional[str] = None
    hardware_uid: Optional[str] = None


class ProvisionReport(BaseModel):
    event: str
    sensor: Optional[str] = None
    psram: Optional[bool] = None
    device_id: Optional[str] = None
    hardware_uid: Optional[str] = None
    pairing_code: Optional[str] = None
    device_token: Optional[str] = None
    ip: Optional[str] = None
    rssi: Optional[int] = None
    firmware: Optional[str] = None
    error: Optional[str] = None


class ClaimRequest(BaseModel):
    """The ESP32 announces itself. No user input, no credential."""

    hardware_uid: str
    claim_secret: str = Field(min_length=16)
    firmware: Optional[str] = None
    model: Optional[str] = None
    ap_ssid: Optional[str] = None


class ClaimPollRequest(BaseModel):
    claim_id: str
    claim_secret: str = Field(min_length=16)


class ClaimDecision(BaseModel):
    claim_id: Optional[str] = None


class RegisterRequest(BaseModel):
    """Either send `Authorization: Bearer <device_token>` (what the firmware
    does) or put the token in the body."""

    device_id: str
    device_token: Optional[str] = None
    hardware_uid: Optional[str] = None
    firmware: Optional[str] = None
    ip: Optional[str] = None
    rssi: Optional[int] = None


class HeartbeatRequest(BaseModel):
    """Either send `Authorization: Bearer <device_token>` (what the firmware
    does) or put the token in the body."""

    device_id: str
    device_token: Optional[str] = None
    ip: Optional[str] = None
    rssi: Optional[int] = None
    battery: Optional[int] = None
    temperature: Optional[int] = None
    uptime_ms: Optional[int] = None
    firmware: Optional[str] = None


# =========================================================
# ROUTER
# =========================================================

router = APIRouter(prefix="/api", tags=["device"])


# ---------------------------------------------------------
# ADD GLASSES - one setup session, ever
# ---------------------------------------------------------

@router.post("/device/session", dependencies=[Depends(_serialize_device_writes)])
def start_setup_session(
    payload: SessionRequest | None = None,
    db: Session = Depends(get_db),
):
    """Entry point for the "Add Glasses" button.

    Returns the pending device if one already exists, otherwise creates a
    single one. Calling it a hundred times still yields one device.
    """

    payload = payload or SessionRequest()

    device, created, warning = _resolve_setup_device(
        db,
        device_id=payload.device_id,
        hardware_uid=payload.hardware_uid,
    )

    if not created:
        if device.status not in SETUP_STATES:
            # Re-running setup on a device that already finished it: back to
            # the top of the same lifecycle, same row, same token.
            device.session_started_at = security.utcnow()

        _set_status(
            device,
            DeviceStatus.AWAITING_SETUP.value,
            detail="Setup session resumed on the existing device",
            clear_error=True,
        )

    db.commit()
    db.refresh(device)

    return {
        "created": created,
        "reused": not created,
        "device_count": _count_devices(db),
        "warning": warning,
        "device": device_public(device),
    }


# ---------------------------------------------------------
# PROVISION (queue Wi-Fi credentials, hand back the token)
# ---------------------------------------------------------

@router.post("/device/provision", dependencies=[Depends(_serialize_device_writes)])
def provision_device(
    payload: ProvisionRequest,
    db: Session = Depends(get_db),
):
    """Configure Wi-Fi for the existing pending device.

    * reuses the pending device / the device bound to the hardware uid
    * reuses the device token that was minted before (only mints on first use)
    * mints a fresh short lived pairing code so the credentials can be picked
      up over the provisioning channel
    * leaves the device in `wifi_configuring` - NEVER `online`
    """

    device, created, warning = _resolve_setup_device(
        db,
        device_id=payload.device_id,
        hardware_uid=payload.hardware_uid,
    )

    device.setup_attempts = (device.setup_attempts or 0) + 1
    device.session_started_at = device.session_started_at or security.utcnow()

    if payload.ssid:
        device.wifi_ssid = payload.ssid

    if payload.password:
        device.wifi_password_encrypted = security.encrypt_secret(payload.password)
        device.wifi_configured_at = None

    token, token_reused = _ensure_device_token(
        device,
        rotate=payload.rotate_token,
    )

    pairing_code = _issue_pairing_code(device)

    device.provisioned_at = security.utcnow()
    device.ip_address = None
    device.rssi = None

    _set_status(
        device,
        DeviceStatus.WIFI_CONFIGURING.value,
        detail=f"Wi-Fi credentials queued for {device.wifi_ssid or 'the device'}",
        clear_error=True,
    )

    db.commit()

    # Return the credential that is really stored - if a concurrent request
    # won the race, hand out its token instead of a losing candidate.
    canonical = _canonical_token(db, device.device_id, fallback=token)

    if canonical != token:
        token = canonical
        token_reused = True

    db.refresh(device)

    print(
        f"[device] {device.device_id} provision attempt {device.setup_attempts} "
        f"(token {'reused' if token_reused else 'issued'})"
    )

    return {
        "created": created,
        "reused": not created,
        "device_count": _count_devices(db),
        "warning": warning,
        "device": device_public(device),
        # Delivered over the provisioning channel (BLE / AP / serial), never
        # returned by the read-only polling endpoint.
        "device_token": token,
        "device_token_reused": token_reused,
        "pairing_code": pairing_code,
        "pairing_code_expires_at": _iso(device.pairing_code_expires_at),
        "credentials_endpoint": "/api/device/provision/credentials",
        "register_endpoint": "/api/device/register",
        "heartbeat_endpoint": "/api/device/heartbeat",
        "heartbeat_interval_seconds": HEARTBEAT_INTERVAL_SECONDS,
    }


# ---------------------------------------------------------
# PROVISIONING STATUS (read-only poll)
# ---------------------------------------------------------

@router.get("/device/provision/status")
def provisioning_status(
    device_id: Optional[str] = Query(default=None),
    hardware_uid: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
):
    """Poll the setup progress. Read-only: no creation, no secrets."""

    device = _get_by_hardware_uid(db, hardware_uid) or _get_device(db, device_id)

    if device is None:
        device = _pending_device(db)

    if device is None:
        devices = _all_devices(db)

        if len(devices) == 1:
            device = devices[0]

    if device is None:
        raise HTTPException(
            status_code=404,
            detail="no device has been set up yet",
        )

    _refresh_stale(db, [device])
    db.refresh(device)

    return {
        "device": device_public(device),
        "device_count": _count_devices(db),
        "heartbeat_timeout_seconds": HEARTBEAT_TIMEOUT_SECONDS,
        "heartbeat_interval_seconds": HEARTBEAT_INTERVAL_SECONDS,
    }


# ---------------------------------------------------------
# CREDENTIAL PICKUP (pairing code -> token + Wi-Fi)
# ---------------------------------------------------------

_pairing_failures: dict[str, int] = {}


@router.post("/device/provision/credentials", dependencies=[Depends(_serialize_device_writes)])
def fetch_provisioning_credentials(
    payload: CredentialRequest,
    db: Session = Depends(get_db),
):
    """Called by the ESP32 to securely receive its credentials.

    The device proves it was present on the provisioning channel by
    presenting the single-use pairing code. It receives the SAME device
    token that is already bound to the device row - the credential is
    transferred, never re-created.
    """

    device = _get_by_hardware_uid(db, payload.hardware_uid) or _get_device(
        db, payload.device_id
    )

    if device is None:
        device = _pending_device(db)

    if device is None:
        raise HTTPException(status_code=404, detail="no device is provisioning")

    if not _pairing_code_matches(device, payload.pairing_code):
        failures = _pairing_failures.get(device.device_id, 0) + 1
        _pairing_failures[device.device_id] = failures

        if failures >= MAX_PAIRING_CODE_FAILURES:
            # Burn the code: a new provision call is required.
            device.pairing_code_hash = None
            device.pairing_code_expires_at = None
            _set_status(
                device,
                DeviceStatus.PAIRING_FAILED.value,
                detail="Too many invalid pairing codes",
                error="pairing code invalidated after repeated failures",
            )
            db.commit()

            raise HTTPException(
                status_code=429,
                detail="too many invalid pairing codes; restart provisioning",
            )

        db.commit()

        raise HTTPException(status_code=401, detail="invalid or expired pairing code")

    _pairing_failures.pop(device.device_id, None)

    if security.is_expired(device.pairing_code_expires_at):
        raise HTTPException(status_code=410, detail="pairing code expired")

    token = security.decrypt_secret(device.device_token_encrypted)

    if not token or not security.verify_device_token(token, device.device_token_hash):
        token, _ = _ensure_device_token(device)

    device.credentials_collected_at = security.utcnow()
    _advance_provisioning(device)

    wifi_password = security.decrypt_secret(device.wifi_password_encrypted)

    db.commit()

    token = _canonical_token(db, device.device_id, fallback=token)
    device = _get_device(db, device.device_id)

    print(f"[device] {device.device_id} credentials collected by device")

    return {
        "device_id": device.device_id,
        "device_token": token,
        "hardware_uid": device.hardware_uid,
        "wifi": {
            "ssid": device.wifi_ssid,
            "password": wifi_password,
        },
        "status": device.status,
        "register_endpoint": "/api/device/register",
        "report_endpoint": "/api/device/provision/report",
        "heartbeat_endpoint": "/api/device/heartbeat",
        "heartbeat_interval_seconds": HEARTBEAT_INTERVAL_SECONDS,
    }


# ---------------------------------------------------------
# PROVISION REPORT (wifi_connected / failures)
# ---------------------------------------------------------

# Failure events map straight onto a failure state. `wifi_connected` is
# handled by _advance_provisioning() because it is a step forward, not a
# failure.
_REPORT_TRANSITIONS = {
    "wifi_failed": (DeviceStatus.WIFI_FAILED.value, "Device could not join the Wi-Fi network"),
    "pairing_failed": (DeviceStatus.PAIRING_FAILED.value, "Device could not complete pairing"),
    "camera_failed": (DeviceStatus.CAMERA_FAILED.value, "Camera self-test failed"),
}

SUPPORTED_REPORT_EVENTS = set(_REPORT_TRANSITIONS) | {"wifi_connected", "camera_ready"}


@router.post("/device/provision/report", dependencies=[Depends(_serialize_device_writes)])
def provisioning_report(
    payload: ProvisionReport,
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
):
    """The ESP32 reports how the Wi-Fi join went. Updates the existing row."""

    device = _get_by_hardware_uid(db, payload.hardware_uid) or _get_device(
        db, payload.device_id
    )

    if device is None:
        raise HTTPException(status_code=404, detail="unknown device")

    authorised = security.verify_device_token(
        bearer_token(authorization) or payload.device_token,
        device.device_token_hash,
    ) or _pairing_code_matches(device, payload.pairing_code)

    if not authorised:
        raise HTTPException(status_code=401, detail="invalid device credentials")

    event = (payload.event or "").strip().lower()

    if event not in SUPPORTED_REPORT_EVENTS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"unsupported event '{payload.event}'; expected one of "
                f"{sorted(SUPPORTED_REPORT_EVENTS)}"
            ),
        )

    if payload.ip:
        device.ip_address = payload.ip

    if payload.rssi is not None:
        device.rssi = payload.rssi

    if payload.firmware:
        device.firmware = payload.firmware

    if event == "wifi_connected":
        device.wifi_configured_at = security.utcnow()
        device.last_error = None
        _advance_provisioning(device)

    elif event == "camera_ready":
        # Only ever sent after the firmware's esp_camera_init() succeeded on
        # the physical OV2640. It does not change the lifecycle status.
        device.camera_ready = True
        device.camera_sensor = payload.sensor or device.camera_sensor
        device.camera_initialized_at = security.utcnow()
        device.last_error = None
        device.status_detail = (
            f"Camera ready ({device.camera_sensor or 'OV2640'})"
            if device.status == DeviceStatus.ONLINE.value
            else device.status_detail
        )

    elif event == "camera_failed" and device.status == DeviceStatus.ONLINE.value:
        # A camera self-test fault on an otherwise healthy, registered device
        # is reported without dropping the connection state.
        device.camera_ready = False
        device.last_error = payload.error or "camera self-test failed"
        device.status_detail = "Camera self-test failed (device still online)"

    else:
        new_status, detail = _REPORT_TRANSITIONS[event]

        _set_status(
            device,
            new_status,
            detail=detail,
            error=payload.error,
        )

    db.commit()
    db.refresh(device)

    return {
        "device": device_public(device),
        "reused": True,
    }


# ---------------------------------------------------------
# REGISTER (idempotent)
# ---------------------------------------------------------

@router.post("/device/register", dependencies=[Depends(_serialize_device_writes)])
def register_device(
    payload: RegisterRequest,
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
):
    """Register the device that already owns this token.

    Idempotent by construction:
      * the device_id must already exist - a valid token can never create a row
      * a second call with the same token updates the same row
      * the response hands back the SAME token plus the pairing credential
    """

    device = _get_device(db, payload.device_id)

    if device is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"unknown device_id {payload.device_id}; the device must be "
                f"provisioned first (POST /api/device/provision)"
            ),
        )

    presented = bearer_token(authorization) or payload.device_token

    if not security.verify_device_token(presented, device.device_token_hash):
        raise HTTPException(
            status_code=401,
            detail="invalid device token for this device",
        )

    if payload.hardware_uid:
        if device.hardware_uid and device.hardware_uid != payload.hardware_uid:
            # A device may learn its hardware id once, never swap it.
            raise HTTPException(
                status_code=409,
                detail=(
                    f"{device.device_id} is already bound to hardware_uid "
                    f"{device.hardware_uid}; it cannot register as "
                    f"{payload.hardware_uid}"
                ),
            )

        owner = _get_by_hardware_uid(db, payload.hardware_uid)

        if owner is not None and owner.id != device.id:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"hardware_uid {payload.hardware_uid} is already bound to "
                    f"{owner.device_id}; refusing to create a second device for "
                    f"the same hardware"
                ),
            )

        if not device.hardware_uid:
            device.hardware_uid = payload.hardware_uid

    already_registered = bool(device.registered)

    now = security.utcnow()

    device.registered = True
    device.registration_count = (device.registration_count or 0) + 1
    device.registered_at = device.registered_at or now
    device.last_seen_at = now

    if payload.firmware:
        device.firmware = payload.firmware

    if payload.ip:
        device.ip_address = payload.ip

    if payload.rssi is not None:
        device.rssi = payload.rssi

    pairing_credential, credential_reused = _ensure_pairing_credential(device)

    # Registration is complete: the pairing code can never be used again.
    device.pairing_code_hash = None
    device.pairing_code_expires_at = None

    if device.status == DeviceStatus.ONLINE.value:
        # The device was already online (e.g. it re-registered after a soft
        # reset without losing connectivity). Keep it online - never demote.
        device.status_detail = "Device re-registered while online"
        print(f"[device] {device.device_id} re-registered (already online)")
    else:
        _set_status(
            device,
            DeviceStatus.REGISTERED.value,
            detail="Device registered - waiting for the first heartbeat",
            clear_error=True,
        )

    db.commit()

    token = _canonical_token(db, device.device_id)
    device = _get_device(db, device.device_id)

    return {
        "device": device_public(device),
        "device_id": device.device_id,
        "status": device.status,
        "registered": True,
        "already_registered": already_registered,
        "reused": True,
        "registration": {
            "registered_at": _iso(device.registered_at),
            "registration_count": device.registration_count,
            "pairing_credential": pairing_credential,
            "pairing_credential_reused": credential_reused,
            "device_token_reused": True,
        },
        "device_token": token,
        "heartbeat_endpoint": "/api/device/heartbeat",
        "heartbeat_interval_seconds": HEARTBEAT_INTERVAL_SECONDS,
    }


# ---------------------------------------------------------
# HEARTBEAT (updates the existing device -> online)
# ---------------------------------------------------------

@router.post("/device/heartbeat", dependencies=[Depends(_serialize_device_writes)])
def device_heartbeat(
    payload: HeartbeatRequest,
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
):
    """Mark the registered device online. Never creates anything.

    Accepts the credential either as `Authorization: Bearer <device_token>`
    (what the firmware sends) or in the JSON body.
    """

    device = _authenticate_device(
        db,
        payload.device_id,
        bearer_token(authorization) or payload.device_token,
    )

    if not device.registered:
        raise HTTPException(
            status_code=409,
            detail="device is not registered yet; call POST /api/device/register first",
        )

    now = security.utcnow()

    device.heartbeat_count = (device.heartbeat_count or 0) + 1
    device.last_heartbeat_at = now
    device.last_seen_at = now

    if payload.ip:
        device.ip_address = payload.ip

    if payload.rssi is not None:
        device.rssi = payload.rssi

    if payload.battery is not None:
        device.battery = payload.battery

    if payload.temperature is not None:
        device.temperature = payload.temperature

    if payload.uptime_ms is not None:
        device.uptime_ms = payload.uptime_ms

    if payload.firmware:
        device.firmware = payload.firmware

    _set_status(
        device,
        DeviceStatus.ONLINE.value,
        detail="Heartbeat OK",
        clear_error=True,
    )

    db.commit()
    db.refresh(device)

    return {
        "device": device_public(device),
        "device_id": device.device_id,
        "status": device.status,
        "heartbeat": {
            "count": device.heartbeat_count,
            "received_at": _iso(now),
            "timeout_seconds": HEARTBEAT_TIMEOUT_SECONDS,
        },
        "next_heartbeat_seconds": HEARTBEAT_INTERVAL_SECONDS,
        "commands": [],
    }


# ---------------------------------------------------------
# LIST / DETAIL / RESTART SETUP
# ---------------------------------------------------------

@router.get("/devices")
def list_devices(
    include_pending: bool = Query(default=True),
    db: Session = Depends(get_db),
):
    """Registered Devices section. Read-only - safe to poll."""

    devices = _all_devices(db)
    _refresh_stale(db, devices)

    now = security.utcnow()

    pending = next((d for d in devices if d.status in SETUP_STATES), None)

    if not include_pending:
        devices = [d for d in devices if not d.setup_slot]

    return {
        "count": len(devices),
        "total_count": _count_devices(db),
        "pending_device_id": pending.device_id if pending else None,
        "registered_count": sum(1 for d in devices if d.registered),
        "online_count": sum(
            1 for d in devices if d.status == DeviceStatus.ONLINE.value
        ),
        "devices": [device_summary(device, now) for device in devices],
    }


@router.get("/devices/{device_id}")
def get_device(device_id: str, db: Session = Depends(get_db)):

    device = _get_device(db, device_id)

    if device is None:
        raise HTTPException(status_code=404, detail="device not found")

    _refresh_stale(db, [device])
    db.refresh(device)

    return {
        "device": device_public(device),
        "heartbeat_interval_seconds": HEARTBEAT_INTERVAL_SECONDS,
        "heartbeat_timeout_seconds": HEARTBEAT_TIMEOUT_SECONDS,
    }


@router.post("/devices/{device_id}/setup", dependencies=[Depends(_serialize_device_writes)])
def restart_setup(device_id: str, db: Session = Depends(get_db)):
    """Restart the wizard on the SAME device (Retry setup).

    Keeps the device_id and the device token, so the ESP32 that is already
    flashed continues to work. Never deletes and never inserts.
    """

    device = _get_device(db, device_id)

    if device is None:
        raise HTTPException(status_code=404, detail="device not found")

    keep_credentials = bool(device.device_token_hash)

    device.pairing_code_hash = None
    device.pairing_code_expires_at = None
    device.wifi_password_encrypted = None
    device.ip_address = None
    device.rssi = None
    device.session_started_at = security.utcnow()

    _set_status(
        device,
        DeviceStatus.AWAITING_SETUP.value,
        detail="Setup restarted on the existing device",
        clear_error=True,
    )

    db.commit()
    db.refresh(device)

    print(f"[device] {device.device_id} setup restarted (same row, same identity)")

    return {
        "device": device_public(device),
        "credentials_preserved": keep_credentials,
        "device_count": _count_devices(db),
    }


# =========================================================
# ZERO-INPUT CLAIM FLOW
# =========================================================
#
# This is the exchange used by a freshly flashed AI-Thinker ESP32-CAM:
#
#   1. the app reserves the setup session   POST /api/device/session
#   2. the user joins the device's setup AP and types ONLY the Wi-Fi
#      SSID + password on http://192.168.4.1/
#   3. the device joins that Wi-Fi and announces itself
#                                           POST /api/device/claim
#   4. the app shows the physical device (hardware id) and the user
#      approves it                          POST /api/devices/{id}/claim/approve
#   5. the device polls and receives the legitimate, backend-assigned
#      credential + the backend URL         POST /api/device/claim/poll
#   6. the device registers and heartbeats   POST /api/device/register,
#                                            POST /api/device/heartbeat
#
# The user never types a backend URL, device id, pairing ticket, device
# token, IP address, port or API key. The claim secret is generated on the
# device itself, sent with the announcement, and only proves continuity of
# the same physical board while it waits for approval - it is never a
# credential and never grants access to anything on its own.

CLAIM_TTL_SECONDS = int(os.getenv("DEVICE_CLAIM_TTL_SECONDS", "600"))


def secrets_token(length: int) -> str:
    """URL safe random string used for claim identifiers."""

    return _secrets.token_urlsafe(length)


def _claim_state(device: Device, now: datetime | None = None) -> str:

    if not device.claim_id:
        return "none"

    if device.claim_state == "pending_approval" and security.is_expired(
        device.claim_requested_at + timedelta(seconds=CLAIM_TTL_SECONDS)
        if device.claim_requested_at
        else None,
        now,
    ):
        return "expired"

    return device.claim_state or "none"


def _clear_claim(device: Device, state: str) -> None:

    device.claim_state = state
    device.claim_id = None
    device.claim_secret_hash = None


def _backend_urls() -> list[str]:
    """URLs the device may use to reach THIS backend, best effort."""

    configured = (os.getenv("DEVICE_BACKEND_URL") or "").strip()

    urls: list[str] = []

    if configured:
        urls.append(configured.rstrip("/"))

    port = int(os.getenv("PORT", "8000"))
    host = (os.getenv("BACKEND_PUBLIC_HOST") or "").strip()

    if host:
        urls.append(f"http://{host}:{port}")

    # Local interfaces - this is what a device on the same LAN needs.
    try:
        import socket

        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

        try:
            probe.connect(("8.8.8.8", 80))
            lan_ip = probe.getsockname()[0]
        except OSError:
            lan_ip = ""
        finally:
            probe.close()

        if lan_ip and not lan_ip.startswith("127."):
            urls.append(f"http://{lan_ip}:{port}")
    except Exception:  # pragma: no cover - networking is best effort
        pass

    mdns = (os.getenv("DEVICE_MDNS_HOST") or "nexus-backend.local").strip()

    if mdns:
        urls.append(f"http://{mdns}:{port}")

    urls.append(f"http://127.0.0.1:{port}")

    seen: list[str] = []

    for url in urls:
        if url not in seen:
            seen.append(url)

    return seen


@router.get("/device/backend-info")
def backend_info():
    """Where the backend can be reached - used by the app to configure a
    device without the user ever typing an address."""

    return {
        "urls": _backend_urls(),
        "preferred": _backend_urls()[0],
        "port": int(os.getenv("PORT", "8000")),
        "mdns_host": os.getenv("DEVICE_MDNS_HOST", "nexus-backend.local"),
    }


@router.post("/device/claim", dependencies=[Depends(_serialize_device_writes)])
def claim_device(
    payload: ClaimRequest,
    db: Session = Depends(get_db),
):
    """The ESP32 announces itself and is matched to the pending setup session.

    Idempotent: the same hardware_uid always resolves to the same device row,
    so a reboot, a retry or a re-flash cannot add a device.
    """

    now = security.utcnow()

    device, created, warning = _resolve_setup_device(
        db,
        hardware_uid=payload.hardware_uid,
    )

    if payload.model:
        device.model = payload.model

    if payload.firmware:
        device.firmware = payload.firmware

    # A second announcement while awaiting approval reuses the same claim.
    if device.claim_id and device.claim_state in ("pending_approval", "approved"):
        claim_id = device.claim_id
        device.claim_secret_hash = security.hash_device_token(payload.claim_secret)
        device.claim_requested_at = device.claim_requested_at or now
        device.claim_failure_count = 0
        state = device.claim_state
        print(f"[device] {device.device_id} claim {claim_id} refreshed ({state})")
    else:
        claim_id = f"clm_{secrets_token(16)}"
        device.claim_id = claim_id
        device.claim_secret_hash = security.hash_device_token(payload.claim_secret)
        device.claim_state = "pending_approval"
        device.claim_requested_at = now
        device.claim_approved_at = None
        device.claim_delivered_at = None
        device.claim_failure_count = 0
        state = "pending_approval"
        print(
            f"[device] {device.device_id} claim {claim_id} opened "
            f"by {payload.hardware_uid}"
        )

    # The device is on the network but does not have its credential yet.
    if device.status not in (DeviceStatus.REGISTERED.value, DeviceStatus.ONLINE.value):
        _set_status(
            device,
            DeviceStatus.CONNECTING.value,
            detail=(
                "Device joined the network - approve it to transfer the "
                "existing credential"
            ),
            clear_error=True,
        )

    db.commit()
    db.refresh(device)

    return {
        "claim_id": claim_id,
        "claim_state": state,
        "device_id": device.device_id,
        "device_count": _count_devices(db),
        "created": created,
        "reused": not created,
        "warning": warning,
        "poll_endpoint": "/api/device/claim/poll",
        "poll_interval_seconds": 3,
        "approve_hint": f"/api/devices/{device.device_id}/claim/approve",
    }


@router.post("/device/claim/poll", dependencies=[Depends(_serialize_device_writes)])
def poll_claim(
    payload: ClaimPollRequest,
    db: Session = Depends(get_db),
):
    """The device waits for the user's approval and then receives its
    credential, the Wi-Fi credentials the app typed (if any) and the backend
    URL to keep using. The credential is the one that already belongs to the
    device - it is transferred, never re-created."""

    device = (
        db.query(Device)
        .filter(Device.claim_id == payload.claim_id)
        .one_or_none()
    )

    if device is None:
        raise HTTPException(status_code=404, detail="unknown claim")

    if not security.verify_device_token(payload.claim_secret, device.claim_secret_hash):
        device.claim_failure_count = (device.claim_failure_count or 0) + 1

        if device.claim_failure_count >= MAX_PAIRING_CODE_FAILURES:
            _clear_claim(device, "rejected")

        db.commit()

        raise HTTPException(status_code=401, detail="invalid claim secret")

    device.claim_failure_count = 0

    state = _claim_state(device)

    if state in ("rejected", "expired"):
        # Verdict for the board that opened the claim: reopen the setup AP.
        # The device row itself is untouched - a retry reuses it.
        db.commit()

        return {
            "claim_state": state,
            "device_id": device.device_id,
            "instruction": "reopen the setup access point and claim again",
        }

    if state == "pending_approval":
        db.commit()

        return {
            "claim_state": "pending_approval",
            "device_id": device.device_id,
            "hardware_uid": device.hardware_uid,
            "poll_interval_seconds": 3,
            "expires_in_seconds": CLAIM_TTL_SECONDS,
        }

    if state not in ("approved", "delivered"):
        raise HTTPException(status_code=409, detail=f"claim is in state '{state}'")

    # ---- approved (or already delivered): hand over the credential -------
    # Re-delivery is deliberate: if the board missed the response it asks
    # again and receives the SAME token instead of a new identity.
    token, token_reused = _ensure_device_token(device)

    wifi_password = security.decrypt_secret(device.wifi_password_encrypted)

    device.claim_state = "delivered"
    device.claim_delivered_at = security.utcnow()
    device.credentials_collected_at = device.credentials_collected_at or security.utcnow()

    if device.status not in (DeviceStatus.REGISTERED.value, DeviceStatus.ONLINE.value):
        _set_status(
            device,
            DeviceStatus.AWAITING_REGISTRATION.value,
            detail="Credential delivered to the device - waiting for registration",
            clear_error=True,
        )

    db.commit()

    canonical = _canonical_token(db, device.device_id, fallback=token)
    device = _get_device(db, device.device_id)

    print(f"[device] {device.device_id} credential delivered to the device")

    return {
        "claim_state": "delivered",
        "device_id": device.device_id,
        "device_token": canonical,
        "device_token_reused": token_reused,
        "hardware_uid": device.hardware_uid,
        "wifi": {
            "ssid": device.wifi_ssid,
            "password": wifi_password,
        } if device.wifi_ssid else None,
        "backend_url": _backend_urls()[0],
        "backend_urls": _backend_urls(),
        "register_endpoint": "/api/device/register",
        "heartbeat_endpoint": "/api/device/heartbeat",
        "heartbeat_interval_seconds": HEARTBEAT_INTERVAL_SECONDS,
    }


@router.post("/devices/{device_id}/claim/approve", dependencies=[Depends(_serialize_device_writes)])
def approve_claim(device_id: str, payload: ClaimDecision, db: Session = Depends(get_db)):
    """The user confirms the physical device in the app."""

    device = _get_device(db, device_id)

    if device is None:
        raise HTTPException(status_code=404, detail="device not found")

    if _claim_state(device) != "pending_approval":
        raise HTTPException(
            status_code=409,
            detail=f"no claim is waiting for approval (state: {_claim_state(device)})",
        )

    if payload.claim_id and payload.claim_id != device.claim_id:
        raise HTTPException(status_code=409, detail="claim id does not match this device")

    token, token_reused = _ensure_device_token(device)

    device.claim_state = "approved"
    device.claim_approved_at = security.utcnow()

    _set_status(
        device,
        DeviceStatus.AWAITING_REGISTRATION.value,
        detail="Approved in the app - transferring the credential to the device",
        clear_error=True,
    )

    db.commit()
    db.refresh(device)

    print(f"[device] {device.device_id} claim approved by the user")

    return {
        "device": device_public(device),
        "claim_id": device.claim_id,
        "claim_state": "approved",
        "device_token_reused": token_reused,
        "device_token_last4": device.device_token_last4,
    }


@router.post("/devices/{device_id}/claim/reject", dependencies=[Depends(_serialize_device_writes)])
def reject_claim(device_id: str, payload: ClaimDecision, db: Session = Depends(get_db)):
    """The user says "that is not my device"; the row is kept, the claim is not."""

    device = _get_device(db, device_id)

    if device is None:
        raise HTTPException(status_code=404, detail="device not found")

    # The claim row stays readable (secret hash intact) so the board that
    # opened it learns the verdict and reopens its setup AP itself.
    device.claim_state = "rejected"
    device.claim_approved_at = None

    _set_status(
        device,
        DeviceStatus.AWAITING_SETUP.value,
        detail="Claim rejected by the user - device may set up again",
        error="device claim rejected",
    )

    db.commit()
    db.refresh(device)

    return {
        "device": device_public(device),
        "claim_state": "rejected",
        "device_count": _count_devices(db),
    }
