import { useEffect, useState } from 'react'
import Dashboard from './components/Dashboard'
import AIAssistant from './components/AIAssistant'
import Vision from './components/Vision'
import AudioPanel from './components/AudioPanel'
import Music from './components/Music'
import Weather from './components/Weather'
import Navigation from './components/Navigation'
import Notifications from './components/Notifications'
import Device from './components/Device'
import Settings from './components/Settings'
import { apiFetch, readJson } from './services/api'

export type Tab = 'dashboard' | 'ai' | 'vision' | 'audio' | 'music' | 'weather' | 'nav' | 'notifications' | 'device' | 'settings'

const DashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
    <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
  </svg>
)
const AIIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
    <circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="8" opacity="0.4" />
    <line x1="12" y1="2" x2="12" y2="4" /><line x1="12" y1="20" x2="12" y2="22" />
    <line x1="2" y1="12" x2="4" y2="12" /><line x1="20" y1="12" x2="22" y2="12" />
  </svg>
)
const EyeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)
const WaveIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
    <path d="M2 12h2M20 12h2M6 8v8M10 5v14M14 7v10M18 9v6" strokeLinecap="round" />
  </svg>
)
const ChipIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
    <rect x="7" y="7" width="10" height="10" rx="1" />
    <path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" strokeLinecap="round" />
  </svg>
)
const MusicIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
    <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
  </svg>
)
const WeatherIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
    <path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.6A4 4 0 0 0 7 19h10.5z" />
  </svg>
)
const NavIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
    <polygon points="3 11 22 2 13 21 11 13 3 11" />
  </svg>
)
const BellIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
    <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </svg>
)
const GearIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
    <circle cx="12" cy="12" r="3" />
    <path d="M12 1v3M12 20v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M1 12h3M20 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12" strokeLinecap="round" />
  </svg>
)

const tabs = [
  { id: 'dashboard' as Tab, label: 'Dashboard', Icon: DashIcon },
  { id: 'ai' as Tab, label: 'AI Assistant', Icon: AIIcon },
  { id: 'vision' as Tab, label: 'Vision', Icon: EyeIcon },
  { id: 'audio' as Tab, label: 'Audio', Icon: WaveIcon },
  { id: 'music' as Tab, label: 'Music', Icon: MusicIcon },
  { id: 'weather' as Tab, label: 'Weather', Icon: WeatherIcon },
  { id: 'nav' as Tab, label: 'Navigation', Icon: NavIcon },
  { id: 'notifications' as Tab, label: 'Notifications', Icon: BellIcon },
  { id: 'device' as Tab, label: 'Device', Icon: ChipIcon },
  { id: 'settings' as Tab, label: 'Settings', Icon: GearIcon },
]

interface SystemStatus {
  backend: boolean
  aiProvider: string
  glassesOnline: number
  wifiLabel: string
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard')
  const [status, setStatus] = useState<SystemStatus>({ backend: false, aiProvider: '—', glassesOnline: 0, wifiLabel: 'UNKNOWN' })

  useEffect(() => {
    let mounted = true
    const load = async () => {
      const next: SystemStatus = { backend: false, aiProvider: '—', glassesOnline: 0, wifiLabel: 'UNKNOWN' }
      try {
        const response = await apiFetch('/api/health')
        const data = await readJson<{ ai?: { provider: string | null; configured: boolean } }>(response)
        next.backend = response.ok
        next.aiProvider = data?.ai?.configured ? data.ai.provider || 'READY' : 'NOT CONFIGURED'
      } catch {
        next.backend = false
      }
      try {
        const response = await apiFetch('/api/device/provision/status')
        const data = await readJson<{ devices?: { connection_status: string }[] }>(response)
        const online = (data?.devices || []).filter(
          device => device.connection_status === 'online' || device.connection_status === 'connected',
        ).length
        next.glassesOnline = online
        next.wifiLabel = online > 0 ? 'GLASSES LINKED' : 'NO GLASSES'
      } catch {
        next.wifiLabel = 'UNKNOWN'
      }
      if (mounted) setStatus(next)
    }
    void load()
    const interval = window.setInterval(() => void load(), 15000)
    return () => {
      mounted = false
      window.clearInterval(interval)
    }
  }, [])

