// =========================================================
// VISIONARY NEXUS - VISION / ML API CLIENT
// =========================================================
//
// Talks to the backend vision endpoints (backend/vision_api.py), which drive the
// laptop webcam through Ultralytics YOLO:
//
//   GET  /api/vision/status      camera + model + worker health
//   GET  /api/vision/health      compact liveness
//   GET  /api/vision/detections  latest detections as JSON
//   POST /api/vision/start       start the managed worker
//   POST /api/vision/stop        stop it and release the camera
//   GET  /api/vision/frame       latest annotated JPEG (needs VISION_STREAM_TOKEN)
//   GET  /api/vision/stream      MJPEG preview          (needs VISION_STREAM_TOKEN)
//
// Access model, matching the backend:
//   * status/health/detections carry no pixels and are readable, exactly like
//     the existing /api/camera/* endpoints
//   * raw frames are served ONLY when the backend has VISION_STREAM_TOKEN set,
//     so the token is optional here too: without it the screen shows real
//     detections over its existing visuals and reports that video is disabled
//
// Reads never throw: a failed call returns null so the screen keeps its last
// known state instead of crashing. Relative URLs by default - the Vite dev
// server proxies /api to the backend.
// =========================================================

import { API_BASE } from './camera'

const viteEnv =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {}

/** Optional: set VITE_VISION_TOKEN to enable the annotated video preview. */
export const VISION_TOKEN = viteEnv.VITE_VISION_TOKEN ?? ''

export interface VisionBox {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface VisionDetection {
  label: string
  class_id: number
  confidence: number
  box: VisionBox
  center?: { x: number; y: number }
  width: number
  height: number
  area: number
  track_id: number | null
  tracked: boolean
  /** 0..1 fractions of the frame, for drawing on a scaled preview. */
  box_normalized?: { x: number; y: number; width: number; height: number }
}

export interface VisionDetections {
  status: 'ok' | 'no_result'
  running: boolean
  stale: boolean
  frame_age_seconds: number
  fps: number
  frames: number
  count: number
  labels: Record<string, number>
  inference_ms: number
  tracked: boolean
  frame?: { width: number; height: number }
  detections: VisionDetection[]
  errors: string[]
}

export interface VisionStatus {
  running: boolean
  enabled: boolean
  healthy: boolean
  ml_available: boolean
  ml_import_error?: string
  camera_available: boolean
  model_available: boolean
  model_loaded: boolean
  tracking: boolean
  frames: number
  fps: number
  inference_ms: number
  errors: string[]
  source: string
  stream_endpoint_enabled: boolean
  camera?: {
    type: string
    is_open: boolean
    index?: number
    resolution?: string
    width?: number
    height?: number
  }
  model?: {
    loaded: boolean
    available: boolean
    ultralytics_version: string
    path: string
    weights_present: boolean
    device: string
    confidence: number
    imgsz: number
    tracking: boolean
    class_count: number
    last_inference_ms: number
    average_inference_ms: number
    error: string
  }
}

export interface VisionActionResult {
  status: string
  started?: boolean
  already_running?: boolean
  stopped?: boolean
  was_running?: boolean
  error?: string
}

function authHeaders(): Record<string, string> {
  return VISION_TOKEN ? { Authorization: `Bearer ${VISION_TOKEN}` } : {}
}

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T
  } catch {
    return null
  }
}

/** Camera + model + worker health. null when the call failed. */
export async function fetchVisionStatus(): Promise<VisionStatus | null> {
  try {
    const response = await fetch(`${API_BASE}/api/vision/status`)

    return response.ok ? await readJson<VisionStatus>(response) : null
  } catch {
    return null
  }
}

/** The latest detections. null when the call failed (not when there are none). */
export async function fetchVisionDetections(): Promise<VisionDetections | null> {
  try {
    const response = await fetch(`${API_BASE}/api/vision/detections`)

    return response.ok ? await readJson<VisionDetections>(response) : null
  } catch {
    return null
  }
}

/** Start the managed capture+inference worker. Duplicate calls are safe. */
export async function startVision(): Promise<VisionActionResult | null> {
  try {
    const response = await fetch(`${API_BASE}/api/vision/start`, {
      method: 'POST',
      headers: authHeaders(),
    })

    return await readJson<VisionActionResult>(response)
  } catch {
    return null
  }
}

/** Stop the worker and release the laptop webcam. Duplicate calls are safe. */
export async function stopVision(): Promise<VisionActionResult | null> {
  try {
    const response = await fetch(`${API_BASE}/api/vision/stop`, {
      method: 'POST',
      headers: authHeaders(),
    })

    return await readJson<VisionActionResult>(response)
  } catch {
    return null
  }
}

/**
 * URL of the latest annotated JPEG. Returns '' when no token is configured,
 * because the backend refuses to serve frames to an unauthenticated client.
 */
export function visionFrameUrl(tick = 0): string {
  if (!VISION_TOKEN) return ''

  return `${API_BASE}/api/vision/frame?token=${encodeURIComponent(VISION_TOKEN)}&_=${tick}`
}

/** Whether the annotated video preview can be shown from the browser. */
export function visionVideoAvailable(): boolean {
  return Boolean(VISION_TOKEN)
}
