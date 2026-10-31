import { API_BASE } from './camera'
import { VISION_TOKEN, type VisionPhotoResult } from './vision'

export async function captureVisionPhoto(): Promise<VisionPhotoResult> {
  const response = await fetch(`${API_BASE}/api/vision/photo`, {
    method: 'POST',
    headers: VISION_TOKEN ? { Authorization: `Bearer ${VISION_TOKEN}` } : {},
  })
  const result = await response.json() as VisionPhotoResult
  if (!response.ok || result.status !== 'ok') {
    throw new Error(result.error || `Photo analysis failed (${response.status}).`)
  }
  return result
}
