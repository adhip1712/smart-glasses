"""WhatsApp integrations for Visionary Nexus.

Personal accounts use official click-to-chat links (the user confirms Send).
Business accounts use Meta's WhatsApp Cloud API from the server only.
"""
import hashlib
import hmac
import json
import os
import re
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import APIRouter, Header, HTTPException, Query, Request as FastAPIRequest
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

try:
    from backend.auth_api import authenticate_token
    from backend.database import SessionLocal
    from backend.models import WhatsAppContact
except ImportError:
    from auth_api import authenticate_token
    from database import SessionLocal
    from models import WhatsAppContact

router = APIRouter(prefix="/api/whatsapp", tags=["whatsapp"])


def _business_config():
    return {
        "token": (os.getenv("WHATSAPP_ACCESS_TOKEN") or "").strip(),
        "phone_number_id": (os.getenv("WHATSAPP_PHONE_NUMBER_ID") or "").strip(),
        "business_account_id": (os.getenv("WHATSAPP_BUSINESS_ACCOUNT_ID") or "").strip(),
        "app_secret": (os.getenv("WHATSAPP_APP_SECRET") or "").strip(),
        "verify_token": (os.getenv("WHATSAPP_WEBHOOK_VERIFY_TOKEN") or "").strip(),
        "api_version": (os.getenv("WHATSAPP_GRAPH_API_VERSION") or "v23.0").strip(),
    }


def _require_user(authorization: str | None):
    scheme, _, token = (authorization or "").partition(" ")
    user = authenticate_token(token) if scheme.lower() == "bearer" and token else None
    if not user:
        raise HTTPException(status_code=401, detail="Sign in to Visionary Nexus to use WhatsApp.")
    return user

@router.get("/status")
def whatsapp_status(authorization: str | None = Header(default=None)):
    _require_user(authorization)
    config = _business_config()
    ready = bool(config["token"] and config["phone_number_id"])
    return {
        "success": True,
        "personal": {"available": True, "method": "official_click_to_chat", "requires_user_send_confirmation": True},
        "business": {
            "configured": ready,
            "webhook_configured": bool(config["verify_token"]),
            "business_account_id_configured": bool(config["business_account_id"]),
            "message": "WhatsApp Business Cloud API is ready." if ready else "Add the Meta Cloud API credentials to the backend environment to enable automatic Business sending.",
        },
    }


class ContactEntry(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    phone: str = Field(min_length=8, max_length=20)


class ContactsSyncRequest(BaseModel):
    contacts: list[ContactEntry] = Field(default_factory=list, max_length=2000)


@router.get("/contacts")
def get_whatsapp_contacts(authorization: str | None = Header(default=None)):
    user = _require_user(authorization)
    db = SessionLocal()
    try:
        rows = db.query(WhatsAppContact).filter(
            WhatsAppContact.user_id == user.id
        ).order_by(WhatsAppContact.name.asc()).all()
        return {
            "success": True,
            "contacts": [{"name": row.name, "phone": row.phone} for row in rows],
        }
    finally:
        db.close()


@router.put("/contacts")
def sync_whatsapp_contacts(payload: ContactsSyncRequest, authorization: str | None = Header(default=None)):
    user = _require_user(authorization)
    cleaned = {}
    for contact in payload.contacts:
        name = re.sub(r"\s+", " ", contact.name).strip()
        phone = re.sub(r"[^0-9]", "", contact.phone)
        if not name or not 8 <= len(phone) <= 15:
            continue
        cleaned[phone] = {"name": name[:160], "phone": phone}
    if len(cleaned) > 2000:
        raise HTTPException(status_code=422, detail="A maximum of 2,000 contacts can be synced.")
    db = SessionLocal()
    try:
        db.query(WhatsAppContact).filter(
            WhatsAppContact.user_id == user.id
        ).delete(synchronize_session=False)
        db.add_all([
            WhatsAppContact(user_id=user.id, name=item["name"], phone=item["phone"])
            for item in cleaned.values()
        ])
        db.commit()
        return {"success": True, "count": len(cleaned), "contacts": list(cleaned.values())}
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


class BusinessSendRequest(BaseModel):
    to: str = Field(min_length=8, max_length=20)
    message: str = Field(min_length=1, max_length=4096)
    opt_in_confirmed: bool = False


@router.post("/business/send")
def send_business_message(payload: BusinessSendRequest, authorization: str | None = Header(default=None)):
    _require_user(authorization)
    config = _business_config()
    if not config["token"] or not config["phone_number_id"]:
        raise HTTPException(status_code=503, detail="WhatsApp Business is not configured. Add WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID to the backend environment.")
    if not payload.opt_in_confirmed:
        raise HTTPException(status_code=400, detail="Confirm that the recipient has agreed to receive WhatsApp messages before sending.")
    recipient = re.sub(r"[^0-9]", "", payload.to)
    if not 8 <= len(recipient) <= 15:
        raise HTTPException(status_code=422, detail="Use the recipient's international phone number, including country code.")
    url = f"https://graph.facebook.com/{config['api_version']}/{config['phone_number_id']}/messages"
    body = {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": recipient,
        "type": "text",
        "text": {"preview_url": False, "body": payload.message.strip()},
    }
    request = Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {config['token']}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=15) as response:
            result = json.loads(response.read().decode("utf-8", errors="replace"))
        messages = result.get("messages") or []
        return {
            "success": bool(messages),
            "message_id": (messages[0] or {}).get("id") if messages else None,
            "recipient": recipient,
            "status": "accepted_by_whatsapp" if messages else "unknown",
            "detail": "WhatsApp accepted the message request. Delivery status may arrive later through the webhook.",
        }
    except HTTPError as error:
        try:
            detail = json.loads(error.read().decode("utf-8", errors="replace"))
            detail = detail.get("error", {}).get("message") or "Meta rejected the WhatsApp message."
        except Exception:
            detail = "Meta rejected the WhatsApp message."
        raise HTTPException(status_code=502, detail=detail)
    except (URLError, TimeoutError, ValueError):
        raise HTTPException(status_code=502, detail="Could not reach the WhatsApp Business API. Check the backend connection and Meta configuration.")


@router.get("/webhook")
def verify_whatsapp_webhook(
    hub_mode: str | None = Query(default=None, alias="hub.mode"),
    hub_verify_token: str | None = Query(default=None, alias="hub.verify_token"),
    hub_challenge: str | None = Query(default=None, alias="hub.challenge"),
):
    config = _business_config()
    if hub_mode == "subscribe" and config["verify_token"] and hmac.compare_digest(hub_verify_token or "", config["verify_token"]):
        return PlainTextResponse(hub_challenge or "")
    raise HTTPException(status_code=403, detail="WhatsApp webhook verification failed.")


@router.post("/webhook")
async def receive_whatsapp_webhook(request: FastAPIRequest, x_hub_signature_256: str | None = Header(default=None)):
    config = _business_config()
    raw = await request.body()
    if not config["app_secret"]:
        raise HTTPException(status_code=503, detail="Set WHATSAPP_APP_SECRET before enabling Meta webhooks.")
    expected = "sha256=" + hmac.new(config["app_secret"].encode("utf-8"), raw, hashlib.sha256).hexdigest()
    if not x_hub_signature_256 or not hmac.compare_digest(x_hub_signature_256, expected):
        raise HTTPException(status_code=401, detail="Invalid Meta webhook signature.")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail="Invalid webhook payload.")
    # Acknowledge Meta callbacks. Message content is not copied into the app's AI chat history.
    return {"success": True, "received": bool(payload.get("entry"))}
