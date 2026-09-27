import { useState, useEffect } from 'react'
import type { Tab } from '../App'

const activities = [
  { time: '14:23:41', text: 'Scene analyzed — 7 objects detected', type: 'vision' },
  { time: '14:21:09', text: 'Voice command: "Take photo"', type: 'audio' },
  { time: '14:18:55', text: 'AI query: Navigation to Lab B-7', type: 'ai' },
  { time: '14:15:33', text: 'Object recognized: Circuit board (98.4%)', type: 'vision' },
  { time: '14:10:02', text: 'Wake word detected: "Hey Orion"', type: 'audio' },
  { time: '14:08:17', text: 'Device synced to SG-Cloud', type: 'device' },
]

const typeColors: Record<string, string> = {
  vision: '#00e5ff',
  audio: '#a855f7',
  ai: '#4d9eff',
  device: '#4ade80',
}

const quickActions = ['Analyze Scene', 'Start Recording', 'Send Location', 'Take Photo']

function AICore({ active }: { active: boolean }) {
  return (
    <div className="relative flex items-center justify-center" style={{ width: 280, height: 280 }}>
      {/* Outer expanding rings */}
      {active && (
        <>
          <div className="absolute rounded-full border border-cyan-400/20"
            style={{ width: 260, height: 260, animation: 'ring-expand 2.4s ease-out infinite' }} />
          <div className="absolute rounded-full border border-cyan-400/20"
            style={{ width: 260, height: 260, animation: 'ring-expand 2.4s ease-out infinite', animationDelay: '0.8s' }} />
          <div className="absolute rounded-full border border-cyan-400/20"
            style={{ width: 260, height: 260, animation: 'ring-expand 2.4s ease-out infinite', animationDelay: '1.6s' }} />
        </>
      )}

      {/* Rotating decorative ring — outermost */}
      <div className="absolute rounded-full"
        style={{
          width: 240, height: 240,
          border: '1px solid transparent',
          borderTop: '1px solid rgba(0,229,255,0.5)',
          borderRight: '1px solid rgba(168,85,247,0.3)',
          animation: 'ring-spin 10s linear infinite',
        }} />

      {/* Rotating decorative ring — middle */}
      <div className="absolute rounded-full"
        style={{
          width: 190, height: 190,
          border: '1px dashed rgba(0,229,255,0.2)',
          animation: 'ring-spin-reverse 14s linear infinite',
        }} />

      {/* Static ring */}
      <div className="absolute rounded-full"
        style={{
          width: 150, height: 150,
          border: '1px solid rgba(168,85,247,0.3)',
          boxShadow: '0 0 20px rgba(168,85,247,0.15)',
        }} />

      {/* Core glow */}
      <div className="absolute rounded-full"
        style={{
          width: 100, height: 100,
          background: 'radial-gradient(circle, rgba(0,229,255,0.15) 0%, rgba(168,85,247,0.1) 50%, transparent 70%)',
          animation: 'glow-pulse 2s ease-in-out infinite',
        }} />

      {/* Inner core */}
      <div className="relative z-10 rounded-full flex flex-col items-center justify-center"
        style={{
          width: 80, height: 80,
          background: 'radial-gradient(circle, rgba(0,229,255,0.3) 0%, rgba(0,229,255,0.05) 70%)',
          border: '1px solid rgba(0,229,255,0.6)',
          boxShadow: '0 0 30px rgba(0,229,255,0.4), inset 0 0 20px rgba(0,229,255,0.15)',
        }}>
        <svg viewBox="0 0 24 24" fill="none" className="w-8 h-8" stroke="rgba(0,229,255,0.9)" strokeWidth="1.2">
          <circle cx="12" cy="12" r="3" fill="rgba(0,229,255,0.3)" />
          <circle cx="12" cy="12" r="7" />
          <path d="M12 5V3M12 21v-2M5 12H3M21 12h-2M7.05 7.05L5.64 5.64M18.36 18.36l-1.41-1.41M7.05 16.95l-1.41 1.41M18.36 5.64l-1.41 1.41" strokeLinecap="round" />
        </svg>
      </div>

      {/* Orbital dots */}
      {[0, 60, 120, 180, 240, 300].map((deg) => (
        <div
          key={deg}
          className="absolute w-1.5 h-1.5 rounded-full bg-cyan-400"
          style={{
            transform: `rotate(${deg}deg) translateX(95px)`,
            boxShadow: '0 0 6px rgba(0,229,255,0.8)',
            opacity: 0.6,
          }}
        />
      ))}
    </div>
  )
}

