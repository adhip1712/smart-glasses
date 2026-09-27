import { useState, useEffect } from 'react'

const detectedObjects = [
  { label: 'Laptop', confidence: 96.2, x: 15, y: 20, w: 35, h: 25, color: '#00e5ff' },
  { label: 'Coffee Mug', confidence: 89.1, x: 60, y: 55, w: 12, h: 18, color: '#a855f7' },
  { label: 'Notebook', confidence: 91.8, x: 52, y: 20, w: 20, h: 30, color: '#4d9eff' },
  { label: 'Person', confidence: 98.4, x: 72, y: 10, w: 22, h: 60, color: '#4ade80' },
]

const sceneDescription = "Office workspace with 4 people detected. Overhead fluorescent lighting, daytime. Approximately 12m² visible area. No hazards detected. Wi-Fi networks visible: 3. Dominant colors: white, grey, blue."

export default function Vision() {
  const [scanning, setScanning] = useState(true)
  const [scanY, setScanY] = useState(0)
  const [showObjects, setShowObjects] = useState(true)
  const [captureFlash, setCaptureFlash] = useState(false)

  useEffect(() => {
    if (!scanning) return
    const interval = setInterval(() => {
      setScanY(prev => (prev >= 100 ? 0 : prev + 0.8))
    }, 20)
    return () => clearInterval(interval)
  }, [scanning])

  const handleCapture = () => {
    setCaptureFlash(true)
    setTimeout(() => setCaptureFlash(false), 300)
  }

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-widest text-white">VISION MODE</h1>
          <div className="font-mono text-xs text-white/30 tracking-widest mt-0.5 uppercase">
            ESP32-CAM Neural Vision System
          </div>
        </div>
        <div className="flex items-center gap-2 px-4 py-2 rounded-full glass">
          <div className="w-2 h-2 rounded-full bg-green-400 animate-status-blink" style={{ color: '#4ade80' }} />
          <span className="font-display text-[10px] text-green-400 tracking-widest">LIVE FEED</span>
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

            {/* Object detection boxes */}
            {showObjects && detectedObjects.map((obj) => (
              <div
                key={obj.label}
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
                  {obj.label} {obj.confidence.toFixed(1)}%
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
                1920×1080 · 30FPS
              </div>
              <div className="font-mono text-[10px] text-cyan-400 bg-black/50 px-2 py-1 rounded">
                FOV 120°
              </div>
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
              CAPTURE
            </button>
            <button
              className="px-5 py-2.5 rounded-xl font-display text-[11px] tracking-widest transition-all duration-300 hover:scale-105"
              style={{
                background: 'rgba(168,85,247,0.1)',
                border: '1px solid rgba(168,85,247,0.4)',
                color: '#a855f7',
                boxShadow: '0 0 16px rgba(168,85,247,0.15)',
              }}
            >
              ANALYZE SCENE
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
          {/* Detected objects */}
          <div className="glass rounded-2xl p-5">
            <div className="font-display text-xs tracking-widest text-white/50 uppercase mb-4">
              Detected Objects ({detectedObjects.length})
            </div>
            <div className="space-y-3">
              {detectedObjects.map((obj) => (
                <div key={obj.label} className="flex items-center gap-3">
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

          {/* Scene description */}
          <div className="glass rounded-2xl p-5">
            <div className="font-display text-xs tracking-widest text-white/50 uppercase mb-3">Scene Analysis</div>
            <p className="font-mono text-xs text-white/60 leading-relaxed">{sceneDescription}</p>
            <div className="mt-4 pt-4 border-t border-white/5 grid grid-cols-2 gap-3">
              {[
                { label: 'Objects', value: '4', color: '#00e5ff' },
                { label: 'People', value: '1', color: '#a855f7' },
                { label: 'Depth', value: '~3.4m', color: '#4d9eff' },
                { label: 'Light', value: 'Indoor', color: '#4ade80' },
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
