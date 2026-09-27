import { useState } from 'react'
import Dashboard from './components/Dashboard'
import AIAssistant from './components/AIAssistant'
import Vision from './components/Vision'
import AudioPanel from './components/AudioPanel'
import Device from './components/Device'
import Settings from './components/Settings'

export type Tab = 'dashboard' | 'ai' | 'vision' | 'audio' | 'device' | 'settings'

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
  { id: 'device' as Tab, label: 'Device', Icon: ChipIcon },
  { id: 'settings' as Tab, label: 'Settings', Icon: GearIcon },
]

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard')

  return (
    <div className="min-h-screen bg-[#030712] text-white flex flex-col md:flex-row relative overflow-hidden">
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

      {/* Desktop Sidebar */}
      <aside className="hidden md:flex flex-col w-64 min-h-screen relative z-10 flex-shrink-0"
        style={{
          background: 'rgba(3, 7, 18, 0.8)',
          backdropFilter: 'blur(24px)',
          borderRight: '1px solid rgba(0, 229, 255, 0.1)',
          boxShadow: '4px 0 40px rgba(0, 0, 0, 0.5)',
        }}>
        {/* Logo */}
        <div className="px-6 py-8 border-b border-white/5">
          <div className="flex items-center gap-3">
            <div className="relative w-10 h-10 flex-shrink-0">
              <div className="absolute inset-0 rounded-full border border-cyan-400/60" style={{ animation: 'ring-spin 8s linear infinite' }} />
              <div className="absolute inset-1 rounded-full border border-purple-500/40" style={{ animation: 'ring-spin-reverse 12s linear infinite' }} />
              <div className="absolute inset-2.5 rounded-full bg-cyan-400/20 border border-cyan-400/80"
                style={{ boxShadow: '0 0 12px rgba(0,229,255,0.6), inset 0 0 8px rgba(0,229,255,0.3)' }} />
            </div>
            <div>
              <div className="font-display text-xs font-bold tracking-[0.2em] text-white/90">SMART</div>
              <div className="font-display text-xs font-bold tracking-[0.2em] text-cyan-400" style={{ textShadow: '0 0 12px rgba(0,229,255,0.7)' }}>GLASSES</div>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-status-blink" style={{ color: '#4ade80' }} />
            <span className="font-mono text-[10px] text-white/40 tracking-widest uppercase">SG-OS v2.4.1</span>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {tabs.map(({ id, label, Icon }) => {
            const isActive = activeTab === id
            return (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-300 group ${
                  isActive ? 'nav-item-active' : 'hover:bg-white/5'
                }`}
              >
                <span className={`transition-colors duration-300 ${isActive ? 'text-cyan-400' : 'text-white/40 group-hover:text-white/70'}`}>
                  <Icon />
                </span>
                <span className={`font-display text-xs tracking-wider font-medium transition-colors duration-300 ${
                  isActive ? 'text-cyan-400' : 'text-white/50 group-hover:text-white/80'
                }`}>
                  {label.toUpperCase()}
                </span>
                {isActive && (
                  <div className="ml-auto w-1 h-1 rounded-full bg-cyan-400"
                    style={{ boxShadow: '0 0 6px rgba(0,229,255,0.8)' }} />
                )}
              </button>
            )
          })}
        </nav>

        {/* Sidebar bottom status */}
        <div className="px-4 py-4 border-t border-white/5 space-y-2">
          <div className="glass rounded-lg px-3 py-2 flex items-center justify-between">
            <span className="font-mono text-[10px] text-white/40 uppercase tracking-widest">Battery</span>
            <div className="flex items-center gap-2">
              <div className="w-16 h-1.5 rounded-full bg-white/10 overflow-hidden">
                <div className="h-full rounded-full bg-green-400 w-3/4"
                  style={{ boxShadow: '0 0 6px rgba(74,222,128,0.6)' }} />
              </div>
              <span className="font-mono text-[10px] text-green-400">74%</span>
            </div>
          </div>
          <div className="glass rounded-lg px-3 py-2 flex items-center justify-between">
            <span className="font-mono text-[10px] text-white/40 uppercase tracking-widest">Wi-Fi</span>
            <span className="font-mono text-[10px] text-cyan-400 text-glow-cyan">CONNECTED</span>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 relative z-10 overflow-auto pb-20 md:pb-0" style={{ minHeight: '100vh' }}>
        <div className="animate-slide-in" key={activeTab}>
          {activeTab === 'dashboard' && <Dashboard setActiveTab={setActiveTab} />}
          {activeTab === 'ai' && <AIAssistant />}
          {activeTab === 'vision' && <Vision />}
          {activeTab === 'audio' && <AudioPanel />}
          {activeTab === 'device' && <Device />}
          {activeTab === 'settings' && <Settings />}
        </div>
      </main>

      {/* Mobile Bottom Navigation */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 flex"
        style={{
          background: 'rgba(3, 7, 18, 0.95)',
          backdropFilter: 'blur(20px)',
          borderTop: '1px solid rgba(0, 229, 255, 0.12)',
        }}>
        {tabs.map(({ id, label, Icon }) => {
          const isActive = activeTab === id
          return (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className="flex-1 flex flex-col items-center gap-1 py-3 transition-all duration-200"
            >
              <span className={`transition-colors duration-200 ${isActive ? 'text-cyan-400' : 'text-white/30'}`}>
                <Icon />
              </span>
              <span className={`font-display text-[8px] tracking-wider transition-colors duration-200 ${
                isActive ? 'text-cyan-400' : 'text-white/30'
              }`}>
                {label.split(' ')[0].toUpperCase()}
              </span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}
