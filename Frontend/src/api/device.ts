// =========================================================
// VISIONARY NEXUS - DEVICE API CLIENT
// =========================================================
//
// Single place that talks to the device endpoints, with the
// rules that keep the backend idempotent honoured on the client:
//
//  * reads (list / status) never create anything - they are safe to call
//    on mount, on a poll, on refresh and on HMR reload
//  * ONE creation path exists (startSetupSession) and it is de-duplicated
//    while in flight, so double clicks and StrictMode double-mounts issue a
//    single POST
//  * the device id of the current setup is remembered, so a wizard that is
//    reopened, backtracked or reloaded resumes the same device
//
// Relative URLs by default: the Vite dev server proxies /api to the backend,
// which also keeps the browser inside the sandbox preview host.
// =========================================================

const viteEnv =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {}

export const API_BASE = viteEnv.VITE_API_URL ?? ''

const STORAGE_KEY = 'visionary.device_id'

export type DeviceStatus =
  | 'awaiting_setup'
  | 'wifi_configuring'
  | 'connecting'
  | 'awaiting_registration'
  | 'registered'
  | 'online'
  | 'wifi_failed'
  | 'pairing_failed'
  | 'registration_failed'
  | 'camera_failed'
  | 'offline'

export interface DeviceDetail {
  id: number
  device_id: string
  hardware_uid: string | null
  name: string
  model: string
  firmware: string | null
  status: DeviceStatus
  status_detail: string | null
  last_error: string | null
  is_setup_pending: boolean
  is_failure: boolean
  registered: boolean
  online: boolean
  setup_attempts: number
  registration_count: number
  heartbeat_count: number
  created_at: string | null
  provisioned_at: string | null
  wifi_configured_at: string | null
  credentials_collected_at: string | null
  registered_at: string | null
  last_heartbeat_at: string | null
  wifi_ssid: string | null
  ip_address: string | null
  rssi: number | null
  battery: number | null
  temperature: number | null
  uptime_ms: number | null
  has_device_token: boolean
  device_token_last4: string | null
  token_generation: number
  pairing_code_active: boolean
  claim_state: string | null
  claim_id: string | null
  claim_requested_at: string | null
  claim_approved_at: string | null
  awaiting_approval: boolean
}

export interface DeviceSummary {
  id: number
  device_id: string
  hardware_uid: string | null
  name: string
  model: string
  firmware: string | null
  status: DeviceStatus
  status_detail: string | null
  registered: boolean
  online: boolean
  created_at: string | null
  registered_at: string | null
  last_heartbeat_at: string | null
  heartbeat_age_seconds: number | null
  ip_address: string | null
  wifi_ssid: string | null
  rssi: number | null
  battery: number | null
  temperature: number | null
  registration_count: number
  heartbeat_count: number
  setup_attempts: number
  is_setup_pending: boolean
  device_token_last4: string | null
  claim_state: string | null
  awaiting_approval: boolean
}

export interface DeviceListResponse {
  count: number
  total_count: number
  pending_device_id: string | null
  registered_count: number
  online_count: number
  devices: DeviceSummary[]
}

export interface SetupSessionResponse {
  created: boolean
  reused: boolean
  device_count: number
  warning: string | null
  device: DeviceDetail
}

export interface ProvisionResponse extends SetupSessionResponse {
  device_token: string
  device_token_reused: boolean
  pairing_code: string
  pairing_code_expires_at: string | null
  heartbeat_interval_seconds: number
}

export interface ProvisionStatusResponse {
  device: DeviceDetail
  device_count: number
  heartbeat_timeout_seconds: number
  heartbeat_interval_seconds: number
}

export interface DeviceIdentity {
  device_id: string
  device_token: string
  hardware_uid: string | null
}

export interface ClaimApprovalResponse {
  device: DeviceDetail
  claim_id: string | null
  claim_state: string
  device_token_reused: boolean
  device_token_last4: string | null
}

