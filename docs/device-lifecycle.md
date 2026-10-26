# Device lifecycle & idempotent provisioning

This document is the contract behind `backend/device_api.py`,
`backend/security.py`, `firmware/camera/camera.ino` and
`Frontend/src/components/Device.tsx`.

## The invariant

> **One physical glasses device == one row in `devices`.**

Every entry point below either *reads* a device or *updates the existing*
device. Nothing except `POST /api/device/session` / `POST /api/device/provision`
can insert a row, and even those are find-or-create: they reuse the pending
setup session whenever one exists.

Duplicates are prevented in three layers:

1. **Application logic** – `_resolve_setup_device()` resolves a setup request
   against, in order of strength: the ESP32 `hardware_uid`, the assigned
   `device_id`, the single device currently inside the setup lifecycle, the
   only device in the database. Only if none of those match is a device created.
2. **Database constraints** – `devices.setup_slot` holds the constant
   `"pending"` while a device is in a setup state and `NULL` afterwards, and a
   *partial unique index* (`uq_devices_single_pending_setup`) makes two pending
   devices impossible even if two requests race. `hardware_uid` is unique too.
3. **Frontend** – reads (`GET /api/devices`, `GET /api/device/provision/status`)
   never create anything; the single creation path (`startSetupSession`) is
   de-duplicated while in flight and remembers the device id, so rerenders,
   polling, refresh, wizard backtracking, HMR reloads and retries all land on
   the same device.

## Statuses

Happy path:

```
awaiting_setup -> wifi_configuring -> connecting -> awaiting_registration -> registered -> online
```

Failure / non-happy states (kept separate, same row, retryable):

```
wifi_failed | pairing_failed | registration_failed | camera_failed | offline
```

| Status | Set by | Meaning |
| --- | --- | --- |
| `awaiting_setup` | `POST /api/device/session` | Identity reserved, wizard open. |
| `wifi_configuring` | `POST /api/device/provision` | Credentials queued for the device. **Not online.** |
| `connecting` | `POST /api/device/provision/report` (`wifi_connected`) | Device joined the network. |
| `awaiting_registration` | credentials collected **and** Wi-Fi up | Device must present its token. |
| `registered` | `POST /api/device/register` | Token accepted, awaiting first heartbeat. |
| `online` | `POST /api/device/heartbeat` | Heartbeat received within the timeout. |
| `offline` | `GET` (lazy) after `DEVICE_HEARTBEAT_TIMEOUT_SECONDS` | Was online, went quiet. |
| `wifi_failed` / `pairing_failed` / `camera_failed` | `POST /api/device/provision/report` | Device-side failure; the device stays in the setup slot. |
| `registration_failed` | reserved for repeated rejected registrations | Same device, retryable. |

`POST /api/device/provision` **never** marks a device online — only a heartbeat
from a registered device does.

## Where the backend lives (ports, binding)

| Component | Value | Source |
| --- | --- | --- |
| FastAPI entry point | `backend/api.py` → `app` | `uvicorn "api:app"` / `uvicorn backend.api:app` |
| Listen address | `HOST`, default `0.0.0.0` | `backend/api.py` `__main__` |
| Port | `PORT`, default **8000** | `backend/api.py` `__main__` |
| Frontend → backend | `VITE_BACKEND_URL`, default `http://127.0.0.1:<PORT>` | `Frontend/vite.config.ts` proxy |
| Device → backend | pushed by the app / mDNS / `NEXUS_FALLBACK_BACKEND_HOST` | firmware `resolveBackendUrl()` |

There is **one** FastAPI application. `backend/device_api.py` is a router that
is included into it (`app.include_router(device_router)`); it replaces nothing
and starts no second server. Moving the whole stack (for example to 8001) is a
single environment change, never a code edit:

```bash
PORT=8001 uvicorn backend.api:app --host 0.0.0.0 --port 8001   # backend
VITE_BACKEND_URL=http://127.0.0.1:8001 npm run dev             # frontend proxy
```

The host defaults to `0.0.0.0` because a glasses device on the LAN cannot reach
a backend bound to `127.0.0.1`.

## Zero-input claim flow (the physical ESP32 path)

The user types **only** a Wi-Fi SSID and password - on the device's own setup
page (`http://192.168.4.1/`, served by the ESP32) or in the app. A backend URL,
device id, pairing ticket, device token, IP address, port and MAC address are
never requested, and no API key is compiled into the firmware.

