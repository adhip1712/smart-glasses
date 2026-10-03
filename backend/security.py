# =========================================================
# VISIONARY NEXUS - DEVICE CREDENTIAL SECURITY
# =========================================================
#
# Everything in this module exists to serve one rule of the
# provisioning flow:
#
#   A physical glasses device has ONE stable identity and ONE
#   device token. That token is minted once, transferred to the
#   ESP32 exactly once (over the provisioning channel) and then
#   re-used for the whole life of the device - registration,
#   every heartbeat and every reconnect.
#
# To make that possible without ever writing the plaintext
# token to the database we keep two independent representations:
#
#   device_token_hash       SHA-256(pepper || token)
#                           -> used to VERIFY a token on every
#                              register / heartbeat call. Fast,
#                              indexable and constant-time compared.
#
#   device_token_encrypted  Fernet(token)
#                           -> used to RE-DELIVER the very same
#                              token when the device (or the app
#                              that is pairing it) asks again, e.g.
#                              after a retry, a reload or a
#                              re-flashed ESP32.
#
# The same treatment is applied to the Wi-Fi password captured
# during provisioning and to the long lived pairing credential
# handed out at registration time.
#
# Keys live outside the repository (env vars, or a 0600 key file
# next to this module that is git-ignored).
# =========================================================

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta
from pathlib import Path

try:  # pragma: no cover - exercised only when dependency is missing
    from cryptography.fernet import Fernet, InvalidToken
except ImportError:  # pragma: no cover
    Fernet = None

    class InvalidToken(Exception):
        pass


# =========================================================
# CONSTANTS
# =========================================================

# Prefixes make credentials recognisable in logs / bug reports
# without revealing anything about their value.
DEVICE_TOKEN_PREFIX = "sgn_dev_"
PAIRING_CREDENTIAL_PREFIX = "sgn_pair_"

# Human friendly alphabet: no 0/O/1/I/L to survive being read
# aloud or typed off a small OLED.
PAIRING_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
PAIRING_CODE_LENGTH = 8

# How long a pairing code stays usable. It is minted on every
# /api/device/provision call and destroyed as soon as the device
# finishes registration.
PAIRING_CODE_TTL_SECONDS = int(
    os.getenv("DEVICE_PAIRING_CODE_TTL_SECONDS", "900")
)

SECRET_BYTES = 48

MODULE_DIR = Path(__file__).resolve().parent


# =========================================================
# TIME
# =========================================================

def utcnow() -> datetime:
    """Naive UTC timestamp - matches the DateTime columns used by the app."""

    return datetime.utcnow()


def is_expired(moment: datetime | None, now: datetime | None = None) -> bool:

    if moment is None:
        return True

    return (now or utcnow()) >= moment


# =========================================================
# SECRETS (pepper + encryption key)
# =========================================================

_secret_cache: dict[str, bytes] = {}


def _load_secret(
    env_name: str,
    file_name: str,
    purpose: str,
) -> bytes:
    """Read a secret from the environment, else from a 0600 key file.

    A file is generated on first use for local development so the
    app keeps working out of the box. In production the values are
    expected to come from DEVICE_TOKEN_PEPPER / DEVICE_TOKEN_KEY.
    """

    cached = _secret_cache.get(env_name)

    if cached is not None:
        return cached

    value = (os.getenv(env_name) or "").strip()

    if value:
        secret = value.encode("utf-8")
        _secret_cache[env_name] = secret
        return secret

    key_file = Path(
        os.getenv(f"{env_name}_FILE") or (MODULE_DIR / file_name)
    )

    if key_file.exists():
        secret = key_file.read_bytes().strip()

        if secret:
            _secret_cache[env_name] = secret
            return secret

    secret = secrets.token_urlsafe(SECRET_BYTES).encode("utf-8")

    try:
        key_file.write_bytes(secret)
        os.chmod(key_file, 0o600)
        print(
            f"WARNING: {env_name} was not set - generated a local "
            f"{purpose} key at {key_file}. Keep this file: rotating it "
            f"invalidates every stored device credential."
        )
    except OSError as error:  # read-only filesystem, containers, ...
        print(
            f"WARNING: could not persist the {purpose} key ({error}). "
            f"Set {env_name} to keep device credentials stable across restarts."
        )

    _secret_cache[env_name] = secret
    return secret


