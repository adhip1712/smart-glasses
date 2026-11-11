"""YouTube account OAuth and playlist publishing for Visionary Nexus."""
import json
import os
import secrets
import time
from pathlib import Path
from dotenv import load_dotenv
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse

try:
    from backend.database import SessionLocal
    from backend.models import Setting
except ImportError:
    from database import SessionLocal
    from models import Setting

router = APIRouter(prefix="/api/music/youtube-oauth", tags=["youtube"])
_PENDING_STATES = {}


def _config():
    # Load the repository-root .env explicitly. This module can be imported
    # before backend.api initializes its environment, depending on the entry point.
    load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=False)
    return (
        (os.getenv("YOUTUBE_CLIENT_ID") or "").strip(),
        (os.getenv("YOUTUBE_CLIENT_SECRET") or "").strip(),
        (os.getenv("YOUTUBE_REDIRECT_URI") or "").strip(),
    )


def _read_oauth():
    db = SessionLocal()
    try:
        row = db.query(Setting).filter(Setting.user_id == "local_user").first()
        try:
            data = json.loads(row.data or "{}") if row else {}
        except (TypeError, ValueError):
            data = {}
        return data.get("youtube_oauth") or {}
    finally:
        db.close()


def _save_oauth(value):
    db = SessionLocal()
    try:
        row = db.query(Setting).filter(Setting.user_id == "local_user").first()
        if row is None:
            row = Setting(user_id="local_user", data="{}")
            db.add(row)
        try:
            data = json.loads(row.data or "{}")
        except (TypeError, ValueError):
            data = {}
        data["youtube_oauth"] = value
        row.data = json.dumps(data)
        db.commit()
    finally:
        db.close()


def _google_request(url, payload=None, token=None):
    headers = {"Accept": "application/json"}
    body = None
    if payload is not None:
        body = urlencode(payload).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    if token:
        headers["Authorization"] = "Bearer " + token
    request = Request(url, data=body, headers=headers, method="POST" if body is not None else "GET")
    try:
        with urlopen(request, timeout=20) as response:
            raw = response.read().decode("utf-8", errors="replace")
            return json.loads(raw) if raw else {}
    except HTTPError as error:
        try:
            detail = json.loads(error.read().decode("utf-8", errors="replace"))
            message = (detail.get("error") or {}).get("message") or str(detail.get("error") or error)
        except Exception:
            message = str(error)
        raise HTTPException(status_code=502, detail="YouTube API: " + message)
    except (URLError, TimeoutError, ValueError) as error:
        raise HTTPException(status_code=502, detail="Could not reach Google: " + str(error))


def _access_token():
    client_id, client_secret, redirect_uri = _config()
    if not client_id or not client_secret or not redirect_uri:
        raise HTTPException(status_code=503, detail="Configure YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET and YOUTUBE_REDIRECT_URI in the repository-root .env file.")
    saved = _read_oauth()
    if not saved.get("refresh_token"):
        raise HTTPException(status_code=401, detail="Connect your YouTube account first.")
    if saved.get("access_token") and time.time() < float(saved.get("expires_at") or 0) - 60:
        return saved["access_token"]
    token_data = _google_request(
        "https://oauth2.googleapis.com/token",
        {
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": saved["refresh_token"],
            "grant_type": "refresh_token",
        },
    )
    access = token_data.get("access_token")
    if not access:
        raise HTTPException(status_code=401, detail="YouTube authorization expired. Reconnect your account.")
    saved["access_token"] = access
    saved["expires_at"] = time.time() + int(token_data.get("expires_in") or 3600)
    _save_oauth(saved)
    return access


@router.get("/status")
def youtube_oauth_status():
    client_id, client_secret, redirect_uri = _config()
    saved = _read_oauth()
    return {
        "configured": bool(client_id and client_secret and redirect_uri),
        "connected": bool(saved.get("refresh_token")),
        "channel": saved.get("channel_title") or "",
        "message": "" if client_id and client_secret and redirect_uri else "Google OAuth credentials are not configured in the repository-root .env.",
    }


@router.get("/start")
def youtube_oauth_start():
    client_id, client_secret, redirect_uri = _config()
    if not client_id or not client_secret or not redirect_uri:
        raise HTTPException(status_code=503, detail="Configure YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET and YOUTUBE_REDIRECT_URI in the repository-root .env file.")
    state = secrets.token_urlsafe(32)
    _PENDING_STATES[state] = time.time() + 600
    for key, expiry in list(_PENDING_STATES.items()):
        if expiry < time.time():
            _PENDING_STATES.pop(key, None)
    params = urlencode({
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "https://www.googleapis.com/auth/youtube.force-ssl",
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "true",
        "state": state,
    })
    return {"success": True, "authorization_url": "https://accounts.google.com/o/oauth2/v2/auth?" + params}


