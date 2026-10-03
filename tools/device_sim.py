#!/usr/bin/env python3
# =========================================================
# VISIONARY NEXUS - ESP32 DEVICE SIMULATOR
# =========================================================
#
# Stands in for firmware/camera/camera.ino when no board is on the desk.
# It performs exactly the same HTTP calls, in the same order:
#
#   1. POST /api/device/session              (find-or-create the setup session)
#   2. POST /api/device/provision            (app side: queue Wi-Fi creds)
#   3. POST /api/device/provision/credentials (exchange the pairing code)
#   4. POST /api/device/provision/report      (wifi_connected)
#   5. POST /api/device/register              (stored token)
#   6. POST /api/device/heartbeat             (-> ONLINE)
#
# Usage:
#   python tools/device_sim.py                     # full setup once
#   python tools/device_sim.py --repeat 3          # setup + 2 retries
#   python tools/device_sim.py --state state.json  # keep the identity between runs
#   python tools/device_sim.py --heartbeats 5      # heartbeats after registering
#
# The state file is the simulator's "NVS": as long as it exists the simulator
# reconnects as the same physical device instead of starting a new setup.
# =========================================================

from __future__ import annotations

import argparse
import json
import os
import random
import time
import urllib.error
import urllib.request

DEFAULT_BACKEND = os.getenv("NEXUS_BACKEND_URL", "http://127.0.0.1:8000")


def call(
    base_url: str,
    method: str,
    path: str,
    payload: dict | None = None,
) -> tuple[int, dict]:
    url = f"{base_url.rstrip('/')}{path}"
    data = json.dumps(payload).encode() if payload is not None else None

    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )

    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            body = response.read().decode()
            return response.status, (json.loads(body) if body else {})
    except urllib.error.HTTPError as error:
        body = error.read().decode()

        try:
            return error.code, json.loads(body) if body else {}
        except json.JSONDecodeError:
            return error.code, {"detail": body}
    except urllib.error.URLError as error:
        raise SystemExit(f"backend unreachable at {url}: {error}")


def load_state(path: str | None) -> dict:
    if not path or not os.path.exists(path):
        return {}

    with open(path) as handle:
        return json.load(handle)


def save_state(path: str | None, state: dict) -> None:
    if not path:
        return

    with open(path, "w") as handle:
        json.dump(state, handle, indent=2)


def device_count(base_url: str) -> int:
    status, body = call(base_url, "GET", "/api/devices")
    return int(body.get("count", 0))


def claim_flow(base_url: str, args) -> dict:
    """Exactly what firmware/camera/camera.ino does on a fresh board:

    the user types only the Wi-Fi SSID + password, the device announces
    itself, the user approves it in the app, and the device receives the
    credential the backend already reserved for it.
    """

    state = load_state(args.state)
    claim_secret = state.get("claim_secret") or "".join(
        random.choice("0123456789abcdef") for _ in range(32)
    )

    status, announced = call(
        base_url,
        "POST",
        "/api/device/claim",
        {
            "hardware_uid": args.hardware_uid,
            "claim_secret": claim_secret,
            "firmware": "1.0.0",
            "model": "ESP32-CAM",
        },
    )

    claim_id = announced["claim_id"]
    device_id = announced["device_id"]
    print(f"claim             -> {status} state={announced['claim_state']} "
          f"device={device_id} reused={announced['reused']}")

    status, pending = call(
        base_url, "POST", "/api/device/claim/poll",
        {"claim_id": claim_id, "claim_secret": claim_secret},
    )
    print(f"poll (pre-approve)-> {status} state={pending['claim_state']} "
          f"token_delivered={'device_token' in pending}")

    if args.auto_approve:
        status, approved = call(
            base_url, "POST", f"/api/devices/{device_id}/claim/approve",
            {"claim_id": claim_id},
        )
        print(f"approve (in app)  -> {status} state={approved['claim_state']}")

    status, delivered = call(
        base_url, "POST", "/api/device/claim/poll",
        {"claim_id": claim_id, "claim_secret": claim_secret},
    )

    if status != 200 or "device_token" not in delivered:
        raise SystemExit(f"credential was not delivered: {status} {delivered}")

    token = delivered["device_token"]
    print(f"credential        -> {status} device={delivered['device_id']} "
          f"backend_url={delivered.get('backend_url')}")

    payload = {
        "device_id": delivered["device_id"],
        "device_token": token,
        "hardware_uid": args.hardware_uid,
        "firmware": "1.0.0",
        "ip": "192.168.1.47",
    }

    status, registered = call(base_url, "POST", "/api/device/register", payload)
    print(f"register          -> {status} status={registered.get('status')} "
          f"already={registered.get('already_registered')}")

    for beat in range(1, args.heartbeats + 1):
        status, heart = call(
            base_url, "POST", "/api/device/heartbeat",
            {"device_id": delivered["device_id"], "device_token": token,
             "ip": "192.168.1.47", "battery": 90 - beat, "uptime_ms": beat * 10000},
        )
        print(f"heartbeat #{beat:<2}     -> {status} status={heart.get('status')} "
              f"count={heart.get('heartbeat', {}).get('count')}")

    save_state(
        args.state,
        {
            "device_id": delivered["device_id"],
            "device_token": token,
            "claim_secret": claim_secret,
        },
    )

    return {"device_id": delivered["device_id"], "device_token": token}


