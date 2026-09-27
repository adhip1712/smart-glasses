import { useState, useEffect, useRef } from 'react'

const barCount = 48

function useWaveform(active: boolean) {
  const [heights, setHeights] = useState(() => Array.from({ length: barCount }, (_, i) => 10 + Math.sin(i * 0.5) * 8))

  useEffect(() => {
    if (!active) {
      setHeights(Array.from({ length: barCount }, () => 4))
      return
    }
    const interval = setInterval(() => {
      setHeights(prev => prev.map((_, i) => {
        const noise = Math.random() * 40 + 5
        const wave = Math.sin(Date.now() / 400 + i * 0.4) * 12
        return Math.max(4, Math.min(48, noise + wave))
      }))
    }, 80)
    return () => clearInterval(interval)
  }, [active])

  return heights
}

export default function AudioPanel() {
  const [micActive, setMicActive] = useState(true)
  const [volume, setVolume] = useState(72)
  const [speakerOn, setSpeakerOn] = useState(true)
  const [wakeWordActive, setWakeWordActive] = useState(true)
  const waveHeights = useWaveform(micActive)
  const [voiceLevel, setVoiceLevel] = useState(0)

  useEffect(() => {
    if (!micActive) { setVoiceLevel(0); return }
    const interval = setInterval(() => {
      setVoiceLevel(Math.random() * 80 + 10)
    }, 100)
    return () => clearInterval(interval)
  }, [micActive])

  const bands = [
    { label: '125Hz', value: 65 },
    { label: '250Hz', value: 78 },
    { label: '500Hz', value: 82 },
    { label: '1kHz', value: 91 },
    { label: '2kHz', value: 86 },
    { label: '4kHz', value: 74 },
    { label: '8kHz', value: 58 },
    { label: '16kHz', value: 42 },
  ]

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-widest text-white">AUDIO SYSTEM</h1>
          <div className="font-mono text-xs text-white/30 tracking-widest mt-0.5 uppercase">
            INMP441 MEMs Microphone · 44.1kHz
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-purple-500" style={{ animation: micActive ? 'status-blink 1.2s ease-in-out infinite' : 'none', boxShadow: micActive ? '0 0 8px #a855f7' : 'none' }} />
          <span className="font-display text-[10px] tracking-widest text-purple-400">
            {micActive ? 'RECORDING' : 'MUTED'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Waveform */}
        <div className="lg:col-span-2 space-y-4">
          {/* Main waveform card */}
          <div className="glass rounded-2xl p-6"
            style={{ border: micActive ? '1px solid rgba(168,85,247,0.2)' : '1px solid rgba(255,255,255,0.06)' }}>
            <div className="flex items-center justify-between mb-6">
              <span className="font-display text-xs tracking-widest text-white/50 uppercase">Live Waveform</span>
              <div className="flex items-center gap-3">
                <div className="font-mono text-xs" style={{ color: micActive ? '#a855f7' : '#ffffff30' }}>
                  {micActive ? `${voiceLevel.toFixed(0)} dB` : '— dB'}
                </div>
                <button
                  onClick={() => setMicActive(!micActive)}
                  className="px-3 py-1 rounded-full font-display text-[10px] tracking-wider transition-all duration-300"
                  style={{
                    background: micActive ? 'rgba(168,85,247,0.15)' : 'rgba(255,255,255,0.05)',
                    border: `1px solid ${micActive ? 'rgba(168,85,247,0.4)' : 'rgba(255,255,255,0.1)'}`,
                    color: micActive ? '#a855f7' : '#ffffff40',
                  }}
                >
                  {micActive ? 'MUTE' : 'UNMUTE'}
                </button>
              </div>
            </div>

            {/* Waveform bars */}
            <div className="flex items-end justify-between gap-0.5" style={{ height: 80 }}>
              {waveHeights.map((h, i) => {
                const isCenter = Math.abs(i - barCount / 2) < barCount / 4
                const color = micActive
                  ? (isCenter ? '#a855f7' : i < barCount / 2 ? '#7c3aed' : '#c084fc')
                  : '#ffffff15'
                return (
                  <div
                    key={i}
                    className="rounded-full flex-1 transition-all"
                    style={{
                      height: `${h}px`,
                      backgroundColor: color,
                      boxShadow: micActive ? `0 0 4px ${color}80` : 'none',
                      transitionDuration: '80ms',
                      minWidth: 2,
                    }}
                  />
                )
              })}
            </div>

            {/* Voice level meter */}
            <div className="mt-4 flex items-center gap-3">
              <span className="font-mono text-[10px] text-white/30 uppercase tracking-widest w-16 flex-shrink-0">Level</span>
              <div className="flex-1 h-2 rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${voiceLevel}%`,
                    background: 'linear-gradient(90deg, #7c3aed, #a855f7, #c084fc)',
                    boxShadow: '0 0 8px rgba(168,85,247,0.5)',
                    transitionDuration: '80ms',
                  }}
                />
              </div>
              <span className="font-mono text-[10px] text-purple-400 w-12 text-right flex-shrink-0">
                {voiceLevel.toFixed(0)}%
              </span>
            </div>
          </div>

          {/* EQ/Frequency bands */}
          <div className="glass rounded-2xl p-5">
            <div className="font-display text-xs tracking-widest text-white/50 uppercase mb-5">Frequency Response</div>
            <div className="flex items-end justify-between gap-2" style={{ height: 80 }}>
              {bands.map(({ label, value }) => (
                <div key={label} className="flex-1 flex flex-col items-center gap-1">
                  <div
                    className="w-full rounded-t-sm transition-all duration-300"
                    style={{
                      height: `${value * 0.7}px`,
                      background: `linear-gradient(180deg, rgba(0,229,255,0.8) 0%, rgba(77,158,255,0.6) 100%)`,
                      boxShadow: '0 0 6px rgba(0,229,255,0.3)',
                    }}
                  />
                  <span className="font-mono text-[8px] text-white/30 whitespace-nowrap">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right controls */}
        <div className="space-y-4">
          {/* Wake word */}
          <div className="glass rounded-2xl p-5"
            style={{ border: wakeWordActive ? '1px solid rgba(0,229,255,0.2)' : '1px solid rgba(255,255,255,0.06)' }}>
            <div className="flex items-center justify-between mb-3">
              <span className="font-display text-xs tracking-widest text-white/50 uppercase">Wake Word</span>
              <button
                onClick={() => setWakeWordActive(!wakeWordActive)}
                className="w-10 h-5 rounded-full relative transition-all duration-300 flex-shrink-0"
                style={{ background: wakeWordActive ? 'rgba(0,229,255,0.3)' : 'rgba(255,255,255,0.1)' }}
              >
                <div
                  className="absolute top-0.5 w-4 h-4 rounded-full transition-all duration-300"
                  style={{
                    left: wakeWordActive ? 'calc(100% - 18px)' : '2px',
                    background: wakeWordActive ? '#00e5ff' : '#ffffff40',
                    boxShadow: wakeWordActive ? '0 0 8px rgba(0,229,255,0.6)' : 'none',
                  }}
                />
              </button>
            </div>
            <div
              className="font-mono text-lg text-center py-3 rounded-xl"
              style={{
                color: wakeWordActive ? '#00e5ff' : '#ffffff30',
                textShadow: wakeWordActive ? '0 0 12px rgba(0,229,255,0.6)' : 'none',
                background: wakeWordActive ? 'rgba(0,229,255,0.05)' : 'rgba(255,255,255,0.02)',
                border: `1px solid ${wakeWordActive ? 'rgba(0,229,255,0.15)' : 'rgba(255,255,255,0.05)'}`,
              }}
            >
              "Hey Orion"
            </div>
            <div className="font-mono text-[10px] text-white/30 text-center mt-2">
              {wakeWordActive ? 'Actively listening for trigger' : 'Wake word detection disabled'}
            </div>
          </div>

          {/* Speaker control */}
          <div className="glass rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <span className="font-display text-xs tracking-widest text-white/50 uppercase">Speaker</span>
              <button
                onClick={() => setSpeakerOn(!speakerOn)}
                className="w-10 h-5 rounded-full relative transition-all duration-300"
                style={{ background: speakerOn ? 'rgba(77,158,255,0.3)' : 'rgba(255,255,255,0.1)' }}
              >
                <div
                  className="absolute top-0.5 w-4 h-4 rounded-full transition-all duration-300"
                  style={{
                    left: speakerOn ? 'calc(100% - 18px)' : '2px',
                    background: speakerOn ? '#4d9eff' : '#ffffff40',
                    boxShadow: speakerOn ? '0 0 8px rgba(77,158,255,0.6)' : 'none',
                  }}
                />
              </button>
            </div>

            <div className="flex items-center gap-3 mb-3">
              <svg viewBox="0 0 24 24" fill="none" stroke={speakerOn ? '#4d9eff' : '#ffffff30'} strokeWidth="1.5" className="w-4 h-4 flex-shrink-0">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                {speakerOn && <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14" strokeLinecap="round" />}
              </svg>
              <input
                type="range"
                min={0}
                max={100}
                value={speakerOn ? volume : 0}
                onChange={e => setVolume(Number(e.target.value))}
                disabled={!speakerOn}
                className="flex-1"
                style={{ opacity: speakerOn ? 1 : 0.3 }}
              />
              <span className="font-mono text-xs text-blue-400 w-8 text-right">{speakerOn ? volume : 0}%</span>
            </div>

            <div className="flex gap-2">
              {[25, 50, 75, 100].map(v => (
                <button
                  key={v}
                  onClick={() => { setSpeakerOn(true); setVolume(v) }}
                  className="flex-1 py-1.5 rounded-lg font-mono text-[10px] transition-all duration-200"
                  style={{
                    background: volume === v && speakerOn ? 'rgba(77,158,255,0.2)' : 'rgba(255,255,255,0.04)',
                    border: `1px solid ${volume === v && speakerOn ? 'rgba(77,158,255,0.4)' : 'rgba(255,255,255,0.07)'}`,
                    color: volume === v && speakerOn ? '#4d9eff' : '#ffffff40',
                  }}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>

          {/* Mic stats */}
          <div className="glass rounded-2xl p-5">
            <div className="font-display text-xs tracking-widest text-white/50 uppercase mb-4">Mic Stats</div>
            {[
              { label: 'Sample Rate', value: '44.1 kHz', color: '#00e5ff' },
              { label: 'Bit Depth', value: '24-bit', color: '#a855f7' },
              { label: 'Noise Floor', value: '-82 dBFS', color: '#4d9eff' },
              { label: 'SNR', value: '62 dB', color: '#4ade80' },
            ].map(({ label, value, color }) => (
              <div key={label} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                <span className="font-mono text-[11px] text-white/40">{label}</span>
                <span className="font-mono text-[11px] font-medium" style={{ color }}>{value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
