// =========================================================
// VISIONARY NEXUS - CAMERA API CLIENT
// =========================================================
//
// Talks to the backend camera endpoints (backend/camera_api.py):
//
//   GET /api/camera/status       configuration + last known state
//   GET /api/camera/health       live probe (TCP + one real frame)
//   GET /api/camera/snapshot     the latest JPEG (503 JSON when offline)
//   GET /api/camera/stream-info  stream URL / framing / measured rate
//
// The screen must stay usable when the ESP32-CAM is absent, so reads never
// throw: a failed call returns null and the caller keeps its last known state.
// Relative URLs by default - the Vite dev server proxies /api to the backend,
// which keeps the browser inside the sandbox preview host.
// =========================================================

const viteEnv =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {}

export const API_BASE = viteEnv.VITE_API_URL ?? ''

export interface CameraFrameInfo {
  source: string
  captured_at: string
  width: number
  height: number
  resolution: string
  bytes: number
  decoded: boolean
  latency_ms: number
  stale: boolean
  url: string
}

export interface CameraDeviceLink {
  device_id: string
  hardware_uid: string | null
  name: string
  model: string
  status: string
  ip_address: string | null
  camera_ready: boolean
  camera_sensor: string | null
  camera_initialized_at: string | null
  last_heartbeat_at: string | null
  last_seen_at: string | null
}

export interface CameraStatus {
  ok: boolean
  service: string
  source: {
    configured: string
    effective: string
    webcam_opt_in: boolean
  }
  configured: boolean
  stream_url: string
  snapshot_url: string
  url_origin: string
  port: number
  timeout_seconds: number
  reachable: boolean | null
  last_error: string
  last_checked_at: string | null
  frames_captured: number
  failures: number
  last_frame: CameraFrameInfo | null
  last_frame_age_seconds: number | null
  opencv: { available: boolean; version: string }
  device: CameraDeviceLink | null
  notes: string[]
  timestamp: string
}

export interface CameraHealth {
  ok: boolean
  service: string
  checked_url: string
  url_origin: string
  reachable: boolean
  latency_ms: number
  error: string
  frame?: CameraFrameInfo
  device: CameraDeviceLink | null
  disabled?: boolean
  timestamp: string
}

export interface CameraStreamInfo {
  ok: boolean
  service: string
  source: { configured: string; effective: string }
  stream: {
    url: string
    content_type: string
    boundary: string
    port: number
    url_origin: string
    snapshot_url: string
    format: string
  }
  resolution: { width: number; height: number; label: string }
  fps_estimate: number
  frames_captured: number
  last_frame: CameraFrameInfo | null
  opencv: { available: boolean; version: string }
  device: CameraDeviceLink | null
  notes: string[]
  timestamp: string
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${API_BASE}${path}`, { headers: { Accept: 'application/json' } })

    if (!response.ok) {
      return null
    }

    return (await response.json()) as T
  } catch {
    // Offline backend, proxy hiccup, aborted request - the screen keeps its
    // last known state instead of throwing inside a render.
    return null
  }
}

export function fetchCameraStatus(): Promise<CameraStatus | null> {
  return readJson<CameraStatus>('/api/camera/status')
}

export function fetchCameraHealth(): Promise<CameraHealth | null> {
  return readJson<CameraHealth>('/api/camera/health')
}

export function fetchCameraStreamInfo(): Promise<CameraStreamInfo | null> {
  return readJson<CameraStreamInfo>('/api/camera/stream-info')
}

/** URL for the latest frame; `tick` busts the cache so the image refreshes. */
export function cameraSnapshotUrl(tick = 0): string {
  return `${API_BASE}/api/camera/snapshot?t=${tick}`
}
