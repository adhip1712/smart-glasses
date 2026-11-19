import { useEffect, useState } from 'react'
import { apiFetch, readJson } from '../services/api'
import { normalizePreference } from '../services/preferences'

function Toggle({
  value,
  onChange,
  color = '#00e5ff',
}: {
  value: boolean
  onChange: (v: boolean) => void
  color?: string
}) {
  return (
    <button
      onClick={() => onChange(!value)}
      className="w-11 h-6 rounded-full relative transition-all duration-300 flex-shrink-0"
      style={{
        background: value ? `${color}40` : 'rgba(255,255,255,0.1)',
      }}
    >
      <div
        className="absolute top-0.5 w-5 h-5 rounded-full transition-all duration-300"
        style={{
          left: value ? 'calc(100% - 22px)' : '2px',
          background: value ? color : '#ffffff40',
          boxShadow: value ? `0 0 10px ${color}80` : 'none',
        }}
      />
    </button>
  )
}

function Select({
  options,
  value,
  onChange,
}: {
  options: string[]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="bg-transparent outline-none font-mono text-xs text-cyan-400 border-none"
      style={{ background: 'rgba(0,229,255,0.05)' }}
    >
      {options.map(o => (
        <option
          key={o}
          value={o}
          style={{ background: '#0d1528' }}
        >
          {o}
        </option>
      ))}
    </select>
  )
}

function Slider({
  value,
  onChange,
  min = 0,
  max = 100,
  color = '#00e5ff',
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  color?: string
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="flex-1"
        style={{ accentColor: color }}
      />

      <span
        className="font-mono text-xs w-8 text-right"
        style={{ color }}
      >
        {value}
      </span>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="glass rounded-2xl p-5">
      <div
        className="font-display text-xs tracking-widest text-white/50 uppercase mb-5"
        style={{
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          paddingBottom: '12px',
        }}
      >
        {title}
      </div>

      <div className="space-y-4">
        {children}
      </div>
    </div>
  )
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex-1 min-w-0">
        <div className="font-mono text-xs text-white/80">
          {label}
        </div>

        {description && (
          <div className="font-mono text-[10px] text-white/30 mt-0.5">
            {description}
          </div>
        )}
      </div>

      <div className="flex-shrink-0">
        {children}
      </div>
    </div>
  )
}

