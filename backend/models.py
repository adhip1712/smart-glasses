from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    text,
)
from datetime import datetime

try:
    from backend.database import Base
except ImportError:
    from database import Base


class Conversation(Base):
    __tablename__ = "conversations"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, nullable=False, default="New Chat")
    user_id = Column(String, default="local_user", index=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, index=True)

    conversation_id = Column(
        Integer,
        ForeignKey("conversations.id"),
        nullable=True,
        index=True,
    )

    user_id = Column(
        String,
        default="local_user",
        index=True,
    )

    role = Column(
        String,
        nullable=False,
    )

    content = Column(
        Text,
        nullable=False,
    )

    created_at = Column(
        DateTime,
        default=datetime.utcnow,
    )

class Device(Base):
    """A physical pair of Visionary Nexus glasses.

    Identity rules enforced by this model (see docs/device-lifecycle.md):

    * ``device_id``           one stable cloud identity per physical device.
    * ``hardware_uid``        the ESP32 chip id reported by the firmware -
                              the strongest identifier available, so it is
                              unique and used to recognise a device that
                              comes back after a re-flash / NVS wipe.
    * ``setup_slot``          holds the constant ``"pending"`` while the
                              device is still inside a setup lifecycle state
                              and ``NULL`` once it is registered. The partial
                              unique index below makes it *impossible* for
                              the database to hold two pending devices, so
                              repeated setup attempts cannot create a
                              duplicate row even under concurrent requests.
    * ``device_token_hash``   verifies the token presented by the ESP32.
    * ``device_token_encrypted``
                              the same token, recoverable so a retry can be
                              handed back the *existing* credential instead
                              of being issued a new one.
    """

    __tablename__ = "devices"

    __table_args__ = (
        Index(
            "uq_devices_single_pending_setup",
            "setup_slot",
            unique=True,
            sqlite_where=text("setup_slot IS NOT NULL"),
            postgresql_where=text("setup_slot IS NOT NULL"),
        ),
        Index(
            "uq_devices_hardware_uid",
            "hardware_uid",
            unique=True,
            sqlite_where=text("hardware_uid IS NOT NULL"),
            postgresql_where=text("hardware_uid IS NOT NULL"),
        ),
    )

    id = Column(Integer, primary_key=True, index=True)

    # ---- identity -------------------------------------------------
    device_id = Column(String, nullable=False, unique=True, index=True)
    hardware_uid = Column(String, nullable=True, index=True)
    name = Column(String, nullable=False, default="Visionary Nexus Glasses")
    model = Column(String, nullable=False, default="ESP32-CAM")
    firmware = Column(String, nullable=True)

    # ---- lifecycle -------------------------------------------------
    status = Column(String, nullable=False, default="awaiting_setup", index=True)
    status_detail = Column(String, nullable=True)
    last_error = Column(String, nullable=True)
    setup_slot = Column(String, nullable=True)
    setup_attempts = Column(Integer, nullable=False, default=0)
    registered = Column(Boolean, nullable=False, default=False)
    registration_count = Column(Integer, nullable=False, default=0)
    heartbeat_count = Column(Integer, nullable=False, default=0)

    # ---- timestamps ------------------------------------------------
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    session_started_at = Column(DateTime, nullable=True)
    provisioned_at = Column(DateTime, nullable=True)
    wifi_configured_at = Column(DateTime, nullable=True)
    credentials_collected_at = Column(DateTime, nullable=True)
    registered_at = Column(DateTime, nullable=True)
    last_heartbeat_at = Column(DateTime, nullable=True)
    last_seen_at = Column(DateTime, nullable=True)

    # ---- network ---------------------------------------------------
    wifi_ssid = Column(String, nullable=True)
    wifi_password_encrypted = Column(Text, nullable=True)
    ip_address = Column(String, nullable=True)
    rssi = Column(Integer, nullable=True)

    # ---- telemetry -------------------------------------------------
    # Camera: set only by the firmware's OV2640 init result.
    camera_ready = Column(Boolean, nullable=False, default=False)
    camera_sensor = Column(String, nullable=True)
    camera_initialized_at = Column(DateTime, nullable=True)

    battery = Column(Integer, nullable=True)
    temperature = Column(Integer, nullable=True)
    uptime_ms = Column(Integer, nullable=True)

    # ---- credentials -----------------------------------------------
    device_token_hash = Column(Text, nullable=True, unique=True, index=True)
    device_token_encrypted = Column(Text, nullable=True)
    device_token_last4 = Column(String, nullable=True)
    token_generation = Column(Integer, nullable=False, default=0)
    token_issued_at = Column(DateTime, nullable=True)

    # ---- zero-input claim flow ------------------------------------
    # The ESP32 announces itself with a device-generated secret and is
    # matched to the pending setup session; the user approves the physical
    # device in the app and the credential is delivered on the next poll.
    claim_id = Column(String, nullable=True, index=True)
    claim_secret_hash = Column(Text, nullable=True)
    claim_state = Column(String, nullable=True)
    claim_requested_at = Column(DateTime, nullable=True)
    claim_approved_at = Column(DateTime, nullable=True)
    claim_delivered_at = Column(DateTime, nullable=True)
    claim_failure_count = Column(Integer, nullable=False, default=0)

    pairing_code_hash = Column(Text, nullable=True)
    pairing_code_expires_at = Column(DateTime, nullable=True)

    pairing_credential_hash = Column(Text, nullable=True)
    pairing_credential_encrypted = Column(Text, nullable=True)
    pairing_credential_last4 = Column(String, nullable=True)