def main() -> None:
    parser = argparse.ArgumentParser(description="Simulate the Visionary Nexus ESP32")
    parser.add_argument("--backend", default=DEFAULT_BACKEND)
    parser.add_argument("--ssid", default="SG-Network-5G")
    parser.add_argument("--password", default="super-secret-wifi")
    parser.add_argument("--hardware-uid", default="A0:B1:C2:03:04:05")
    parser.add_argument("--state", default=".device_sim_state.json")
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--heartbeats", type=int, default=3)
    parser.add_argument("--forget", action="store_true", help="ignore the saved identity (wipe NVS)")
    parser.add_argument(
        "--claim",
        action="store_true",
        help="use the zero-input claim flow of the physical firmware",
    )
    parser.add_argument(
        "--auto-approve",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="simulate the user approving the device in the app (default: on)",
    )
    args = parser.parse_args()

    if args.forget and args.state and os.path.exists(args.state):
        os.remove(args.state)

    state = load_state(args.state)

    print(f"backend: {args.backend}")
    print(f"devices before: {device_count(args.backend)}")

    if args.claim:
        for attempt in range(1, args.repeat + 1):
            print(f"\n--- claim attempt {attempt} (devices now {device_count(args.backend)}) ---")
            # A reboot loses the claim id but keeps the device identity.
            if attempt > 1:
                state = load_state(args.state)
                state.pop("claim_id", None)
                save_state(args.state, state)
            claim_flow(args.backend, args)

        status, listing = call(args.backend, "GET", "/api/devices")
        print(f"\ndevices after: {listing['count']}")
        for device in listing["devices"]:
            print(f"  {device['device_id']}  {device['status']:<22} "
                  f"registered={device['registered']} heartbeats={device['heartbeat_count']} "
                  f"claim={device.get('claim_state')}")
        if listing["count"] > 1:
            print("\nWARNING: more than one device row - the duplicate bug is back")
            raise SystemExit(1)
        return

    for attempt in range(1, args.repeat + 1):
        print(f"\n--- setup attempt {attempt} (devices now {device_count(args.backend)}) ---")

        session_payload: dict = {"hardware_uid": args.hardware_uid}

        if state.get("device_id"):
            session_payload["device_id"] = state["device_id"]

        status, session = call(args.backend, "POST", "/api/device/session", session_payload)
        print(f"session           -> {status} created={session.get('created')} "
              f"device={session.get('device', {}).get('device_id')}")

        device_id = session["device"]["device_id"]

        status, provisioned = call(
            args.backend,
            "POST",
            "/api/device/provision",
            {
                "device_id": device_id,
                "hardware_uid": args.hardware_uid,
                "ssid": args.ssid,
                "password": args.password,
            },
        )

        token = provisioned["device_token"]
        print(f"provision         -> {status} status={provisioned['device']['status']} "
              f"token_reused={provisioned['device_token_reused']} "
              f"code={provisioned['pairing_code']}")

        status, credentials = call(
            args.backend,
            "POST",
            "/api/device/provision/credentials",
            {"device_id": device_id, "pairing_code": provisioned["pairing_code"]},
        )

        assert credentials["device_token"] == token, "backend re-issued a different token!"
        print(f"credentials       -> {status} same_token=True")

        status, reported = call(
            args.backend,
            "POST",
            "/api/device/provision/report",
            {
                "device_id": device_id,
                "device_token": token,
                "hardware_uid": args.hardware_uid,
                "event": "wifi_connected",
                "ip": "192.168.1.47",
                "rssi": -52,
                "firmware": "1.0.0",
            },
        )
        print(f"report wifi       -> {status} status={reported['device']['status']}")

        status, registered = call(
            args.backend,
            "POST",
            "/api/device/register",
            {
                "device_id": device_id,
                "device_token": token,
                "hardware_uid": args.hardware_uid,
                "firmware": "1.0.0",
                "ip": "192.168.1.47",
                "rssi": -52,
            },
        )
        print(f"register          -> {status} status={registered['status']} "
              f"already_registered={registered['already_registered']}")

        for beat in range(1, args.heartbeats + 1):
            status, heart = call(
                args.backend,
                "POST",
                "/api/device/heartbeat",
                {
                    "device_id": device_id,
                    "device_token": token,
                    "ip": "192.168.1.47",
                    "rssi": -52 + random.randint(-4, 4),
                    "battery": 88 - beat,
                    "temperature": 38,
                    "uptime_ms": beat * 10000,
                    "firmware": "1.0.0",
                },
            )
            print(f"heartbeat #{beat:<2}     -> {status} status={heart['status']} "
                  f"count={heart['heartbeat']['count']}")
            time.sleep(0.2)

        state = {"device_id": device_id, "device_token": token}
        save_state(args.state, state)

    status, listing = call(args.backend, "GET", "/api/devices")
    print(f"\ndevices after: {listing['count']}")

    for device in listing["devices"]:
        print(
            f"  {device['device_id']}  {device['status']:<22} "
            f"registered={device['registered']} heartbeats={device['heartbeat_count']} "
            f"token=••••{device['device_token_last4']}"
        )

    if listing["count"] > 1:
        print("\nWARNING: more than one device row - the duplicate bug is back")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
