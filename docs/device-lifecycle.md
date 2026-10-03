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
| `POST` | `/api/device/register` | Requires `device_id` + valid `device_token`; updates the existing row → `registered` (keeps `online` if it was). |
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
| `DEVICE_PAIRING_CODE_TTL_SECONDS` | `900` | Pairing code lifetime. |

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