```
ESP32-CAM first boot
  -> opens setup AP "VisionaryNexus-XXXX" and serves a page with two fields
  -> POST /configure                : SSID + password            (NVS: wifi_ssid, wifi_password)
  -> joins the user's Wi-Fi
  -> POST /api/device/claim         : hardware_uid + claim_secret
                                      -> resolves/creates the ONE pending device,
                                         status connecting, claim_state pending_approval
  -> app shows "device waiting for approval" (hardware id + record)
  -> user taps APPROVE              : POST /api/devices/{id}/claim/approve
  -> POST /api/device/claim/poll    : claim_id + claim_secret
                                      -> receives device_id + device_token
                                         (the credential that already belongs to the
                                         device), plus backend_url and, if the backend
                                         has them, the Wi-Fi credentials
                                      (NVS: device_id, device_token, backend_url)
  -> POST /api/device/register      : Authorization: Bearer <device_token>
  -> POST /api/device/heartbeat     : Authorization: Bearer <device_token>  -> ONLINE
  -> esp_camera_init() on the OV2640 (AI-Thinker pin map)
  -> POST /api/device/provision/report { event: camera_ready, sensor: 0x26 }
                                     -> camera READY (only ever set by a
                                        successful sensor init + first frame)
```

Properties:

* the claim secret is generated **on the device** (`esp_random`) and only proves
  that the poller is the same board that opened the claim - it grants nothing
  and is never a credential;
* no credential is issued before the user approves a physical device;
* re-announcing (reboot, retry, re-flash with the same chip id) reuses the same
  claim and the same device row;
* re-polling after a missed response re-delivers the **same** token;
* if the board is rejected, the verdict is readable by that board only, which
  reopens its setup AP; the device row stays.

### ESP32 answers (what the firmware actually does)

| Question | Answer |
| --- | --- |
| Function that receives the credential | `fetchClaimCredential()` (claim poll) or `handleAppCredentials()` when the app pushes it over the setup AP |
| Preferences key that stores it | namespace `nexus`: `device_token` (with `device_id`) |
| Function that calls `/api/device/register` | `registerDevice()` |
| Authorization header | `Authorization: Bearer <device_token>` (added in `postJson(..., authenticated=true)`) |
| Heartbeat endpoint | `NEXUS_HEARTBEAT_PATH` = `/api/device/heartbeat`, sent by `sendHeartbeat()` |
| How the backend URL is obtained | `resolveBackendUrl()`: NVS `backend_url` (pushed by the app / delivered by the backend) → mDNS `nexus-backend.local` → `NEXUS_FALLBACK_BACKEND_HOST/PORT`. Never typed. |
| After a reboot | `loadIdentity()` restores `device_id`/`device_token`; the device reconnects, registers and heartbeats - no claim, no new device |
| If Wi-Fi changes | Wi-Fi failures reopen the setup AP (identity kept); the user enters the new SSID/password, or the app provisions them and the device collects them at claim time |
| If the credential is rejected (401) | `forgetCredential()` drops only the token; the device re-claims **the same** device id |
| Camera readiness | `cameraInit()` → `esp_camera_init()` on the AI-Thinker pin map; `ensureCameraReady()` runs after the first heartbeat; `reportCameraState()` sends `camera_ready` / `camera_failed`. Never derived from Wi-Fi or registration. |
| Backend discovery when no URL was pushed | `resolveBackendUrl()` → mDNS → fallback host, then `discoverBackendOnHost()` probes ports `{ 8000, 8001, 8080 }` with `GET /api/device/backend-info` and uses whichever answers. A backend on 8001 needs no rebuild and no typing. |

## Identity & credentials

| Identifier | Where it comes from | Why |
| --- | --- | --- |
| `device_id` (`SG-XXXX-XXXX`) | derived from the hardware uid when known, otherwise generated once | stable cloud identity; the frontend remembers it so reloads resume the same device |
| `hardware_uid` | ESP32 efuse MAC, reported by the firmware | strongest physical identifier; survives NVS wipes and re-flashes; unique in the DB |
| `device_token` (`sgn_dev_…`) | minted **once** per device | the credential the ESP32 presents on register/heartbeat. Stored as a peppered SHA-256 hash **and** as Fernet ciphertext, so a retry can be handed the same token instead of a new one |
| `pairing_code` (`ABCD-EFGH`) | minted on every `provision` call, TTL `DEVICE_PAIRING_CODE_TTL_SECONDS` (15 min) | one-shot proof that the caller was on the provisioning channel; exchanging it returns the *existing* token + Wi-Fi credentials, and it is destroyed on registration |
| `pairing_credential` (`sgn_pair_…`) | minted on first registration | long-lived reconnect secret returned with the registration response |

