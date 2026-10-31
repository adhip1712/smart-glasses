import { useState, useEffect } from 'react'

import { cameraSnapshotUrl, fetchCameraStatus, type CameraStatus } from '../api/camera'
import {
  fetchVisionDetections,
  fetchVisionStatus,
  fetchVisionEvents,
  analyzeVisionScene,
  type VisionEvent,
  type VisionEventStatus,
  startVision,
  stopVision,
  visionFrameUrl,
  visionVideoAvailable,
  VISION_TOKEN,
  type VisionDetection,
  type VisionDetections,
  type VisionStatus,
} from '../api/vision'

// Fallback visuals only. Whenever the ML worker returns real detections these
// are not used - the screen shows what the model actually found.
const detectedObjects = [
  { label: 'Laptop', confidence: 96.2, x: 15, y: 20, w: 35, h: 25, color: '#00e5ff' },
  { label: 'Coffee Mug', confidence: 89.1, x: 60, y: 55, w: 12, h: 18, color: '#a855f7' },
  { label: 'Notebook', confidence: 91.8, x: 52, y: 20, w: 20, h: 30, color: '#4d9eff' },
  { label: 'Person', confidence: 98.4, x: 72, y: 10, w: 22, h: 60, color: '#4ade80' },
]

// One stable colour per COCO class id, so an object keeps its colour.
const detectionPalette = ['#00e5ff', '#ffb020', '#a855f7', '#4ade80', '#4d9eff', '#ff79c6', '#facc15', '#ff9178']

const colourForClass = (classId: number) =>
  detectionPalette[Math.abs(classId) % detectionPalette.length]

/** Normalise a real or simulated object into the percentages the overlay draws. */
interface OverlayObject {
  key: string
  label: string
  confidence: number
  x: number
  y: number
  w: number
  h: number
  color: string
  trackId: number | null
}

const toOverlay = (detection: VisionDetection): OverlayObject | null => {
  const box = detection.box_normalized

  if (!box) return null

  return {
    key: detection.track_id !== null ? `track-${detection.track_id}` : `${detection.label}-${detection.box.x1}-${detection.box.y1}`,
    label: detection.label,
    confidence: detection.confidence * 100,
    x: box.x * 100,
    y: box.y * 100,
    w: box.width * 100,
    h: box.height * 100,
    color: colourForClass(detection.class_id),
    trackId: detection.track_id,
  }
}

const sceneDescription = "Office workspace with 4 people detected. Overhead fluorescent lighting, daytime. Approximately 12m² visible area. No hazards detected. Wi-Fi networks visible: 3. Dominant colors: white, grey, blue."