export default function Settings(_props: { onSignOut?: () => void }) {
  // =========================
  // AI
  // =========================

  const [aiProvider, setAiProvider] = useState('Groq')
  const [aiModel, setAiModel] = useState('Llama')
  const [aiTemp, setAiTemp] = useState(72)
  const [aiContext, setAiContext] = useState(4096)
  const [streamResponse, setStreamResponse] = useState(true)
  const [voiceResponse, setVoiceResponse] = useState(true)
  const [autoAnalyze, setAutoAnalyze] = useState(false)

  // =========================
  // CAMERA
  // =========================

  const [camResolution, setCamResolution] = useState('1920├ù1080')
  const [camFps, setCamFps] = useState('30fps')
  const [camHDR, setCamHDR] = useState(true)
  const [camNight, setCamNight] = useState(false)
  const [camBrightness, setCamBrightness] = useState(55)
  const [camContrast, setCamContrast] = useState(60)

  // =========================
  // MICROPHONE
  // =========================

  const [micGain, setMicGain] = useState(70)
  const [micNoise, setMicNoise] = useState(true)
  const [micEcho, setMicEcho] = useState(true)
  const [wakeWord, setWakeWord] = useState('Vision')
  const [wakeSensitivity, setWakeSensitivity] = useState('high')
  const [wakeSource, setWakeSource] = useState('auto')
  const [wakeSaved, setWakeSaved] = useState(false)
  const [wakeSaveError, setWakeSaveError] = useState('')

  // =========================
  // SPEAKER
  // =========================

  const [speakerVolume, setSpeakerVolume] = useState(72)
  const [tts, setTts] = useState('Neural-en-US')
  const [speakerEQ, setSpeakerEQ] = useState(false)

  // =========================
  // NETWORK
  // =========================

  const [wifiSSID] = useState('SG-Network-5G')
  const [autoConnect, setAutoConnect] = useState(true)
  const [cloudSync, setCloudSync] = useState(true)
  const [apiEndpoint, setApiEndpoint] = useState(
    'http://192.168.1.100:8000'
  )

  // =========================
  // APPEARANCE
  // =========================

  const [theme, setTheme] = useState('Orion Dark')
  const [accentColor, setAccentColor] = useState('Cyan')
  const [animations, setAnimations] = useState(true)
  const [hud, setHud] = useState(true)
  const [blur, setBlur] = useState(true)

  // User-defined function-to-app preferences are browser-persisted and do not alter API contracts.
  const [preferences, setPreferences] = useState<{ id: string; category: string; value: string }[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('visionary-preferences') || 'null')
      return Array.isArray(saved?.rows) && saved.rows.length
        ? saved.rows
        : [{ id: 'music-default', category: 'Music', value: 'YouTube' }]
    } catch {
      return [{ id: 'music-default', category: 'Music', value: 'YouTube' }]
    }
  })
  const [playerDestination, setPlayerDestination] = useState<'internal' | 'website'>(() => {
    try { return localStorage.getItem('visionary-player-destination') === 'website' ? 'website' : 'internal' }
    catch { return 'internal' }
  })

  useEffect(() => {
    try {
      localStorage.setItem('visionary-preferences', JSON.stringify({ rows: preferences }))
      localStorage.setItem('visionary-player-destination', playerDestination)
    } catch { /* keep preferences active for this session */ }
  }, [preferences, playerDestination])

  const updatePreference = (id: string, field: 'category' | 'value', value: string) => {
    setPreferences(rows => rows.map(row => row.id === id ? { ...row, [field]: value } : row))
  }
  // =========================
  // AI CONNECTION
  // =========================

  useEffect(() => {
    const loadWakeSettings = async () => {
      try {
        const response = await apiFetch('/api/settings')
        if (!response.ok) throw new Error('Could not load wake settings')
        const saved = await readJson<{ wake_word?: string; wake_word_sensitivity?: string; wake_word_source?: string }>(response)
        if (saved?.wake_word) setWakeWord(saved.wake_word)
        if (saved?.wake_word_sensitivity) setWakeSensitivity(saved.wake_word_sensitivity)
        if (saved?.wake_word_source) setWakeSource(saved.wake_word_source)
      } catch {
        try {
          const saved = JSON.parse(localStorage.getItem('visionary-wake-settings') || '{}')
          if (saved.wake_word) setWakeWord(saved.wake_word)
          if (saved.wake_word_sensitivity) setWakeSensitivity(saved.wake_word_sensitivity)
          if (saved.wake_word_source) setWakeSource(saved.wake_word_source)
        } catch { /* keep defaults */ }
      }
    }
    void loadWakeSettings()
  }, [])

  const saveWakeSettings = async () => {
    const phrase = wakeWord.trim().split(' ').filter(Boolean).join(' ')
    if (!phrase || phrase.length > 100) {
      setWakeSaveError('Enter a phrase between 1 and 100 characters.')
      return
    }
    const settings = { wake_word: phrase, wake_word_sensitivity: wakeSensitivity, wake_word_source: wakeSource }
    setWakeSaveError('')
    try {
      const response = await apiFetch('/api/settings', { method: 'PUT', body: JSON.stringify(settings) })
      if (!response.ok) throw new Error('Could not save wake settings')
      const saved = (await readJson<typeof settings>(response)) || settings
      localStorage.setItem('visionary-wake-settings', JSON.stringify(saved))
      setWakeWord(saved.wake_word)
      window.dispatchEvent(new CustomEvent('visionary:wake-settings-updated', { detail: saved }))
      setWakeSaved(true)
      window.setTimeout(() => setWakeSaved(false), 2200)
    } catch {
      localStorage.setItem('visionary-wake-settings', JSON.stringify(settings))
      window.dispatchEvent(new CustomEvent('visionary:wake-settings-updated', { detail: settings }))
      setWakeSaveError('Saved on this browser only; backend sync is unavailable.')
    }
  }

  const handleConnectAI = () => {
    if (aiProvider === 'Groq') {
      alert('Groq is ready to use.')
      return
    }

    alert(
      `${aiProvider} account connection will be configured next.`
    )
  }

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-4xl mx-auto">
      <Section title="Personal Preferences">
        <p className="font-mono text-[10px] leading-relaxed text-white/40">
          Define what each function should use. Both columns are editable free-text fields. Your entries are saved automatically and spelling variations are interpreted when you give a command; your original text stays editable.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2">
          <span className="font-mono text-[10px] uppercase tracking-widest text-white/45">Function</span>
          <span className="font-mono text-[10px] uppercase tracking-widest text-white/45">App</span>
          <span className="hidden sm:block" />
        </div>
        {preferences.map(row => (
          <div key={row.id} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2 items-center">
            <label className="min-w-0">
              <span className="sr-only">Function</span>
              <input aria-label="Function" value={row.category}
                onChange={event => updatePreference(row.id, 'category', event.target.value)}
                placeholder="Function, e.g. Music"
                className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white outline-none focus:border-cyan-400/50" />
            </label>
            <label className="min-w-0">
              <span className="sr-only">App</span>
              <input aria-label="App" value={row.value}
                onChange={event => updatePreference(row.id, 'value', event.target.value)}
                placeholder="App, e.g. Spotify or yt"
                className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white outline-none focus:border-cyan-400/50" />
            </label>
            <button type="button" aria-label="Remove preference"
              onClick={() => setPreferences(rows => rows.filter(item => item.id !== row.id))}
              className="rounded-lg border border-white/10 px-3 py-2 font-mono text-xs text-white/50 hover:text-red-300">Remove</button>
          </div>
        ))}
        <button type="button"
          onClick={() => setPreferences(rows => [...rows, { id: 'preference-' + Date.now(), category: '', value: '' }])}
          className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 font-mono text-xs text-cyan-200 hover:bg-cyan-400/20">+ Add preference</button>
        {preferences.some(row => normalizePreference(row.value, 'value') === 'YouTube') && (
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
            <div>
              <div className="font-mono text-xs text-white/85">YouTube playback behavior</div>
              <p className="font-mono text-[10px] leading-relaxed text-white/40 mt-1">Your App entry can be YouTube, yt, youtub, or another recognized spelling. Choose where it should play.</p>
            </div>
            <SettingRow label="When YouTube is requested" description="Choose the playback destination">
              <Select options={['Visionary Nexus player', 'Open website']}
                value={playerDestination === 'website' ? 'Open website' : 'Visionary Nexus player'}
                onChange={value => setPlayerDestination(value === 'Open website' ? 'website' : 'internal')} />
            </SettingRow>
            <p className="font-mono text-[10px] leading-relaxed text-white/35">Autoplay depends on browser permissions, YouTube availability and account restrictions. Visionary Nexus cannot guarantee autoplay or control every external website player.</p>
          </div>
        )}
        <p className="font-mono text-[10px] leading-relaxed text-white/35">Wake-word listening needs Chrome microphone permission and the Visionary Nexus tab left open. Chrome can suspend browser speech recognition in a background tab or while the laptop sleeps. Cross-app wake detection requires a native global listener. The Windows companion can manage supported audio focus without pausing a game's screen.</p>
      </Section>
    </div>
  )
}