The plaintext token never appears in any read-only response. It is only
returned by `POST /api/device/provision` (to the app that is pairing the
device) and by `POST /api/device/provision/credentials` (to the device that
presented the pairing code) — and in both cases it is the token that already
belongs to the device row.

## Endpoints

| Method | Path | Effect |
| --- | --- | --- |
| `POST` | `/api/device/session` | Find-or-create the single setup session. Repeats return the same device. |
| `POST` | `/api/device/provision` | Reuse the device, queue Wi-Fi credentials, mint a fresh pairing code, return the **existing** token, set `wifi_configuring`. |
| `GET` | `/api/device/provision/status` | Read-only poll. No creation, no secrets. |
| `POST` | `/api/device/provision/credentials` | Device exchanges the pairing code for its token + Wi-Fi credentials. |
| `POST` | `/api/device/provision/report` | `wifi_connected` → `connecting`; `*_failed` → failure state. |
| `POST` | `/api/device/claim` | ESP32 announces itself (`hardware_uid` + device-generated claim secret) → the ONE pending device, `claim_state=pending_approval`. |
| `POST` | `/api/device/claim/poll` | Device waits for approval, then receives its existing credential + `backend_url` (+ Wi-Fi credentials if the app typed them). Re-polling re-delivers the same token. |
| `POST` | `/api/devices/{device_id}/claim/approve` | User confirms the physical device in the app. Nothing is issued before this. |
| `POST` | `/api/devices/{device_id}/claim/reject` | "Not my device": verdict readable by that board, row kept. |
| `GET` | `/api/device/backend-info` | LAN URLs the device may use - lets the app configure a device without the user typing an address. |
| `POST` | `/api/device/register` | Requires `device_id` + valid `device_token` (header or body); updates the existing row → `registered` (keeps `online` if it was). |
| `POST` | `/api/device/heartbeat` | Requires a valid token; updates the existing row → `online`. |
| `GET` | `/api/devices` | Registered Devices list + counts. Read-only. |
| `GET` | `/api/devices/{device_id}` | Single device. |
| `POST` | `/api/devices/{device_id}/setup` | Restart the wizard on the same row (keeps `device_id` + token). |

A device that stops sending heartbeats is reported as `offline` on the next
read; the row is never deleted and never re-created.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `sqlite:///./smartglasses.db` | Database location (tests use a temp file). |
| `DEVICE_TOKEN_PEPPER` | generated file `backend/.device_token_pepper` | Pepper for every credential hash. Rotating it invalidates stored hashes. |
| `DEVICE_TOKEN_KEY` | generated file `backend/.device_token_key` | Fernet key for recoverable credentials. Rotating it forces new tokens. |
| `DEVICE_HEARTBEAT_INTERVAL_SECONDS` | `10` | Advertised heartbeat interval. |
| `DEVICE_HEARTBEAT_TIMEOUT_SECONDS` | `30` | Age after which a device is reported `offline`. |
| `DEVICE_PAIRING_CODE_TTL_SECONDS` | `900` | Pairing code lifetime (app-push transport only). |
| `DEVICE_CLAIM_TTL_SECONDS` | `600` | How long a claim stays open before it is reported as expired. |
| `HOST` | `0.0.0.0` | Bind address, so a LAN device can reach the API. |
| `PORT` | `8000` | Backend port used by every component. |
| `DEVICE_BACKEND_URL` / `BACKEND_PUBLIC_HOST` / `DEVICE_MDNS_HOST` | - | Explicit URLs advertised to devices by `/api/device/backend-info`. |

## Is the physical firmware path proven?

Proven end to end against the real backend by
`tests/test_device_lifecycle.py::test_zero_input_claim_flow_end_to_end` and
`tools/device_sim.py --claim`: announce → approve → credential → register
(Bearer) → heartbeat → `online`, on one device row, with re-announce and
re-poll idempotent.

Not yet proven (needs the board): the Arduino compile (`arduino-cli compile
--fqbn esp32:esp32:esp32cam firmware/camera`), the actual AP join, mDNS
resolution on the user's router, and NVS persistence across a power cycle.
Those are the remaining on-hardware checks - see the checklist in the
integration report.

## Testing

```bash
# backend: idempotency suite (temp database, never touches smartglasses.db)
.venv/bin/python -m pytest tests/test_device_lifecycle.py -q

# end-to-end against a running backend, playing the ESP32
python tools/device_sim.py --repeat 2 --heartbeats 3
```

`tools/device_sim.py` keeps its identity in `.device_sim_state.json`, the same
way the firmware keeps it in NVS: deleting that file is equivalent to wiping
the ESP32 flash. Either way the device count must stay at 1 because the
`hardware_uid` is derived from the chip.