def token_pepper() -> bytes:

    return _load_secret(
        "DEVICE_TOKEN_PEPPER",
        ".device_token_pepper",
        "device token pepper",
    )


def _fernet() -> "Fernet":

    if Fernet is None:  # pragma: no cover
        raise RuntimeError(
            "The 'cryptography' package is required to store recoverable "
            "device credentials. Install it with: pip install cryptography"
        )

    material = _load_secret(
        "DEVICE_TOKEN_KEY",
        ".device_token_key",
        "device credential encryption",
    )

    # Any sufficiently random string can be turned into a Fernet key.
    key = base64.urlsafe_b64encode(hashlib.sha256(material).digest())

    return Fernet(key)


# =========================================================
# TOKEN HASHING / VERIFICATION
# =========================================================

def hash_device_token(token: str) -> str:
    """Peppered SHA-256 digest used for lookups and verification."""

    return hashlib.sha256(token_pepper() + token.encode("utf-8")).hexdigest()


def verify_device_token(token: str | None, stored_hash: str | None) -> bool:
    """Constant time comparison of a presented token against a stored hash."""

    if not token or not stored_hash:
        return False

    return hmac.compare_digest(hash_device_token(token), stored_hash)


def token_last4(token: str) -> str:

    return token[-4:] if len(token) >= 4 else token


# =========================================================
# RECOVERABLE SECRETS
# =========================================================

def encrypt_secret(value: str | None) -> str | None:

    if value is None or value == "":
        return None

    return _fernet().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_secret(blob: str | None) -> str | None:

    if not blob:
        return None

    try:
        return _fernet().decrypt(blob.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        # The value can no longer be read (rotated key, corrupted row).
        # Callers must treat this as "credential unavailable" and mint a
        # new one instead of crashing.
        return None


# =========================================================
# CREDENTIAL MINTING
# =========================================================

def new_device_token() -> str:

    return DEVICE_TOKEN_PREFIX + secrets.token_urlsafe(32)


def new_pairing_credential() -> str:

    return PAIRING_CREDENTIAL_PREFIX + secrets.token_urlsafe(32)


def new_pairing_code() -> str:

    raw = "".join(
        secrets.choice(PAIRING_CODE_ALPHABET)
        for _ in range(PAIRING_CODE_LENGTH)
    )

    return f"{raw[:4]}-{raw[4:]}"


def normalize_pairing_code(code: str | None) -> str:
    """Upper-case and strip separators so 'abcd efgh' == 'ABCD-EFGH'."""

    if not code:
        return ""

    cleaned = "".join(ch for ch in code.upper() if ch.isalnum())

    if len(cleaned) != PAIRING_CODE_LENGTH:
        return ""

    return f"{cleaned[:4]}-{cleaned[4:]}"


def hash_pairing_code(code: str) -> str:
    """Pairing codes get the same peppered treatment as device tokens."""

    return hashlib.sha256(
        token_pepper() + normalize_pairing_code(code).encode("utf-8")
    ).hexdigest()


def verify_pairing_code(code: str | None, stored_hash: str | None) -> bool:

    normalized = normalize_pairing_code(code)

    if not normalized or not stored_hash:
        return False

    return hmac.compare_digest(hash_pairing_code(normalized), stored_hash)


def pairing_code_expiry(now: datetime | None = None) -> datetime:

    return (now or utcnow()) + timedelta(seconds=PAIRING_CODE_TTL_SECONDS)


# =========================================================
# DEVICE IDENTITY
# =========================================================

def new_device_id(hardware_uid: str | None = None) -> str:
    """Stable, human readable device id.

    When the ESP32 reports a hardware UID (its chip MAC / efuse id) the
    id is derived from it, so the same physical board always maps to the
    same default device id even if the row or the NVS blob is lost.
    Without a hardware UID a random id is generated once and then stored.
    """

    if hardware_uid:
        fingerprint = hashlib.sha256(
            f"visionary-nexus|{hardware_uid}".encode("utf-8")
        ).hexdigest().upper()

        return f"SG-{fingerprint[:4]}-{fingerprint[4:8]}"

    return f"SG-{secrets.token_hex(2).upper()}-{secrets.token_hex(2).upper()}"