@router.get("/callback", response_class=HTMLResponse)
def youtube_oauth_callback(code: str = "", state: str = "", error: str = ""):
    if error:
        return HTMLResponse("<h2>YouTube connection was cancelled.</h2><p>You can close this tab.</p>", status_code=400)
    expiry = _PENDING_STATES.pop(state, 0)
    if not state or expiry < time.time() or not code:
        return HTMLResponse("<h2>Could not verify Google authorization.</h2><p>Return to Visionary Nexus and try again.</p>", status_code=400)
    client_id, client_secret, redirect_uri = _config()
    token_data = _google_request("https://oauth2.googleapis.com/token", {
        "code": code,
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    })
    access = token_data.get("access_token")
    if not access:
        return HTMLResponse("<h2>YouTube authorization failed.</h2><p>Return to Visionary Nexus and try again.</p>", status_code=400)
    old = _read_oauth()
    saved = {
        "access_token": access,
        "refresh_token": token_data.get("refresh_token") or old.get("refresh_token", ""),
        "expires_at": time.time() + int(token_data.get("expires_in") or 3600),
    }
    profile = _google_request("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", token=access)
    items = profile.get("items") or []
    if items:
        saved["channel_title"] = (items[0].get("snippet") or {}).get("title", "")
    _save_oauth(saved)
    return HTMLResponse("""<!doctype html><html><head><title>Visionary Nexus</title></head>
<body style="font-family:system-ui;background:#0b1220;color:white;padding:40px">
<h2>YouTube connected to Visionary Nexus</h2><p>You can close this tab and return to your playlist import.</p>
<script>setTimeout(()=>window.close(),1200)</script></body></html>""")


@router.post("/playlists")
def youtube_create_playlist(payload: dict):
    name = str(payload.get("name") or "Visionary Nexus playlist").strip()[:150]
    tracks = payload.get("tracks")
    if not isinstance(tracks, list) or not tracks:
        raise HTTPException(status_code=422, detail="Add at least one matched YouTube video.")
    video_ids = []
    for track in tracks:
        video_id = str((track or {}).get("id") or "").strip()
        if video_id and video_id not in video_ids:
            video_ids.append(video_id)
    if not video_ids:
        raise HTTPException(status_code=422, detail="No valid YouTube video IDs were supplied.")
    token = _access_token()
    # YouTube Data API requires JSON bodies for playlist and playlistItems inserts.
    def api_insert(url, body):
        request = Request(url, data=json.dumps(body).encode("utf-8"), headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }, method="POST")
        try:
            with urlopen(request, timeout=20) as response:
                return json.loads(response.read().decode("utf-8", errors="replace"))
        except HTTPError as error:
            try:
                detail = json.loads(error.read().decode("utf-8", errors="replace"))
                message = (detail.get("error") or {}).get("message") or str(detail.get("error") or error)
            except Exception:
                message = str(error)
            raise HTTPException(status_code=502, detail="YouTube API: " + message)
        except (URLError, TimeoutError, ValueError) as error:
            raise HTTPException(status_code=502, detail="Could not reach YouTube: " + str(error))

    playlist = api_insert("https://www.googleapis.com/youtube/v3/playlists?part=snippet,status", {
        "snippet": {"title": name, "description": "Created automatically by Visionary Nexus from an imported playlist."},
        "status": {"privacyStatus": "private"},
    })
    playlist_id = str(playlist.get("id") or "")
    if not playlist_id:
        raise HTTPException(status_code=502, detail="YouTube did not return a playlist ID.")
    added = []
    failed = []
    for video_id in video_ids:
        try:
            api_insert("https://www.googleapis.com/youtube/v3/playlistItems?part=snippet", {
                "snippet": {"playlistId": playlist_id, "resourceId": {"kind": "youtube#video", "videoId": video_id}},
            })
            added.append(video_id)
        except HTTPException as error:
            failed.append({"video_id": video_id, "error": str(error.detail)})
    return {
        "success": bool(added),
        "playlist_id": playlist_id,
        "playlist_url": "https://www.youtube.com/watch?v=" + added[0] + "&list=" + playlist_id + "&autoplay=1",
        "youtube_playlist_url": "https://www.youtube.com/playlist?list=" + playlist_id,
        "added_count": len(added),
        "added_video_ids": added,
        "failed_count": len(failed),
        "failed": failed[:10],
    }