  return (
    <div className="min-h-screen bg-[#030712] text-white flex flex-row relative overflow-hidden">
      {/* Background grid */}
      <div className="fixed inset-0 bg-grid-pattern pointer-events-none z-0" />

      {/* Background ambient orbs */}
      <div
        className="fixed w-[600px] h-[600px] rounded-full pointer-events-none z-0 animate-orb"
        style={{
          top: '-10%', left: '-10%',
          background: 'radial-gradient(circle, rgba(0,229,255,0.06) 0%, transparent 70%)',
        }}
      />
      <div
        className="fixed w-[500px] h-[500px] rounded-full pointer-events-none z-0"
        style={{
          bottom: '-5%', right: '-5%',
          background: 'radial-gradient(circle, rgba(168,85,247,0.08) 0%, transparent 70%)',
          animation: 'orb-drift 16s ease-in-out infinite reverse',
        }}
      />
      <div
        className="fixed w-[400px] h-[400px] rounded-full pointer-events-none z-0"
        style={{
          top: '40%', left: '40%',
          background: 'radial-gradient(circle, rgba(77,158,255,0.04) 0%, transparent 70%)',
          animation: 'orb-drift 20s ease-in-out infinite',
        }}
      />

      {/* Vertical tab rail — always visible so the content keeps full width */}
      <aside className="flex flex-col w-[68px] md:w-64 min-h-screen relative z-10 flex-shrink-0"
        style={{
          background: 'rgba(3, 7, 18, 0.8)',
          backdropFilter: 'blur(24px)',
          borderRight: '1px solid rgba(0, 229, 255, 0.1)',
          boxShadow: '4px 0 40px rgba(0, 0, 0, 0.5)',
        }}>
        {/* Logo */}
        <div className="px-3 md:px-6 py-6 md:py-8 border-b border-white/5">
          <div className="flex items-center gap-3">
            <div className="relative w-10 h-10 flex-shrink-0">
              <div className="absolute inset-0 rounded-full border border-cyan-400/60" style={{ animation: 'ring-spin 8s linear infinite' }} />
              <div className="absolute inset-1 rounded-full border border-purple-500/40" style={{ animation: 'ring-spin-reverse 12s linear infinite' }} />
              <div className="absolute inset-2.5 rounded-full bg-cyan-400/20 border border-cyan-400/80"
                style={{ boxShadow: '0 0 12px rgba(0,229,255,0.6), inset 0 0 8px rgba(0,229,255,0.3)' }} />
            </div>
            <div className="hidden md:block">
              <div className="font-display text-xs font-bold tracking-[0.2em] text-white/90">VISIONARY</div>
              <div className="font-display text-xs font-bold tracking-[0.2em] text-cyan-400" style={{ textShadow: '0 0 12px rgba(0,229,255,0.7)' }}>NEXUS</div>
            </div>
            <div className="md:hidden font-display text-[10px] font-bold tracking-[0.15em] text-cyan-400" style={{ textShadow: '0 0 12px rgba(0,229,255,0.7)' }}>VN</div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <div
              className="w-1.5 h-1.5 rounded-full animate-status-blink"
              style={{ backgroundColor: status.backend ? '#4ade80' : '#ef4444', color: '#4ade80' }}
            />
            <span className="hidden md:inline font-mono text-[10px] text-white/40 tracking-widest uppercase">
              {status.backend ? 'BACKEND ONLINE' : 'BACKEND OFFLINE'}
            </span>
          </div>
        </div>

        {/* Navigation (vertical tabs) */}
        <nav className="flex-1 px-2 md:px-3 py-4 space-y-1 overflow-y-auto">
          {tabs.map(({ id, label, Icon }) => {
            const isActive = activeTab === id
            return (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                title={label}
                className={`w-full flex items-center justify-center md:justify-start gap-3 px-2 md:px-4 py-3 rounded-lg transition-all duration-300 group ${
                  isActive ? 'nav-item-active' : 'hover:bg-white/5'
                }`}
              >
                <span className={`transition-colors duration-300 ${isActive ? 'text-cyan-400' : 'text-white/40 group-hover:text-white/70'}`}>
                  <Icon />
                </span>
                <span className={`hidden md:inline font-display text-xs tracking-wider font-medium transition-colors duration-300 ${
                  isActive ? 'text-cyan-400' : 'text-white/50 group-hover:text-white/80'
                }`}>
                  {label.toUpperCase()}
                </span>
                {isActive && (
                  <div className="ml-auto hidden md:block w-1 h-1 rounded-full bg-cyan-400"
                    style={{ boxShadow: '0 0 6px rgba(0,229,255,0.8)' }} />
                )}
              </button>
            )
          })}
        </nav>

        {/* Sidebar bottom status (live from the backend) */}
        <div className="hidden md:block px-4 py-4 border-t border-white/5 space-y-2">
          <div className="glass rounded-lg px-3 py-2 flex items-center justify-between">
            <span className="font-mono text-[10px] text-white/40 uppercase tracking-widest">AI</span>
            <span
              className="font-mono text-[10px] text-glow-cyan"
              style={{ color: status.aiProvider === 'NOT CONFIGURED' ? '#f59e0b' : '#00e5ff' }}
            >
              {status.aiProvider.toUpperCase()}
            </span>
          </div>
          <div className="glass rounded-lg px-3 py-2 flex items-center justify-between">
            <span className="font-mono text-[10px] text-white/40 uppercase tracking-widest">Glasses</span>
            <span className="font-mono text-[10px] text-cyan-400 text-glow-cyan">
              {status.glassesOnline} ONLINE
            </span>
          </div>
          <div className="glass rounded-lg px-3 py-2 flex items-center justify-between">
            <span className="font-mono text-[10px] text-white/40 uppercase tracking-widest">Link</span>
            <span className="font-mono text-[10px] text-cyan-400 text-glow-cyan">{status.wifiLabel}</span>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 relative z-10 overflow-auto" style={{ minHeight: '100vh' }}>
        <div className="animate-slide-in" key={activeTab}>
          {activeTab === 'dashboard' && <Dashboard setActiveTab={setActiveTab} />}
          {activeTab === 'ai' && <AIAssistant />}
          {activeTab === 'vision' && <Vision />}
          {activeTab === 'audio' && <AudioPanel />}
          {activeTab === 'music' && <Music />}
          {activeTab === 'weather' && <Weather />}
          {activeTab === 'nav' && <Navigation />}
          {activeTab === 'notifications' && <Notifications />}
          {activeTab === 'device' && <Device />}
          {activeTab === 'settings' && <Settings />}
        </div>
      </main>

    </div>
  )
}
