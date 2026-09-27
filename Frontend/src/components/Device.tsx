import { useState, useEffect } from 'react'

interface LogEntry {
  time: string
  message: string
  type: 'info' | 'warn' | 'success' | 'error'
}

const initialLog: LogEntry[] = [
  { time: '14:23:41', message: 'SG-OS v2.4.1 boot complete', type: 'success' },
  { time: '14:23:43', message: 'ESP32-CAM initialized at 1920×1080', type: 'success' },
  { time: '14:23:44', message: 'INMP441 microphone ready, SNR 62dB', type: 'success' },
  { time: '14:23:45', message: 'Wi-Fi connected to SG-Network-5G', type: 'success' },
  { time: '14:23:46', message: 'IP assigned: 192.168.1.47', type: 'info' },
  { time: '14:23:47', message: 'Orion AI engine loaded (3.2B params)', type: 'success' },
  { time: '14:21:09', message: 'Voice command received, processing...', type: 'info' },
  { time: '14:18:55', message: 'Camera capture stored to flash', type: 'info' },
  { time: '14:15:33', message: 'Object recognition: 7 objects detected', type: 'info' },
  { time: '14:10:02', message: 'Wake word "Hey Orion" triggered', type: 'info' },
  { time: '14:08:17', message: 'Cloud sync: 14 events uploaded', type: 'success' },
  { time: '14:05:01', message: 'Battery temp: 38°C (normal)', type: 'info' },
]

const logColors = {
  info: '#4d9eff',
  warn: '#f59e0b',
  success: '#4ade80',
  error: '#ef4444',
}

function SignalBars({ strength }: { strength: number }) {
  return (
    <div className="flex items-end gap-0.5">
      {[1, 2, 3, 4, 5].map(i => (
        <div
          key={i}
          className="w-2 rounded-sm"
          style={{
            height: `${i * 4}px`,
            backgroundColor: i <= strength ? '#00e5ff' : 'rgba(255,255,255,0.15)',
            boxShadow: i <= strength ? '0 0 4px rgba(0,229,255,0.5)' : 'none',
          }}
        />
      ))}
    </div>
  )
}

function BatteryIcon({ level }: { level: number }) {
  const color = level > 50 ? '#4ade80' : level > 20 ? '#f59e0b' : '#ef4444'
  return (
    <div className="flex items-center gap-2">
      <div className="relative w-10 h-5 rounded-sm flex items-center px-1 gap-0.5"
        style={{ border: `1px solid ${color}60`, background: `${color}10` }}>
        <div className="h-3 rounded-sm transition-all duration-700"
          style={{ width: `${level * 0.3}px`, maxWidth: '28px', background: color, boxShadow: `0 0 6px ${color}` }} />
        <div className="absolute -right-1.5 top-1/2 w-1.5 h-2.5 rounded-r-sm -translate-y-1/2"
          style={{ background: `${color}60` }} />
      </div>
      <span className="font-mono text-sm font-bold" style={{ color }}>{level}%</span>
    </div>
  )
}

