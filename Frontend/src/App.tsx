import { useCallback, useEffect, useState } from 'react'
import SpatialDashboard from './components/SpatialDashboard'
import AIAssistant from './components/AIAssistant'
import Vision from './components/Vision'
import Music from './components/Music'
import Weather from './components/Weather'
import Notifications from './components/Notifications'
import Device from './components/Device'
import Settings from './components/Settings'
import WhatsApp from './components/WhatsApp'
import Calling from './components/Calling'
import { apiFetch, readJson } from './services/api'
import VoiceControl from './components/VoiceControl'
import { speakText } from './services/speech'
import { parseMusicCommand, publishMusicCommand, type MusicCommandAction } from './services/voiceMusic'
import { parseCallIntent } from './services/callIntent'
import IntroSplash from './components/IntroSplash'
import AuthScreen from './components/AuthScreen'
import { getToken, getStoredUser, setSession } from './services/api'
import { executeAppAction } from './services/universalApps'

// Share the one-time ticket exchange across React StrictMode effect replays.
let oauthExchangeTicket: string | null = null
let oauthExchangePromise: Promise<{ ok: boolean; data: { access_token?: string; user?: { id:number; email:string; display_name:string|null } } | null }> | null = null

// Never leave the UI on an empty loading screen if the API is slow or unreachable.
function withTimeout<T>(promise: Promise<T>, timeoutMs = 10000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Session check timed out')), timeoutMs)
    promise.then(
      value => { window.clearTimeout(timeout); resolve(value) },
      error => { window.clearTimeout(timeout); reject(error) },
    )
  })
}

