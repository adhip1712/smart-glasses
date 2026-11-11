"""Account registration and JWT authentication for Visionary Nexus."""
import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path

import jwt
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

try:
    from backend.database import SessionLocal
    from backend.models import User
except ImportError:
    from database import SessionLocal
    from models import User

router = APIRouter(prefix="/api/auth", tags=["authentication"])
_SECRET_PATH = Path(__file__).with_name(".auth_secret_key")
_ITERATIONS = 310_000


def _secret():
    configured = os.getenv("AUTH_SECRET_KEY", "").strip()
    if configured:
        return configured
    if _SECRET_PATH.exists():
        return _SECRET_PATH.read_text(encoding="utf-8").strip()
    value = secrets.token_urlsafe(48)
    try:
        with _SECRET_PATH.open("x", encoding="utf-8") as handle:
            handle.write(value)
    except FileExistsError:
        value = _SECRET_PATH.read_text(encoding="utf-8").strip()
    return value


def _hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _ITERATIONS)
    return "pbkdf2_sha256$" + str(_ITERATIONS) + "$" + salt.hex() + "$" + digest.hex()


def _verify_password(password, encoded):
    try:
        scheme, rounds, salt_hex, digest_hex = encoded.split("$", 3)
        if scheme != "pbkdf2_sha256":
            return False
        candidate = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(rounds)
        )
        return hmac.compare_digest(candidate.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def _public_user(user):
    return {"id": user.id, "email": user.email, "display_name": user.display_name}


def _issue_token(user):
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user.id),
        "email": user.email,
        "iat": now,
        "exp": now + timedelta(days=7),
    }
    return jwt.encode(payload, _secret(), algorithm="HS256")


def authenticate_token(token):
    try:
        payload = jwt.decode(token, _secret(), algorithms=["HS256"])
        user_id = int(payload.get("sub", ""))
    except Exception:
        return None
    db = SessionLocal()
    try:
        return db.query(User).filter(User.id == user_id).first()
    finally:
        db.close()


class RegisterRequest(BaseModel):
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=10, max_length=128)
    display_name: str = Field(default="", max_length=80)


class LoginRequest(BaseModel):
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=1, max_length=128)


def _session_response(user):
    return {
        "access_token": _issue_token(user),
        "token_type": "bearer",
        "user": _public_user(user),
    }


@router.post("/register")
def register(payload: RegisterRequest):
    email = payload.email.strip().lower()
    if (
        "@" not in email
        or "." not in email.rsplit("@", 1)[-1]
        or any(character.isspace() for character in email)
    ):
        raise HTTPException(status_code=422, detail="Enter a valid email address.")
    db = SessionLocal()
    try:
        if db.query(User).filter(User.email == email).first():
            raise HTTPException(status_code=409, detail="An account with this email already exists.")
        user = User(
            email=email,
            display_name=payload.display_name.strip() or email.split("@", 1)[0],
            password_hash=_hash_password(payload.password),
            created_at=datetime.utcnow(),
            last_login_at=datetime.utcnow(),
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return _session_response(user)
    finally:
        db.close()


@router.post("/login")
def login(payload: LoginRequest):
    email = payload.email.strip().lower()
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == email).first()
        if not user or not _verify_password(payload.password, user.password_hash):
            raise HTTPException(status_code=401, detail="Email or password is incorrect.")
        user.last_login_at = datetime.utcnow()
        db.commit()
        return _session_response(user)
    finally:
        db.close()


@router.get("/session")
def session(request: Request):
    user = getattr(request.state, "auth_user", None)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated.")
    return {"user": _public_user(user)}