export interface BackendInfo {
  urls: string[]
  preferred: string
  port: number
  mdns_host: string
}

// =========================================================
// LOW LEVEL
// =========================================================

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`

    try {
      const body = await response.json()
      if (body?.detail) detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
    } catch {
      // response had no JSON body - keep the status text
    }

    throw new Error(detail)
  }

  return (await response.json()) as T
}

// =========================================================
// DEVICE ID MEMORY
// =========================================================

export function rememberedDeviceId(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function rememberDeviceId(deviceId: string | null) {
  try {
    if (deviceId) window.localStorage.setItem(STORAGE_KEY, deviceId)
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // private mode / storage disabled - the backend is still idempotent
  }
}

// =========================================================
// READS (never create anything)
// =========================================================

export function fetchDevices(signal?: AbortSignal): Promise<DeviceListResponse> {
  return request<DeviceListResponse>('/api/devices', { signal })
}

export function fetchDevice(
  deviceId: string,
  signal?: AbortSignal,
): Promise<{ device: DeviceDetail }> {
  return request<{ device: DeviceDetail }>(`/api/devices/${encodeURIComponent(deviceId)}`, {
    signal,
  })
}

/** Poll the setup progress. Read-only - safe on every tick. */
export function fetchProvisionStatus(
  deviceId: string | null,
  signal?: AbortSignal,
): Promise<ProvisionStatusResponse> {
  const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ''

  return request<ProvisionStatusResponse>(`/api/device/provision/status${query}`, { signal })
}

// =========================================================
// THE ONLY CREATION PATH
// =========================================================

let sessionInFlight: Promise<SetupSessionResponse> | null = null

/**
 * Find-or-create the single setup session.
 *
 * The backend returns the pending device if one exists, so calling this
 * after a reload, a retry or a double click can never add a device. While a
 * call is in flight every extra caller shares the same promise, which means
 * a burst of clicks still produces exactly one request.
 */
export function startSetupSession(): Promise<SetupSessionResponse> {
  if (!sessionInFlight) {
    const deviceId = rememberedDeviceId()

    sessionInFlight = request<SetupSessionResponse>('/api/device/session', {
      method: 'POST',
      body: JSON.stringify(deviceId ? { device_id: deviceId } : {}),
    })
      .then((session) => {
        rememberDeviceId(session.device.device_id)
        return session
      })
      .finally(() => {
        sessionInFlight = null
      })
  }

  return sessionInFlight
}

// =========================================================
// WRITES (all idempotent on the same device)
// =========================================================

/** Queue Wi-Fi credentials for the existing device and reuse its token. */
export function provisionDevice(input: {
  deviceId: string | null
  ssid: string
  password: string
}): Promise<ProvisionResponse> {
  return request<ProvisionResponse>('/api/device/provision', {
    method: 'POST',
    body: JSON.stringify({
      device_id: input.deviceId ?? rememberedDeviceId(),
      ssid: input.ssid,
      password: input.password,
    }),
  }).then((provisioned) => {
    rememberDeviceId(provisioned.device.device_id)
    return provisioned
  })
}

/** Restart the wizard on the SAME device row (retry after a failure). */
export function restartSetup(deviceId: string): Promise<{ device: DeviceDetail }> {
  return request<{ device: DeviceDetail }>(
    `/api/devices/${encodeURIComponent(deviceId)}/setup`,
    { method: 'POST' },
  )
}

// =========================================================
// CLAIM FLOW (zero typing on the device)
// =========================================================

/** Where this backend can be reached from the LAN - used to configure a
 *  device automatically instead of asking the user for an address. */
export function fetchBackendInfo(signal?: AbortSignal): Promise<BackendInfo> {
  return request<BackendInfo>('/api/device/backend-info', { signal })
}

/**
 * The URL a device on the same network must use.
 *
 * Prefers the address the browser is actually talking to (the Vite dev
 * server proxies /api to the backend, so both live on the same host), then
 * falls back to the backend's own LAN advertisement.
 */
export async function resolveDeviceBackendUrl(): Promise<string | null> {
  try {
    const info = await fetchBackendInfo()

    if (typeof window !== 'undefined' && window.location?.origin) {
      const origin = window.location.origin

      if (!origin.includes('localhost') && !origin.includes('127.0.0.1')) {
        return origin
      }
    }

    return info.preferred ?? info.urls?.[0] ?? null
  } catch {
    return null
  }
}

/** Approve the physical device that is waiting in the app. */
export function approveDeviceClaim(
  deviceId: string,
  claimId: string | null,
): Promise<ClaimApprovalResponse> {
  return request<ClaimApprovalResponse>(
    `/api/devices/${encodeURIComponent(deviceId)}/claim/approve`,
    { method: 'POST', body: JSON.stringify({ claim_id: claimId }) },
  )
}

export function rejectDeviceClaim(deviceId: string): Promise<{ claim_state: string }> {
  return request<{ claim_state: string }>(
    `/api/devices/${encodeURIComponent(deviceId)}/claim/reject`,
    { method: 'POST', body: JSON.stringify({}) },
  )
}

/**
 * Best-effort: push the backend address (and optionally the Wi-Fi details)
 * straight to a device that is currently hosting its setup access point, so
 * the user only ever types the Wi-Fi name and password.
 */
export async function pushConfigToDevice(input: {
  backendUrl: string
  ssid?: string
  password?: string
}): Promise<boolean> {
  try {
    const response = await fetch('http://192.168.4.1/api/backend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        backend_url: input.backendUrl,
        ssid: input.ssid,
        password: input.password,
      }),
    })

    return response.ok
  } catch {
    // The browser is not on the device's access point - the device will
    // resolve the backend itself (mDNS / app-pushed URL at claim time).
    return false
  }
}

// =========================================================
// DISPLAY HELPERS
// =========================================================

export const STATUS_LABELS: Record<DeviceStatus, string> = {
  awaiting_setup: 'AWAITING SETUP',
  wifi_configuring: 'WIFI CONFIGURING',
  connecting: 'CONNECTING',
  awaiting_registration: 'AWAITING REGISTRATION',
  registered: 'REGISTERED',
  online: 'ONLINE',
  wifi_failed: 'WIFI FAILED',
  pairing_failed: 'PAIRING FAILED',
  registration_failed: 'REGISTRATION FAILED',
  camera_failed: 'CAMERA FAILED',
  offline: 'OFFLINE',
}

export const STATUS_COLORS: Record<DeviceStatus, string> = {
  awaiting_setup: '#9ca3af',
  wifi_configuring: '#4d9eff',
  connecting: '#00e5ff',
  awaiting_registration: '#a855f7',
  registered: '#4ade80',
  online: '#4ade80',
  wifi_failed: '#ef4444',
  pairing_failed: '#ef4444',
  registration_failed: '#ef4444',
  camera_failed: '#f59e0b',
  offline: '#f59e0b',
}

export const SETUP_STEPS: { status: DeviceStatus; label: string; detail: string }[] = [
  { status: 'awaiting_setup', label: 'Session', detail: 'Device identity reserved' },
  { status: 'wifi_configuring', label: 'Wi-Fi', detail: 'Credentials queued for the device' },
  { status: 'connecting', label: 'Connect', detail: 'Device joined the network' },
  { status: 'awaiting_registration', label: 'Pairing', detail: 'Credential transferred' },
  { status: 'registered', label: 'Register', detail: 'ESP32 registered with its token' },
  { status: 'online', label: 'Online', detail: 'Heartbeats arriving' },
]

export function setupProgress(status: DeviceStatus): number {
  const index = SETUP_STEPS.findIndex((step) => step.status === status)

  if (index >= 0) return index

  // Failure / offline states: show the furthest step the device reached.
  if (status === 'offline') return SETUP_STEPS.length - 1

  return 1
}