export type Tab = 'dashboard' | 'ai' | 'vision' | 'music' | 'weather' | 'notifications' | 'whatsapp' | 'calling' | 'device' | 'settings'

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
const BellIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
    <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </svg>
)
const WhatsAppIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
    <path d="M20.5 11.5a8.5 8.5 0 0 1-12.6 7.4L3 20l1.2-4.7A8.5 8.5 0 1 1 20.5 11.5Z" />
    <path d="M8.5 8.5c.5 2.8 2.2 4.5 5 5l1.2-1.2 2 1c-.2 1.3-1.1 2-2.4 2-3.8-.5-6.6-3.3-7.1-7.1 0-1.3.7-2.2 2-2.4l1 2-1.7 1.7Z" />
  </svg>
)
const PhoneIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
    <path d="M5 3h4l2 5-3 2a15 15 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2C10 21 3 14 3 5a2 2 0 0 1 2-2Z" strokeLinecap="round" strokeLinejoin="round" />
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
  { id: 'music' as Tab, label: 'Music', Icon: MusicIcon },
  { id: 'weather' as Tab, label: 'Weather', Icon: WeatherIcon },
  { id: 'notifications' as Tab, label: 'Notifications', Icon: BellIcon },
  { id: 'whatsapp' as Tab, label: 'WhatsApp', Icon: WhatsAppIcon },
  { id: 'calling' as Tab, label: 'Calling', Icon: PhoneIcon },
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
  const [pendingVoiceCommand, setPendingVoiceCommand] = useState('')
  const [pendingWhatsAppDraft, setPendingWhatsAppDraft] = useState<{ recipient: string; message: string } | null>(null)
  const consumeWhatsAppDraft = useCallback(() => setPendingWhatsAppDraft(null), [])
  const [pendingCallRequest, setPendingCallRequest] = useState<{ recipient: string; channel: 'phone' | 'whatsapp' } | null>(null)
  const consumeCallRequest = useCallback(() => setPendingCallRequest(null), [])
  const openMapForDestination = useCallback((destination: string, openedWindow?: Window | null) => {
    const place = destination.trim()
    if (!place) return
    const encoded = encodeURIComponent(place)
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    const url = isIOS
      ? 'https://maps.apple.com/?daddr=' + encoded + '&dirflg=d'
      : 'https://www.google.com/maps/dir/?api=1&destination=' + encoded + '&travelmode=driving&dir_action=navigate'
    if (openedWindow && !openedWindow.closed) openedWindow.location.href = url
    else window.open(url, '_blank', 'noopener,noreferrer')
  }, [])
  const [status, setStatus] = useState<SystemStatus>({ backend: false, aiProvider: '\\u2014', glassesOnline: 0, wifiLabel: 'UNKNOWN' })
  const [authReady, setAuthReady] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)
  const storedUser = getStoredUser()
  const displayName = storedUser?.display_name?.trim() || storedUser?.email?.split('@')[0] || 'My Workspace'
  const userInitialsText = displayName.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() || '').join('') || 'VN'
  const avatarUrl = (storedUser as (typeof storedUser & { avatar_url?: string | null }) | null)?.avatar_url || null

  useEffect(() => {
    document.title = authenticated && storedUser
      ? displayName + ' | VN-' + storedUser.id
      : 'Visionary Nexus'
  }, [authenticated, displayName, storedUser?.id])

  // Play the intro once when a browser tab session starts. Ordinary refreshes
  // keep the session marker; a hard-refresh shortcut clears it before reload.
  const [showIntro, setShowIntro] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    const isOAuthReturn = params.has('oauth_ticket') || params.has('oauth_error')
    try {
      if (sessionStorage.getItem('vn_intro_seen_v2') === '1') return false
      sessionStorage.setItem('vn_intro_seen_v2', '1')
    } catch {
      // If session storage is unavailable, keep the intro for this page load.
    }
    return !isOAuthReturn
  })

  useEffect(() => {
    const allowIntroOnReload = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      const hardRefresh = (event.ctrlKey && event.shiftKey && key === 'r') ||
        (event.ctrlKey && key === 'f5')
      if (hardRefresh) {
        try { sessionStorage.removeItem('vn_intro_seen_v2') } catch { /* storage unavailable */ }
      }
    }
    window.addEventListener('keydown', allowIntroOnReload)
    return () => window.removeEventListener('keydown', allowIntroOnReload)
  }, [])

  useEffect(() => {
    let mounted = true
    const restoreSession = async () => {
      const oauthTicket = new URLSearchParams(window.location.search).get('oauth_ticket')
      if (oauthTicket) {
        try {
          if (oauthExchangeTicket !== oauthTicket || !oauthExchangePromise) {
            oauthExchangeTicket = oauthTicket
            oauthExchangePromise = (async () => {
              const response = await apiFetch('/api/auth/oauth/exchange', { method: 'POST', body: JSON.stringify({ ticket: oauthTicket }) })
              const payload = await readJson<{ access_token?: string; user?: { id:number; email:string; display_name:string|null } }>(response)
              return { ok: response.ok, data: payload }
            })()
          }
          const { ok, data } = await withTimeout(oauthExchangePromise)
          if (!ok || !data?.access_token || !data.user) throw new Error('Social sign-in could not be completed.')
          setSession(data.access_token, data.user)
          window.history.replaceState({}, document.title, '/')
          if (mounted) { setAuthenticated(true); setShowIntro(false) }
        } catch {
          setSession(null, null)
          window.history.replaceState({}, document.title, '/?oauth_error=failed')
          if (mounted) setAuthenticated(false)
        } finally {
          if (mounted) setAuthReady(true)
        }
        return
      }
      const token = getToken()
      if (!token) {
        if (mounted) setAuthReady(true)
        return
      }
      try {
        const response = await withTimeout(apiFetch('/api/auth/session'))
        if (!response.ok) throw new Error('Session expired')
        if (mounted) setAuthenticated(true)
      } catch {
        setSession(null, null)
        if (mounted) setAuthenticated(false)
      } finally {
        if (mounted) setAuthReady(true)
      }
    }
    void restoreSession()
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    let mounted = true
    const load = async () => {
      const next: SystemStatus = { backend: false, aiProvider: '\\u2014', glassesOnline: 0, wifiLabel: 'UNKNOWN' }
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

  useEffect(() => {
    if (activeTab !== 'ai' || !pendingVoiceCommand) return
    window.dispatchEvent(new CustomEvent('visionary:voice-command', { detail: { text: pendingVoiceCommand, activeTab: 'ai' } }))
    setPendingVoiceCommand('')
  }, [activeTab, pendingVoiceCommand])

  // Spotify redirects back to this SPA route; mount the Music tab so
  // SpotifyMusic can validate the OAuth state and exchange the PKCE code.
  useEffect(() => {
    if (window.location.pathname === '/spotify/callback') setActiveTab('music')
  }, [])

  if (!authReady) {
    return <div className="min-h-screen bg-black text-white flex items-center justify-center" role="status" aria-label="Restoring session"><div className="text-center"><div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" /><p className="text-sm tracking-widest">RESTORING SESSION…</p></div></div>
  }

  if (showIntro) {
    return <IntroSplash onComplete={() => setShowIntro(false)} userName={authenticated ? displayName : undefined} userId={authenticated ? storedUser?.id : undefined} avatarUrl={authenticated ? avatarUrl : null} />
  }

  if (!authenticated) {
    return <AuthScreen onAuthenticated={() => {
      setAuthenticated(true)
      setShowIntro(false)
    }} />
  }

  return (
    <div className="app-shell">
      {/* Figma spatial navigation shell */}

      <aside className="sidebar">
        <button className="brand identity-brand" type="button" onClick={() => setActiveTab('settings')}>
          {avatarUrl ? <img className="avatar brand-avatar" src={avatarUrl} alt="" /> : <span className="avatar brand-avatar">{userInitialsText}</span>}
          <span>
            <b>{displayName.toUpperCase()}</b>
            <small>ID / VN-{storedUser?.id ?? 'GUEST'}</small>
          </span>
        </button>

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
                  isActive ? 'active' : ''
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

        <div className="sidebar-footer">
          <p><span className="sidebar-trust-mark">N</span> Your world. Only yours.</p>
          <button type="button" onClick={() => setActiveTab('settings')}>
            {avatarUrl ? <img className="avatar" src={avatarUrl} alt="" /> : <span className="avatar">{userInitialsText}</span>}
            <span>
              <b>{displayName}</b>
              <small>Personal workspace / VN-{storedUser?.id ?? 'GUEST'}</small>
            </span>
            <span className="profile-arrow">?</span>
          </button>
        </div>
      </aside>

      {/* Main content */}
      <section className="workspace">
        <header className="topbar drift-soft">
          <div>
            <p className="eyebrow">Your spatial workspace</p>
            <div className="page-title">
              <h1>{tabs.find(tab => tab.id === activeTab)?.label || 'Workspace'}</h1>
              <span>VN-{storedUser?.id ?? 'GUEST'}</span>
            </div>
            <p className="page-description">Personal intelligence - Smart glasses interface</p>
          </div>
          <div className="system-controls">
            <span className="online"><i />{status.backend ? 'System connected' : 'Backend unavailable'}</span>
            <span className="divider" />
            <span className="clock">{new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
            <button className="round-button" type="button" aria-label="Notifications" onClick={() => setActiveTab('notifications')}><BellIcon /></button>
          </div>
        </header>
        <VoiceControl onCommand={async (spoken) => {
          const callIntent = parseCallIntent(spoken)
          if (callIntent) {
            setPendingCallRequest(callIntent)
            setActiveTab('calling')
            speakText(`Opening the ${callIntent.channel === 'whatsapp' ? 'WhatsApp' : 'phone'} calling flow for ${callIntent.recipient}.`)
            return
          }
          const musicCommand = parseMusicCommand(spoken)
          if (musicCommand) {
            speakText(musicCommand.query ? 'Opening music for ' + musicCommand.query + '.' : 'Opening YouTube Music.')
            setActiveTab('music')
            publishMusicCommand({
              activeTab: 'music',
              provider: 'youtube',
              source: 'voice',
              intent: 'music',
              action: musicCommand.action,
              query: musicCommand.query,
              text: spoken,
            })
            return;
          }
          // Reserve a browser tab synchronously so a later AI-planned app
          // action can navigate it without popup blocking.
          const appActionWindow = /\b(?:send|message|email|mail|write|compose|schedule|create|find|search|open|launch|book|add)\b/i.test(spoken)
            ? window.open('about:blank', '_blank')
            : null
          // Keep Visionary Nexus focused; the external tab is navigated only after speech.
          if (appActionWindow) window.focus()
          try {
            const response = await apiFetch('/api/intent/classify', {
              method: 'POST',
              body: JSON.stringify({
                message: spoken,
                context: { active_tab: activeTab },
              }),
            })
            const intent = await readJson<{
              intent?: string
              action?: string
              destination?: string
              query?: string
              polished_text?: string
              recipient?: string
              message_text?: string
            }>(response)
            const routedIntent = (intent?.intent || 'general').toLowerCase()
            const polished = intent?.polished_text?.trim() || spoken
            if (routedIntent === 'music') {
              speakText(intent?.query ? 'Opening music for ' + intent.query + '.' : 'Opening YouTube Music.')
              setActiveTab('music')
              publishMusicCommand({
                activeTab: 'music', provider: 'youtube', source: 'voice', intent: 'music',
                action: (['play', 'search', 'open', 'pause', 'stop', 'resume', 'next', 'previous'].includes(String(intent?.action))
                  ? intent?.action as MusicCommandAction
                  : 'play'),
                query: intent?.query || '', text: polished,
              })
              return
            }
            if (routedIntent === 'app_action') {
              // Begin the spoken confirmation before the new app tab takes focus.
              const result = executeAppAction({
                destination: String(intent?.destination || ''),
                action: String(intent?.action || 'open'),
                recipient: String(intent?.recipient || ''),
                message_text: String(intent?.message_text || ''),
                query: String(intent?.query || ''),
              }, null, true)
              const spoken = speakText(result.message.replace(/\*\*/g, '').replace(/\*/g, ''), {
                onEnd: () => { if (result.url && appActionWindow && !appActionWindow.closed) appActionWindow.location.href = result.url },
                onError: () => { if (result.url && appActionWindow && !appActionWindow.closed) appActionWindow.location.href = result.url },
              })
              if (!spoken && result.url && appActionWindow && !appActionWindow.closed) appActionWindow.location.href = result.url
              return
            }
            if (appActionWindow && !appActionWindow.closed) appActionWindow.close()
            if (routedIntent === 'whatsapp') {
              setPendingWhatsAppDraft({ recipient: intent?.recipient || '', message: intent?.message_text || '' })
              setActiveTab('whatsapp')
              speakText(intent?.recipient && intent?.message_text
                ? `Preparing a WhatsApp message to ${intent.recipient}. Review it and open WhatsApp to send.`
                : 'Open WhatsApp to choose the recipient and complete the message.')
              return
            }
            if (routedIntent === 'navigation' && intent?.destination) {
              const destination = String(intent.destination)
              const openDirections = () => openMapForDestination(destination)
              const spoken = speakText(`Opening Google Maps directions to ${destination}.`, { onEnd: openDirections, onError: openDirections })
              if (!spoken) openDirections()
              return
            }
            const intentTabs: Partial<Record<string, Tab>> = {
              weather: 'weather',
              vision: 'vision',
              audio: 'ai',
              dashboard: 'dashboard',
              ai: 'ai',
              notifications: 'notifications',
              device: 'device',
              settings: 'settings',
            }
            const destinationTab = intentTabs[routedIntent]
            if (destinationTab && routedIntent !== 'general') {
              speakText(`Opening ${routedIntent}.`)
              setActiveTab(destinationTab)
              if (routedIntent === 'vision') {
                window.dispatchEvent(new CustomEvent('visionary:vision-command', { detail: { text: polished, action: intent?.action || 'analyze' } }))
              }
              return
            }
            setPendingVoiceCommand(polished)
            setActiveTab('ai')
          } catch (error) {
            console.warn('AI voice understanding unavailable; forwarding speech to the AI Assistant.', error)
            speakText('I could not classify that request yet. Opening the AI Assistant.')
            setPendingVoiceCommand(spoken)
            setActiveTab('ai')
          }
        }} />
        <div className="page-content animate-slide-in vn-content">
          {activeTab === 'dashboard' && <SpatialDashboard setActiveTab={setActiveTab} displayName={displayName} backendOnline={status.backend} glassesOnline={status.glassesOnline} />}
          {activeTab === 'ai' && <AIAssistant
            onNavigate={(destination, openedWindow) => { openMapForDestination(destination, openedWindow) }}
            onMusic={() => setActiveTab('music')}
            onWhatsAppDraft={(draft) => { setPendingWhatsAppDraft(draft); setActiveTab('whatsapp') }}
            onCallRequest={(request) => { setPendingCallRequest(request); setActiveTab('calling') }}
          />}
          {activeTab === 'vision' && <Vision />}
          {/* Keep Music mounted while other tabs are open so playback and playlist editing continue. */}
          <div style={{ display: activeTab === 'music' ? 'block' : 'none' }} aria-hidden={activeTab !== 'music'}>
            <Music />
          </div>
          {activeTab === 'weather' && <Weather />}
          {activeTab === 'notifications' && <Notifications />}
          {activeTab === 'whatsapp' && <WhatsApp initialDraft={pendingWhatsAppDraft} onDraftConsumed={consumeWhatsAppDraft} />}
          {activeTab === 'calling' && <Calling initialRequest={pendingCallRequest} onRequestConsumed={consumeCallRequest} />}
          {activeTab === 'device' && <Device />}
          {activeTab === 'settings' && <Settings onSignOut={() => {
            setSession(null, null)
            setAuthenticated(false)
            setShowIntro(false)
            setActiveTab('dashboard')
          }} />}
        </div>
      </section>

    </div>
  )
}