export default function Dashboard({ setActiveTab }: { setActiveTab: (t: Tab) => void }) {
  const [aiActive, setAiActive] = useState(true)
  const [time, setTime] = useState(new Date())

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const statuses = [
    { label: 'AI Engine', value: 'ONLINE', color: '#00e5ff', active: true },
    { label: 'Camera', value: 'ACTIVE', color: '#00e5ff', active: true },
    { label: 'Microphone', value: 'READY', color: '#a855f7', active: true },
    { label: 'Speaker', value: 'IDLE', color: '#4d9eff', active: true },
    { label: 'Bluetooth', value: 'PAIRED', color: '#4ade80', active: true },
    { label: 'GPS', value: 'LOCKED', color: '#4ade80', active: true },
  ]

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <div className="font-display text-4xl md:text-6xl font-black tracking-widest shimmer-text">
            SMART GLASSES
          </div>
          <div className="font-mono text-xs text-white/30 tracking-[0.3em] mt-1 uppercase">
            Neural Interface OS — Orion Edition
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-2xl text-cyan-400 text-glow-cyan">
            {time.toLocaleTimeString('en-US', { hour12: false })}
          </div>
          <div className="font-mono text-xs text-white/30">
            {time.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
          </div>
        </div>
      </div>

      {/* Status row */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
        {statuses.map(({ label, value, color, active }) => (
          <div key={label} className="glass rounded-xl p-3 transition-all duration-300 hover:scale-105 animate-border-glow">
            <div className="font-mono text-[9px] text-white/30 uppercase tracking-widest mb-2">{label}</div>
            <div className="flex items-center gap-1.5">
              <div
                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                style={{
                  backgroundColor: active ? color : '#ffffff30',
                  boxShadow: active ? `0 0 6px ${color}` : 'none',
                  animation: active ? `status-blink 2s ease-in-out infinite` : 'none',
                }}
              />
              <span className="font-mono text-[10px] font-semibold" style={{ color }}>{value}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* AI Core visualizer */}
        <div className="lg:col-span-1 glass rounded-2xl p-6 flex flex-col items-center gap-4">
          <div className="flex items-center justify-between w-full">
            <span className="font-display text-xs tracking-widest text-white/50 uppercase">AI Core</span>
            <button
              onClick={() => setAiActive(!aiActive)}
              className="font-mono text-[10px] px-3 py-1 rounded-full transition-all duration-300"
              style={{
                border: `1px solid ${aiActive ? 'rgba(0,229,255,0.5)' : 'rgba(255,255,255,0.2)'}`,
                color: aiActive ? '#00e5ff' : '#ffffff60',
                boxShadow: aiActive ? '0 0 12px rgba(0,229,255,0.2)' : 'none',
              }}
            >
              {aiActive ? 'ACTIVE' : 'STANDBY'}
            </button>
          </div>

          <AICore active={aiActive} />

          <div className="text-center space-y-1">
            <div className="font-display text-sm font-bold text-cyan-400 text-glow-cyan tracking-widest">
              ORION AI
            </div>
            <div className="font-mono text-xs text-white/40">
              {aiActive ? 'Neural processing active' : 'Standby mode'}
            </div>
          </div>

          {/* AI metrics */}
          <div className="w-full grid grid-cols-3 gap-2">
            {[
              { label: 'CPU', value: '34%', color: '#00e5ff' },
              { label: 'MEM', value: '512MB', color: '#a855f7' },
              { label: 'TEMP', value: '42°C', color: '#4d9eff' },
            ].map(({ label, value, color }) => (
              <div key={label} className="text-center p-2 rounded-lg"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="font-mono text-[9px] text-white/30 uppercase">{label}</div>
                <div className="font-mono text-xs font-bold mt-0.5" style={{ color }}>{value}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Right column */}
        <div className="lg:col-span-2 space-y-4">
          {/* Quick actions */}
          <div className="glass rounded-2xl p-5">
            <div className="font-display text-xs tracking-widest text-white/50 uppercase mb-4">Quick Actions</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {quickActions.map((action) => (
                <button
                  key={action}
                  className="px-3 py-3 rounded-xl font-display text-[10px] tracking-wider transition-all duration-300 hover:scale-105 active:scale-95 group"
                  style={{
                    background: 'rgba(0,229,255,0.06)',
                    border: '1px solid rgba(0,229,255,0.2)',
                    color: '#00e5ff',
                  }}
                  onMouseEnter={e => {
                    const el = e.currentTarget
                    el.style.background = 'rgba(0,229,255,0.12)'
                    el.style.boxShadow = '0 0 20px rgba(0,229,255,0.2)'
                  }}
                  onMouseLeave={e => {
                    const el = e.currentTarget
                    el.style.background = 'rgba(0,229,255,0.06)'
                    el.style.boxShadow = 'none'
                  }}
                >
                  {action.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Recent activity */}
          <div className="glass rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <span className="font-display text-xs tracking-widest text-white/50 uppercase">Recent Activity</span>
              <span className="font-mono text-[10px] text-white/25 uppercase tracking-widest">Last 30 min</span>
            </div>
            <div className="space-y-2">
              {activities.map((a, i) => (
                <div
                  key={i}
                  className="flex items-start gap-3 p-3 rounded-xl transition-all duration-200 hover:bg-white/5 group"
                >
                  <div
                    className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0"
                    style={{ backgroundColor: typeColors[a.type], boxShadow: `0 0 6px ${typeColors[a.type]}` }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs text-white/80 truncate">{a.text}</div>
                  </div>
                  <div className="font-mono text-[10px] text-white/25 flex-shrink-0">{a.time}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Nav shortcuts */}
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setActiveTab('ai')}
              className="glass-cyan rounded-2xl p-4 text-left transition-all duration-300 hover:scale-[1.02] group"
            >
              <div className="font-display text-xs tracking-widest text-cyan-400/70 uppercase mb-2">AI Assistant</div>
              <div className="font-mono text-xs text-white/50">7 conversations today</div>
              <div className="mt-3 h-0.5 w-8 rounded-full bg-cyan-400/40 group-hover:w-full transition-all duration-500" />
            </button>
            <button
              onClick={() => setActiveTab('vision')}
              className="glass-purple rounded-2xl p-4 text-left transition-all duration-300 hover:scale-[1.02] group"
            >
              <div className="font-display text-xs tracking-widest text-purple-400/70 uppercase mb-2">Vision Mode</div>
              <div className="font-mono text-xs text-white/50">243 objects logged</div>
              <div className="mt-3 h-0.5 w-8 rounded-full bg-purple-400/40 group-hover:w-full transition-all duration-500" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