export default function Vision() {
  const [scanning, setScanning] = useState(true)
  const [scanY, setScanY] = useState(0)
  const [showObjects, setShowObjects] = useState(true)
  const [captureFlash, setCaptureFlash] = useState(false)
  const [photoBusy, setPhotoBusy] = useState(false)
  const [photoError, setPhotoError] = useState('')
  const [photoResult, setPhotoResult] = useState<any>(null)

  // Real ESP32-CAM state. The screen keeps working when the board is absent:
  // `camera` stays null, `frameFailed` falls back to the simulated visuals.
  const [camera, setCamera] = useState<CameraStatus | null>(null)
  const [frameTick, setFrameTick] = useState(0)
  const [frameFailed, setFrameFailed] = useState(false)

  // Real ML state (laptop webcam + Ultralytics YOLO). None of this is required
  // for the screen to render: if the worker is stopped, the ML extras are not
  // installed, or the camera is missing, the simulated visuals stay in place.
  const [vision, setVision] = useState<VisionStatus | null>(null)
  const [visionDetections, setVisionDetections] = useState<VisionDetections | null>(null)
  const [visionBusy, setVisionBusy] = useState(false)
  const [visionError, setVisionError] = useState('')
  const [visionFrameTick, setVisionFrameTick] = useState(0)
  const [visionFrameFailed, setVisionFrameFailed] = useState(false)
  const [eventStatus, setEventStatus] = useState<VisionEventStatus | null>(null)
  const [eventBusy, setEventBusy] = useState(false)
  const [eventResult, setEventResult] = useState<VisionEvent | null>(null)
  const [eventError, setEventError] = useState('')

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      const status = await fetchVisionStatus()

      if (cancelled) return

      if (status) {
        setVision(status)

        if (status.errors.length > 0) setVisionError(status.errors[0])
        else if (!status.ml_available) {
          setVisionError(
            'ML extras are not installed on the backend - install requirements-ml.txt to enable detection.',
          )
        } else setVisionError('')
      }
    }

    poll()
    const interval = setInterval(poll, 5000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  // Event analysis is separate from the real-time detector and never uploads every frame.
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      const result = await fetchVisionEvents()
      if (!cancelled && result) {
        setEventStatus(result)
        if (!eventResult && result.events?.length) setEventResult(result.events[0])
      }
    }
    poll()
    const interval = setInterval(poll, 5000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [eventResult])

  const handleAnalyzeScene = async () => {
    setEventBusy(true)
    setEventError('')
    try {
      const result = await analyzeVisionScene()
      if (result.status === 'ok') setEventResult(result)
      else setEventError(result.error || 'Scene analysis is not available.')
      const latest = await fetchVisionEvents()
      if (latest) setEventStatus(latest)
    } catch (error) {
      setEventError(error instanceof Error ? error.message : 'Scene analysis failed.')
    } finally {
      setEventBusy(false)
    }
  }

  // Poll detections only while the worker is running.
  useEffect(() => {
    if (!vision?.running) {
      setVisionDetections(null)
      return
    }

    let cancelled = false

    const poll = async () => {
      const result = await fetchVisionDetections()

      if (!cancelled && result) setVisionDetections(result)
    }

    poll()
    const interval = setInterval(poll, 600)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [vision?.running])

  // Refresh the annotated preview when the backend allows frame access.
  useEffect(() => {
    if (!vision?.running || !visionVideoAvailable() || visionFrameFailed) return

    const interval = setInterval(() => setVisionFrameTick(t => t + 1), 1500)

    return () => clearInterval(interval)
  }, [vision?.running, visionFrameFailed])

  // Retry a failed stream automatically. This matters when the UI first loaded
  // before the Vite proxy/backend token configuration was ready.
  useEffect(() => {
    if (!vision?.running || !visionVideoAvailable() || !visionFrameFailed) return

    const retry = setTimeout(() => setVisionFrameFailed(false), 3000)
    return () => clearTimeout(retry)
  }, [vision?.running, visionFrameFailed])

  const handleVisionToggle = async () => {
    setVisionBusy(true)
    setVisionError('')

    const result = vision?.running ? await stopVision() : await startVision()

    if (result === null) {
      setVisionError('The backend did not answer. Is the API running on the expected port?')
    } else if (result.error) {
      setVisionError(result.error)
    }

    // Reflect the change immediately instead of waiting for the next poll.
    setVision(await fetchVisionStatus())
    setVisionBusy(false)
  }

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      const status = await fetchCameraStatus()

      if (cancelled) return

      if (status) setCamera(status)
      if (status?.reachable) setFrameFailed(false)
    }

    poll()
    const interval = setInterval(poll, 5000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  // Refresh the still frame while the board is answering.
  useEffect(() => {
    if (!camera?.reachable || frameFailed) return

    const interval = setInterval(() => setFrameTick(t => t + 1), 1500)

    return () => clearInterval(interval)
  }, [camera?.reachable, frameFailed])

  const liveFrame = Boolean(camera?.reachable) && !frameFailed
  const hasFrame = Boolean(camera?.last_frame)

  // The laptop-webcam ML feed takes precedence while its worker is running;
  // otherwise the ESP32-CAM frame is used, and finally the simulated visuals.
  const mlLive = Boolean(vision?.running) && visionVideoAvailable() && !visionFrameFailed
  const activeFeed = mlLive ? 'ML' : liveFrame ? 'CAM' : 'SIM'

  const feedLabel = mlLive
    ? 'ML LIVE'
    : vision?.running
      ? 'DETECTING'
      : liveFrame
        ? 'LIVE FEED'
        : hasFrame
          ? 'RECONNECTING'
          : 'SIMULATED FEED'
  const feedColour = mlLive || vision?.running ? '#4ade80' : liveFrame ? '#4ade80' : hasFrame ? '#facc15' : '#64748b'

  // Real detections replace the placeholder objects whenever the model reports any.
  const realObjects = (visionDetections?.detections ?? [])
    .map(toOverlay)
    .filter((item): item is OverlayObject => item !== null)
  // Never show placeholder objects while the real ML worker is running.
  const overlayObjects: OverlayObject[] = vision?.running
    ? realObjects
    : detectedObjects.map(obj => ({ ...obj, key: obj.label, trackId: null }))
  const usingRealDetections = realObjects.length > 0

  const mlResolution = visionDetections?.frame?.width
    ? `${visionDetections.frame.width}×${visionDetections.frame.height}`
    : ''
  const resolution = mlResolution
    ? `${mlResolution} · YOLO`
    : camera?.last_frame?.resolution
      ? `${camera.last_frame.resolution}${camera.last_frame.stale ? ' · STALE' : ''}`
      : '1920×1080 · 30FPS'

  const fpsText = vision?.running ? `${(vision.fps ?? 0).toFixed(1)} FPS` : ''
  const latencyText = vision?.running ? `${(vision.inference_ms ?? 0).toFixed(0)} ms` : ''
  const modelName = vision?.model?.path?.split(/[\\/]/).pop() ?? ''
  const sourceLabel = vision?.running
    ? `WEBCAM · ${modelName || 'YOLO'}`
    : 'ESP32-CAM Neural Vision System'

  useEffect(() => {
    if (!scanning) return
    const interval = setInterval(() => {
      setScanY(prev => (prev >= 100 ? 0 : prev + 0.8))
    }, 20)
    return () => clearInterval(interval)
  }, [scanning])

  const handleCapture = async () => {
    setCaptureFlash(true)
    window.setTimeout(() => setCaptureFlash(false), 300)
    setPhotoBusy(true)
    setPhotoError('')
    try {
      const response = await fetch('/api/vision/photo', { method: 'POST', headers: VISION_TOKEN ? { Authorization: `Bearer ${VISION_TOKEN}` } : {} })
      const result = await response.json()
      if (!response.ok || result.status !== 'ok') throw new Error(result.error || 'Photo capture is unavailable.')
      setPhotoResult(result)
    } catch (error) {
      setPhotoError(error instanceof Error ? error.message : 'Photo capture failed.')
    } finally {
      setPhotoBusy(false)
    }
  }

  useEffect(() => {
    const receiveVisionCommand = (event: Event) => {
      const detail = (event as CustomEvent<{ action?: string }>).detail
      const action = String(detail?.action || '').toLowerCase()
      if (action === 'capture' || action === 'photo') void handleCapture()
      else if (action === 'analyze' || action === 'identify' || action === 'describe') void handleAnalyzeScene()
    }
    window.addEventListener('visionary:vision-command', receiveVisionCommand)
    return () => window.removeEventListener('visionary:vision-command', receiveVisionCommand)
  })

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-widest text-white">VISION MODE</h1>
          <div className="font-mono text-xs text-white/30 tracking-widest mt-0.5 uppercase">
            {sourceLabel}
          </div>
        </div>
        <div className="flex items-center gap-2 px-4 py-2 rounded-full glass">
          <div className="w-2 h-2 rounded-full animate-status-blink" style={{ backgroundColor: feedColour, color: feedColour }} />
          <span className="font-display text-[10px] tracking-widest" style={{ color: feedColour }}>
            {feedLabel}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Camera view */}
        <div className="lg:col-span-2">
          <div
            className="relative rounded-2xl overflow-hidden"
            style={{
              background: 'linear-gradient(135deg, #0a0f1e 0%, #0d1528 40%, #0a1020 70%, #050810 100%)',
              border: '1px solid rgba(0,229,255,0.2)',
              boxShadow: '0 0 40px rgba(0,229,255,0.1)',
              aspectRatio: '16/9',
            }}
          >
            {/* Capture flash */}
            {captureFlash && (
              <div className="absolute inset-0 bg-white/60 z-30 pointer-events-none transition-opacity" />
            )}

            {/* Live ESP32-CAM frame (backend camera service). Falls back to the
                simulated visuals below whenever the board is not answering. */}
            {liveFrame && !mlLive && (
              <img
                src={cameraSnapshotUrl(frameTick)}
                alt="ESP32-CAM live frame"
                className="absolute inset-0 w-full h-full object-cover"
                onError={() => setFrameFailed(true)}
              />
            )}

            {/* Annotated laptop-webcam frame from the ML worker. Boxes and
                labels are already drawn server-side, so the DOM overlay below
                is only needed when frame access is not enabled. */}
            {mlLive && (
              <img
                src={visionFrameUrl(visionFrameTick)}
                alt="Visionary Nexus live detection frame"
                className="absolute inset-0 w-full h-full object-cover"
                onError={() => setVisionFrameFailed(true)}
              />
            )}

            {/* Simulated camera noise/environment */}
            <div className="absolute inset-0 opacity-20"
              style={{
                backgroundImage: 'radial-gradient(ellipse at 30% 40%, rgba(0,229,255,0.15) 0%, transparent 50%), radial-gradient(ellipse at 70% 60%, rgba(168,85,247,0.1) 0%, transparent 50%)',
              }} />

            {/* Grid overlay */}
            <div className="absolute inset-0 opacity-10"
              style={{
                backgroundImage: 'linear-gradient(rgba(0,229,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(0,229,255,0.5) 1px, transparent 1px)',
                backgroundSize: '10% 10%',
              }} />

            {/* Object detection boxes. Real YOLO boxes when the worker is
                reporting them; hidden while the annotated frame already has
                them drawn server-side, so they are not shown twice. */}
            {showObjects && !mlLive && overlayObjects.map((obj) => (
              <div
                key={obj.key}
                className="absolute transition-all duration-500"
                style={{
                  left: `${obj.x}%`, top: `${obj.y}%`,
                  width: `${obj.w}%`, height: `${obj.h}%`,
                }}
              >
                {/* Box */}
                <div
                  className="absolute inset-0 rounded-sm"
                  style={{ border: `1px solid ${obj.color}`, boxShadow: `0 0 8px ${obj.color}40, inset 0 0 8px ${obj.color}10` }}
                />
                {/* Corner marks */}
                {[
                  { top: -1, left: -1, borderStyle: { borderTop: `2px solid ${obj.color}`, borderLeft: `2px solid ${obj.color}` } },
                  { top: -1, right: -1, borderStyle: { borderTop: `2px solid ${obj.color}`, borderRight: `2px solid ${obj.color}` } },
                  { bottom: -1, left: -1, borderStyle: { borderBottom: `2px solid ${obj.color}`, borderLeft: `2px solid ${obj.color}` } },
                  { bottom: -1, right: -1, borderStyle: { borderBottom: `2px solid ${obj.color}`, borderRight: `2px solid ${obj.color}` } },
                ].map((corner, i) => (
                  <div
                    key={i}
                    className="absolute w-3 h-3 animate-hud-corner"
                    style={{ ...corner.borderStyle, ...(corner as Record<string, unknown>) }}
                  />
                ))}
                {/* Label */}
                <div
                  className="absolute -top-6 left-0 px-2 py-0.5 rounded-sm font-mono text-[10px] whitespace-nowrap"
                  style={{ background: `${obj.color}20`, border: `1px solid ${obj.color}60`, color: obj.color }}
                >
                  {obj.label}{obj.trackId !== null ? ` #${obj.trackId}` : ''} {obj.confidence.toFixed(1)}%
                </div>
              </div>
            ))}

            {/* Scan line */}
            {scanning && (
              <div
                className="absolute left-0 right-0 pointer-events-none"
                style={{
                  top: `${scanY}%`,
                  height: 2,
                  background: 'linear-gradient(90deg, transparent, rgba(0,229,255,0.8) 20%, rgba(0,229,255,1) 50%, rgba(0,229,255,0.8) 80%, transparent)',
                  boxShadow: '0 0 12px rgba(0,229,255,0.6)',
                }}
              />
            )}

            {/* HUD corners */}
            <div className="absolute inset-4 pointer-events-none animate-hud-corner">
              {/* TL */}
              <div className="absolute top-0 left-0 w-8 h-8"
                style={{ borderTop: '2px solid rgba(0,229,255,0.6)', borderLeft: '2px solid rgba(0,229,255,0.6)' }} />
              {/* TR */}
              <div className="absolute top-0 right-0 w-8 h-8"
                style={{ borderTop: '2px solid rgba(0,229,255,0.6)', borderRight: '2px solid rgba(0,229,255,0.6)' }} />
              {/* BL */}
              <div className="absolute bottom-0 left-0 w-8 h-8"
                style={{ borderBottom: '2px solid rgba(0,229,255,0.6)', borderLeft: '2px solid rgba(0,229,255,0.6)' }} />
              {/* BR */}
              <div className="absolute bottom-0 right-0 w-8 h-8"
                style={{ borderBottom: '2px solid rgba(0,229,255,0.6)', borderRight: '2px solid rgba(0,229,255,0.6)' }} />
            </div>

            {/* Center crosshair */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-30">
              <div className="relative w-8 h-8">
                <div className="absolute inset-y-0 left-1/2 w-px bg-cyan-400" style={{ transform: 'translateX(-50%)' }} />
                <div className="absolute inset-x-0 top-1/2 h-px bg-cyan-400" style={{ transform: 'translateY(-50%)' }} />
              </div>
            </div>

            {/* Status overlays */}
            <div className="absolute bottom-3 left-3 flex items-center gap-3">
              <div className="font-mono text-[10px] text-white/40 bg-black/50 px-2 py-1 rounded">
                {resolution}
              </div>
              <div className="font-mono text-[10px] text-cyan-400 bg-black/50 px-2 py-1 rounded">
                {vision?.running && fpsText ? fpsText : 'FOV 120°'}
              </div>
              {vision?.running && latencyText && (
                <div className="font-mono text-[10px] text-purple-300 bg-black/50 px-2 py-1 rounded">
                  {latencyText} INFER
                </div>
              )}
              {vision?.running && vision.tracking && (
                <div className="font-mono text-[10px] text-emerald-300 bg-black/50 px-2 py-1 rounded">
                  TRACKING
                </div>
              )}
            </div>
            <div className="absolute top-3 right-3">
              <div className="flex items-center gap-1.5 font-mono text-[10px] bg-black/50 px-2 py-1 rounded">
                <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-status-blink" style={{ color: '#ef4444' }} />
                <span className="text-white/60">REC</span>
              </div>
            </div>
          </div>

          {/* Controls */}
          <div className="mt-4 flex items-center gap-3 flex-wrap">
            <button
              onClick={handleCapture}
              className="px-5 py-2.5 rounded-xl font-display text-[11px] tracking-widest transition-all duration-300 hover:scale-105 active:scale-95"
              style={{
                background: 'rgba(0,229,255,0.1)',
                border: '1px solid rgba(0,229,255,0.4)',
                color: '#00e5ff',
                boxShadow: '0 0 16px rgba(0,229,255,0.15)',
              }}
            >
              {photoBusy ? 'CAPTURING…' : 'CAPTURE PHOTO'}
            </button>
            <button
              onClick={handleVisionToggle}
              disabled={visionBusy}
              className="px-5 py-2.5 rounded-xl font-display text-[11px] tracking-widest transition-all duration-300 hover:scale-105 disabled:opacity-50 disabled:hover:scale-100"
              style={{
                background: vision?.running ? 'rgba(239,68,68,0.1)' : 'rgba(74,222,128,0.1)',
                border: `1px solid ${vision?.running ? 'rgba(239,68,68,0.4)' : 'rgba(74,222,128,0.4)'}`,
                color: vision?.running ? '#ef4444' : '#4ade80',
                boxShadow: `0 0 16px ${vision?.running ? 'rgba(239,68,68,0.15)' : 'rgba(74,222,128,0.15)'}`,
              }}
            >
              {visionBusy ? 'WAITING…' : vision?.running ? 'STOP DETECTION' : 'START DETECTION'}
            </button>
            <button
              onClick={handleAnalyzeScene}
              disabled={eventBusy || !vision?.running}
              className="px-5 py-2.5 rounded-xl font-display text-[11px] tracking-widest transition-all duration-300 hover:scale-105 disabled:opacity-50 disabled:hover:scale-100"
              style={{
                background: 'rgba(168,85,247,0.1)',
                border: '1px solid rgba(168,85,247,0.4)',
                color: '#a855f7',
                boxShadow: '0 0 16px rgba(168,85,247,0.15)',
              }}
            >
              {eventBusy ? 'QWEN3-VL ANALYZING…' : 'AI ANALYZE SCENE'}
            </button>
            <button
              onClick={() => setScanning(!scanning)}
              className="px-5 py-2.5 rounded-xl font-display text-[11px] tracking-widest transition-all duration-300 hover:scale-105"
              style={{
                background: scanning ? 'rgba(77,158,255,0.1)' : 'rgba(255,255,255,0.05)',
                border: `1px solid ${scanning ? 'rgba(77,158,255,0.4)' : 'rgba(255,255,255,0.1)'}`,
                color: scanning ? '#4d9eff' : '#ffffff40',
              }}
            >
              {scanning ? 'SCANNING ON' : 'SCANNING OFF'}
            </button>
            <button
              onClick={() => setShowObjects(!showObjects)}
              className="px-5 py-2.5 rounded-xl font-display text-[11px] tracking-widest transition-all duration-300 hover:scale-105"
              style={{
                background: showObjects ? 'rgba(74,222,128,0.08)' : 'rgba(255,255,255,0.05)',
                border: `1px solid ${showObjects ? 'rgba(74,222,128,0.3)' : 'rgba(255,255,255,0.1)'}`,
                color: showObjects ? '#4ade80' : '#ffffff40',
              }}
            >
              {showObjects ? 'DETECT ON' : 'DETECT OFF'}
            </button>
          </div>
        </div>

        {/* Right panel */}
        <div className="space-y-4">
          {/* Model / camera status. Real state from /api/vision/status. */}
          <div className="glass rounded-2xl p-5">
            <div className="font-display text-xs tracking-widest text-white/50 uppercase mb-3">
              Vision Pipeline
            </div>
            <div className="space-y-2">
              {[
                { label: 'Worker', value: vision?.running ? 'RUNNING' : 'STOPPED', ok: Boolean(vision?.running) },
                { label: 'Camera', value: vision?.camera_available ? 'OPEN' : 'UNAVAILABLE', ok: Boolean(vision?.camera_available) },
                { label: 'Model', value: vision?.model_loaded ? 'LOADED' : vision?.model_available ? 'READY' : 'MISSING', ok: Boolean(vision?.model_loaded) },
                { label: 'Tracking', value: vision?.tracking ? 'ON' : 'OFF', ok: Boolean(vision?.tracking) },
              ].map(({ label, value, ok }) => (
                <div key={label} className="flex items-center justify-between font-mono text-[11px]">
                  <span className="text-white/40 uppercase">{label}</span>
                  <span style={{ color: ok ? '#4ade80' : '#94a3b8' }}>{value}</span>
                </div>
              ))}
              {vision?.model?.ultralytics_version && (
                <div className="flex items-center justify-between font-mono text-[11px]">
                  <span className="text-white/40 uppercase">Engine</span>
                  <span className="text-white/60">YOLO v{vision.model.ultralytics_version}</span>
                </div>
              )}
              {vision?.running && (
                <>
                  <div className="flex items-center justify-between font-mono text-[11px]">
                    <span className="text-white/40 uppercase">Frames</span>
                    <span className="text-white/60">{vision.frames}</span>
                  </div>
                  <div className="flex items-center justify-between font-mono text-[11px]">
                    <span className="text-white/40 uppercase">Avg infer</span>
                    <span className="text-white/60">{(vision.model?.average_inference_ms ?? 0).toFixed(1)} ms</span>
                  </div>
                </>
              )}
            </div>

            {visionError && (
              <div
                className="mt-3 px-3 py-2 rounded-lg font-mono text-[10px] leading-relaxed"
                style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5' }}
              >
                {visionError}
              </div>
            )}
            {!visionError && vision?.running && !visionVideoAvailable() && (
              <div
                className="mt-3 px-3 py-2 rounded-lg font-mono text-[10px] leading-relaxed"
                style={{ background: 'rgba(250,204,21,0.06)', border: '1px solid rgba(250,204,21,0.25)', color: '#fde68a' }}
              >
                Video preview is off: set VISION_STREAM_TOKEN on the backend and
                VITE_VISION_TOKEN here to stream annotated frames. Detections below are real.
              </div>
            )}
          </div>

          {/* Detected objects */}
          <div className="glass rounded-2xl p-5">
            <div className="font-display text-xs tracking-widest text-white/50 uppercase mb-4">
              Detected Objects ({overlayObjects.length})
              <span className="ml-2 normal-case tracking-normal text-white/25">
                {vision?.running ? 'live' : 'preview'}
              </span>
            </div>
            {vision?.running && usingRealDetections === false && (
              <div className="font-mono text-[10px] text-white/30 mb-3">
                Nothing above {(vision.model?.confidence ?? 0.4).toFixed(2)} confidence yet.
              </div>
            )}
            <div className="space-y-3">
              {overlayObjects.map((obj) => (
                <div key={obj.key} className="flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: obj.color, boxShadow: `0 0 6px ${obj.color}` }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono text-xs text-white/80">{obj.label}</span>
                      <span className="font-mono text-[10px]" style={{ color: obj.color }}>{obj.confidence.toFixed(1)}%</span>
                    </div>
                    <div className="h-1 rounded-full bg-white/10 overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-700"
                        style={{ width: `${obj.confidence}%`, backgroundColor: obj.color, boxShadow: `0 0 6px ${obj.color}` }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* OpenAI event analysis. It is intentionally separate from local FPS/detections. */}
          <div className="glass rounded-2xl p-5">
            <div className="font-display text-xs tracking-widest text-white/50 uppercase mb-3">AI Event Analysis</div>
            <div className="font-mono text-[10px] text-white/40 mb-3">
              {eventStatus?.mode === 'local+ollama' ? `Local Qwen3-VL · ${eventStatus.model || 'vision model'} · on-demand image understanding` : 'Local vision analysis · starting'}
            </div>
            {eventResult?.status === 'ok' ? (
              <>
                <div className="font-mono text-xs text-white/80 leading-relaxed">{eventResult.summary}</div>
                {eventResult.observable_details?.length ? (
                  <ul className="mt-2 space-y-1 list-disc pl-4 font-mono text-[10px] text-white/50">
                    {eventResult.observable_details.map((detail, index) => <li key={`${index}-${detail}`}>{detail}</li>)}
                  </ul>
                ) : null}
                <div className="mt-3 font-mono text-[9px] text-white/30">
                  {eventResult.event_type?.replaceAll('_', ' ')} · {Math.round((eventResult.confidence ?? 0) * 100)}% model confidence
                </div>
              </>
            ) : (
              <p className="font-mono text-[10px] text-white/40 leading-relaxed">{eventError || eventStatus?.last_error || 'Start detection, then run AI Analyze Scene. Qwen3-VL checks the camera image and compares its interpretation with live YOLO detections. No cloud API key is required.'}</p>
            )}
            <p className="mt-3 font-mono text-[9px] text-white/25">Reports visible events only. It cannot determine identity or intent from appearance.</p>
          </div>

          {photoResult && (
            <div className="glass rounded-2xl p-5">
              <div className="font-display text-xs tracking-widest text-white/60 uppercase mb-3">Captured photo</div>
              {photoResult.photo_data_url && <img src={photoResult.photo_data_url} alt="Captured camera photo for AI inspection" className="w-full rounded-xl border border-white/10 mb-3" />}
              <p className="font-mono text-xs text-white/80 leading-relaxed">{photoResult.summary || 'Photo captured successfully.'}</p>
              {photoResult.observable_details?.length ? <ul className="mt-3 space-y-1 list-disc pl-4 font-mono text-[11px] text-white/60">{photoResult.observable_details.map((item: string, index: number) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : null}
              <div className="mt-2 font-mono text-[9px] text-white/30">{photoResult.model || 'Vision AI'} · high-detail image analysis</div>
            </div>
          )}
          {photoError && <div className="glass rounded-xl p-3 text-xs text-rose-300">{photoError}</div>}
          {/* Scene description */}
          <div className="glass rounded-2xl p-5">
            <div className="font-display text-xs tracking-widest text-white/50 uppercase mb-3">Scene Analysis</div>
            <p className="font-mono text-xs text-white/60 leading-relaxed">
              {vision?.running
                ? (usingRealDetections
                  ? 'YOLO found ' + overlayObjects.length + ' object(s) across ' + Object.keys(visionDetections?.labels ?? {}).length + ' class(es): ' + Object.entries(visionDetections?.labels ?? {}).map(([name, count]) => name + ' ?' + count).join(', ') + '.'
                  : 'No objects detected above ' + (vision?.model?.confidence ?? 0.4).toFixed(2) + ' confidence in the latest frame.')
                : sceneDescription}
            </p>
            {!vision?.running && (
              <div className="font-mono text-[9px] text-white/25 mt-2">
                placeholder text - start detection to replace it with real results
              </div>
            )}
            <div className="mt-4 pt-4 border-t border-white/5 grid grid-cols-2 gap-3">
              {[
                { label: 'Objects', value: String(overlayObjects.length), color: '#00e5ff' },
                { label: 'People', value: String(vision?.running ? (visionDetections?.labels?.person ?? 0) : 1), color: '#a855f7' },
                { label: 'Classes', value: String(vision?.running ? Object.keys(visionDetections?.labels ?? {}).length : 4), color: '#4d9eff' },
                { label: 'FPS', value: vision?.running ? (vision.fps ?? 0).toFixed(1) : '–', color: '#4ade80' },
              ].map(({ label, value, color }) => (
                <div key={label} className="text-center p-2 rounded-lg"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="font-mono text-[9px] text-white/30 uppercase">{label}</div>
                  <div className="font-mono text-sm font-bold mt-0.5" style={{ color }}>{value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