export default function Device() {
  const [log, setLog] = useState<LogEntry[]>(initialLog)
  const [battery] = useState(74)
  const [signalStrength] = useState(4)

  useEffect(() => {
    const interval = setInterval(() => {
      const messages = [
        { message: 'Sensor telemetry heartbeat OK', type: 'info' as const },
        { message: 'Memory usage: 312MB / 512MB', type: 'info' as const },
        { message: 'Background tasks: 4 active', type: 'info' as const },
        { message: 'CPU temp: 42°C', type: 'info' as const },
      ]
      const pick = messages[Math.floor(Math.random() * messages.length)]
      setLog(prev => [
        { time: new Date().toLocaleTimeString('en-US', { hour12: false }), ...pick },
        ...prev.slice(0, 19),
      ])
    }, 5000)
    return () => clearInterval(interval)
  }, [])

  const components = [
    {
      name: 'ESP32-CAM',
      model: 'AI-Thinker v2',
      status: 'ONLINE',
      statusColor: '#4ade80',
      details: [
        { label: 'Resolution', value: '1920×1080' },
        { label: 'FPS', value: '30' },
        { label: 'Flash', value: '4MB' },
        { label: 'PSRAM', value: '8MB' },
      ],
      borderColor: 'rgba(74,222,128,0.2)',
    },
    {
      name: 'INMP441',
      model: 'MEMs Microphone',
      status: 'READY',
      statusColor: '#a855f7',
      details: [
        { label: 'Sample Rate', value: '44.1kHz' },
        { label: 'Bit Depth', value: '24-bit' },
        { label: 'SNR', value: '62dB' },
        { label: 'Interface', value: 'I2S' },
      ],
      borderColor: 'rgba(168,85,247,0.2)',
    },
    {
      name: 'Speaker',
      model: 'MAX98357 Amp',
      status: 'IDLE',
      statusColor: '#4d9eff',
      details: [
        { label: 'Power', value: '3.2W' },
        { label: 'Freq', value: '20Hz–20kHz' },
        { label: 'THD', value: '<0.1%' },
        { label: 'Interface', value: 'I2S' },
      ],
      borderColor: 'rgba(77,158,255,0.2)',
    },
  ]

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-widest text-white">DEVICE STATUS</h1>
          <div className="font-mono text-xs text-white/30 tracking-widest mt-0.5 uppercase">
            Hardware Interface Layer
          </div>
        </div>
        <div className="flex items-center gap-4">
          <BatteryIcon level={battery} />
          <SignalBars strength={signalStrength} />
        </div>
      </div>

      {/* Connection info bar */}
      <div className="glass rounded-2xl p-4 grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Device ID', value: 'SG-2024-A7F3', color: '#00e5ff' },
          { label: 'IP Address', value: '192.168.1.47', color: '#4d9eff' },
          { label: 'Network', value: 'SG-Network-5G', color: '#a855f7' },
          { label: 'Uptime', value: '04:32:11', color: '#4ade80' },
        ].map(({ label, value, color }) => (
          <div key={label} className="flex flex-col gap-1">
            <span className="font-mono text-[9px] text-white/30 uppercase tracking-widest">{label}</span>
            <span className="font-mono text-xs font-medium" style={{ color }}>{value}</span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Hardware components */}
        <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-3 gap-4">
          {components.map((comp) => (
            <div
              key={comp.name}
              className="glass rounded-2xl p-5 hover:scale-[1.02] transition-transform duration-300"
              style={{ border: `1px solid ${comp.borderColor}` }}
            >
              {/* Status dot */}
              <div className="flex items-center justify-between mb-4">
                <div
                  className="w-2 h-2 rounded-full animate-status-blink"
                  style={{ backgroundColor: comp.statusColor, color: comp.statusColor, boxShadow: `0 0 6px ${comp.statusColor}` }}
                />
                <span className="font-mono text-[10px]" style={{ color: comp.statusColor }}>{comp.status}</span>
              </div>

              <div className="font-display text-sm font-bold text-white tracking-wider mb-0.5">{comp.name}</div>
              <div className="font-mono text-[10px] text-white/30 mb-4">{comp.model}</div>

              <div className="space-y-2">
                {comp.details.map(({ label, value }) => (
                  <div key={label} className="flex justify-between items-center">
                    <span className="font-mono text-[10px] text-white/30">{label}</span>
                    <span className="font-mono text-[10px] text-white/70">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* System metrics */}
          <div className="md:col-span-3 glass rounded-2xl p-5">
            <div className="font-display text-xs tracking-widest text-white/50 uppercase mb-4">System Resources</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: 'CPU', value: 34, color: '#00e5ff', unit: '%' },
                { label: 'Memory', value: 61, color: '#a855f7', unit: '%' },
                { label: 'Storage', value: 42, color: '#4d9eff', unit: '%' },
                { label: 'Temperature', value: 42, color: '#f59e0b', unit: '°C', max: 85 },
              ].map(({ label, value, color, unit, max = 100 }) => (
                <div key={label} className="flex flex-col gap-2">
                  <div className="flex justify-between items-center">
                    <span className="font-mono text-[10px] text-white/40 uppercase">{label}</span>
                    <span className="font-mono text-[10px]" style={{ color }}>{value}{unit}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${(value / max) * 100}%`,
                        backgroundColor: color,
                        boxShadow: `0 0 6px ${color}80`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* System log */}
        <div className="glass rounded-2xl p-5 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <span className="font-display text-xs tracking-widest text-white/50 uppercase">System Log</span>
            <div className="w-2 h-2 rounded-full bg-green-400 animate-status-blink" style={{ color: '#4ade80' }} />
          </div>
          <div className="flex-1 space-y-1.5 overflow-auto font-mono text-[10px]" style={{ maxHeight: 380 }}>
            {log.map((entry, i) => (
              <div key={i} className="flex gap-2 py-1 border-b border-white/5 last:border-0">
                <span className="text-white/20 flex-shrink-0">{entry.time}</span>
                <span style={{ color: logColors[entry.type] }}>{entry.message}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
