import { useEffect, useState } from 'react'
import { apiFetch, readJson } from '../services/api'
import { APP_DIRECTORY, getStoredBirthday, saveBirthday, openApp } from '../services/universalApps'
import { getAvailableSpeechVoices, getPreferredSpeechVoice, setPreferredSpeechVoice, setVoiceResponsesEnabled, speakText } from '../services/speech'
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
  optionLabels,
}: {
  options: string[]
  value: string
  onChange: (v: string) => void
  optionLabels?: Record<string, string>
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
          {optionLabels?.[o] || o}
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

export default function Settings({ onSignOut }: { onSignOut?: () => void } = {}) {
  // =========================
  // AI
  // =========================

  const [birthday, setBirthday] = useState(getStoredBirthday)
  const [birthdaySaved, setBirthdaySaved] = useState(false)
  const [aiProvider, setAiProvider] = useState('Groq')
  const [aiModel, setAiModel] = useState('Llama')
  const [aiTemp, setAiTemp] = useState(72)
  const [aiContext, setAiContext] = useState(4096)
  const [streamResponse, setStreamResponse] = useState(true)
  const [voiceResponse, setVoiceResponse] = useState(() => { try { return localStorage.getItem('visionary-voice-responses') !== 'false' } catch { return true } })
  const [autoAnalyze, setAutoAnalyze] = useState(false)

  // =========================
  // CAMERA
  // =========================

  const [camResolution, setCamResolution] = useState('1920×1080')
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
  const [tts, setTts] = useState(getPreferredSpeechVoice)
  const [speechVoices, setSpeechVoices] = useState<SpeechSynthesisVoice[]>([])
  const [voiceTestStatus, setVoiceTestStatus] = useState('')
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

  // User-defined function-to-app preferences are browser-persisted.
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
  const [preferencesSaveStatus, setPreferencesSaveStatus] = useState('Loading saved preferences...')

  useEffect(() => {
    const syncPreferences = () => {
      try {
        const saved = JSON.parse(localStorage.getItem('visionary-preferences') || 'null')
        if (Array.isArray(saved?.rows)) setPreferences(saved.rows)
        setPlayerDestination(localStorage.getItem('visionary-player-destination') === 'website' ? 'website' : 'internal')
      } catch {
        // Keep the current settings if browser storage is unavailable.
      }
    }
    window.addEventListener('visionary:preferences-updated', syncPreferences)
    return () => window.removeEventListener('visionary:preferences-updated', syncPreferences)
  }, [])

  useEffect(() => {
    try {
      const serialized = JSON.stringify({ rows: preferences })
      localStorage.setItem('visionary-preferences', serialized)
      localStorage.setItem('visionary-player-destination', playerDestination)
      const storedRows = JSON.parse(localStorage.getItem('visionary-preferences') || 'null')
      const storedDestination = localStorage.getItem('visionary-player-destination')
      if (JSON.stringify(storedRows?.rows) !== JSON.stringify(preferences) || storedDestination !== playerDestination) {
        throw new Error('Preference verification failed')
      }
      setPreferencesSaveStatus('Saved on this browser')
    } catch {
      setPreferencesSaveStatus('Could not save preferences in this browser')
    }
  }, [preferences, playerDestination])

  const updatePreference = (id: string, field: 'category' | 'value', value: string) => {
    setPreferences(rows => rows.map(row => row.id === id ? { ...row, [field]: value } : row))
  }

  // =========================
  // AI CONNECTION
  // =========================

  useEffect(() => {
    const refreshVoices = () => {
      const available = getAvailableSpeechVoices()
      setSpeechVoices(available)
      const selected = getPreferredSpeechVoice()
      if (available.length > 0 && selected && !available.some(voice => voice.voiceURI === selected)) {
        setTts('')
        setPreferredSpeechVoice('')
      }
    }
    refreshVoices()
    if ('speechSynthesis' in window) window.speechSynthesis.addEventListener('voiceschanged', refreshVoices)
    window.addEventListener('visionary:tts-settings-updated', refreshVoices)
    return () => {
      if ('speechSynthesis' in window) window.speechSynthesis.removeEventListener('voiceschanged', refreshVoices)
      window.removeEventListener('visionary:tts-settings-updated', refreshVoices)
    }
  }, [])
  useEffect(() => { setVoiceResponsesEnabled(voiceResponse) }, [voiceResponse])

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

      {/* =========================
          HEADER
      ========================= */}

      <div>
        <h1 className="font-display text-2xl font-bold tracking-widest text-white">
          SETTINGS
        </h1>

        <div className="font-mono text-xs text-white/30 tracking-widest mt-0.5 uppercase">
          System Configuration — SG-OS v2.4.1
        </div>
      </div>

      <Section title="Personal Details & App Integrations">
        <div className="space-y-2">
          <label htmlFor="vn-birthday" className="block font-mono text-xs text-white/80">Birthday</label>
          <p className="font-mono text-[10px] text-white/35">Saved on this browser for date questions and countdowns. Calendar account access requires a separate authorised connection.</p>
          <div className="flex flex-wrap items-center gap-3">
            <input id="vn-birthday" type="date" value={birthday} onChange={event => { setBirthday(event.target.value); setBirthdaySaved(false) }} className="rounded-lg border border-cyan-400/20 bg-slate-950 px-3 py-2 font-mono text-xs text-cyan-100 outline-none" />
            <button type="button" onClick={() => { saveBirthday(birthday); setBirthdaySaved(true) }} className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 font-mono text-xs text-cyan-200 hover:bg-cyan-400/20">Save birthday</button>
            {birthdaySaved && <span role="status" className="font-mono text-xs text-emerald-300">Saved on this browser</span>}
          </div>
        </div>
        <div className="border-t border-white/10 pt-4">
          <p className="mb-3 font-mono text-xs text-white/80">Open apps without connecting private accounts</p>
          <p className="mb-3 font-mono text-[10px] text-white/35">Universal links may open an installed app; otherwise the website opens. Reading private data or changing accounts needs separate permissions.</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {APP_DIRECTORY.map(app => (
              <button key={app.id} type="button" onClick={() => openApp(app)} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3 text-left hover:bg-white/[0.07]">
                <span><span className="block font-mono text-xs text-white/85">{app.name}</span><span className="mt-1 block font-mono text-[10px] text-white/35">{app.description}</span></span>
                <span className="font-mono text-[10px] text-cyan-300">OPEN ↗</span>
              </button>
            ))}
          </div>
        </div>
      </Section>

      {/* =========================
          AI CONFIGURATION
      ========================= */}

      <Section title="Personal Preferences">
        <p className="font-mono text-[10px] leading-relaxed text-white/40">
          Define what each function should use. Both columns are editable free-text fields. Your entries are saved automatically and spelling variations are interpreted when you give a command; your original text stays editable.
        </p>
        <p role="status" aria-live="polite" className={`font-mono text-[10px] ${preferencesSaveStatus.startsWith('Saved') ? 'text-green-300/70' : 'text-amber-300/80'}`}>
          {preferencesSaveStatus}
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
        {preferences.some(row => normalizePreference(row.value, 'value') === 'Spotify') && (
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-2">
            <div className="font-mono text-xs text-white/85">Spotify playback behavior</div>
            <p className="font-mono text-[10px] leading-relaxed text-white/40">Music commands using this preference open Spotify search in a new tab instead of playing YouTube inside Visionary Nexus.</p>
            <p className="font-mono text-[10px] leading-relaxed text-amber-200/70">Spotify does not support reliable autoplay when Visionary Nexus opens it this way. Visionary Nexus can open Spotify and show your search results, but it cannot automatically start the track. You need to press Play manually in the Spotify tab.</p>
          </div>
        )}
        <p className="font-mono text-[10px] leading-relaxed text-white/35">Wake-word listening needs Chrome microphone permission and the Visionary Nexus tab left open. Chrome can suspend browser speech recognition in a background tab or while the laptop sleeps. Cross-app wake detection requires a native global listener. The Windows companion can manage supported audio focus without pausing a game's screen.</p>
      </Section>

      <Section title="AI Configuration">

        <SettingRow
          label="AI Assistant"
          description="Select your AI provider"
        >
          <Select
            options={['Groq', 'ChatGPT', 'Gemini']}
            value={aiProvider}
            onChange={setAiProvider}
          />
        </SettingRow>

        <SettingRow
          label="Account Status"
          description={
            aiProvider === 'Groq'
              ? 'Built-in AI service'
              : `Requires your own ${aiProvider} access`
          }
        >
          <span
            className="font-mono text-xs"
            style={{
              color:
                aiProvider === 'Groq'
                  ? '#00e5ff'
                  : '#f59e0b',
            }}
          >
            {aiProvider === 'Groq'
              ? 'READY'
              : 'NOT CONNECTED'}
          </span>
        </SettingRow>

        {aiProvider !== 'Groq' && (
          <button
            onClick={handleConnectAI}
            className="w-full py-2.5 rounded-xl font-display text-[11px] tracking-widest transition-all duration-300 hover:scale-[1.01]"
            style={{
              background: 'rgba(0,229,255,0.08)',
              border: '1px solid rgba(0,229,255,0.3)',
              color: '#00e5ff',
            }}
          >
            CONNECT {aiProvider.toUpperCase()}
          </button>
        )}

        <SettingRow
          label="AI Model"
          description="Selected inference model"
        >
          <Select
            options={
              aiProvider === 'Groq'
                ? ['Llama', 'Fast', 'Balanced', 'Advanced']
                : aiProvider === 'Gemini'
                  ? ['Gemini Flash', 'Gemini Pro', 'Automatic']
                  : ['GPT', 'Fast', 'Balanced', 'Automatic']
            }
            value={aiModel}
            onChange={setAiModel}
          />
        </SettingRow>

        <SettingRow
          label="Response Temperature"
          description="Creativity vs determinism"
        >
          <div className="w-40">
            <Slider
              value={aiTemp}
              onChange={setAiTemp}
            />
          </div>
        </SettingRow>

        <SettingRow
          label="Context Window"
          description="Token memory limit"
        >
          <Select
            options={[
              '2048',
              '4096',
              '8192',
              '16384',
            ]}
            value={String(aiContext)}
            onChange={v => setAiContext(Number(v))}
          />
        </SettingRow>

        <SettingRow
          label="Stream Responses"
          description="Real-time token display"
        >
          <Toggle
            value={streamResponse}
            onChange={setStreamResponse}
          />
        </SettingRow>

        <SettingRow
          label="Voice Responses"
          description="TTS for AI output"
        >
          <Toggle
            value={voiceResponse}
            onChange={value => { setVoiceResponse(value); setVoiceResponsesEnabled(value) }}
          />
        </SettingRow>

        <SettingRow
          label="Auto Scene Analysis"
          description="Analyze on capture"
        >
          <Toggle
            value={autoAnalyze}
            onChange={setAutoAnalyze}
            color="#a855f7"
          />
        </SettingRow>

      </Section>

      {/* =========================
          CAMERA
      ========================= */}

      <Section title="Camera Settings">

        <SettingRow label="Resolution">
          <Select
            options={[
              '1920×1080',
              '1280×720',
              '640×480',
              '320×240',
            ]}
            value={camResolution}
            onChange={setCamResolution}
          />
        </SettingRow>

        <SettingRow label="Frame Rate">
          <Select
            options={[
              '60fps',
              '30fps',
              '24fps',
              '15fps',
            ]}
            value={camFps}
            onChange={setCamFps}
          />
        </SettingRow>

        <SettingRow
          label="HDR Mode"
          description="High dynamic range"
        >
          <Toggle
            value={camHDR}
            onChange={setCamHDR}
          />
        </SettingRow>

        <SettingRow
          label="Night Vision"
          description="Low-light enhancement"
        >
          <Toggle
            value={camNight}
            onChange={setCamNight}
            color="#4d9eff"
          />
        </SettingRow>

        <SettingRow label="Brightness">
          <div className="w-40">
            <Slider
              value={camBrightness}
              onChange={setCamBrightness}
            />
          </div>
        </SettingRow>

        <SettingRow label="Contrast">
          <div className="w-40">
            <Slider
              value={camContrast}
              onChange={setCamContrast}
            />
          </div>
        </SettingRow>

      </Section>

      {/* =========================
          MICROPHONE
      ========================= */}

      <Section title="Microphone Settings">

        <SettingRow
          label="Input Gain"
          description="Microphone amplification"
        >
          <div className="w-40">
            <Slider
              value={micGain}
              onChange={setMicGain}
              color="#a855f7"
            />
          </div>
        </SettingRow>

        <SettingRow
          label="Noise Suppression"
          description="AI-based background removal"
        >
          <Toggle
            value={micNoise}
            onChange={setMicNoise}
            color="#a855f7"
          />
        </SettingRow>

        <SettingRow label="Echo Cancellation">
          <Toggle
            value={micEcho}
            onChange={setMicEcho}
            color="#a855f7"
          />
        </SettingRow>

        <SettingRow label="Custom Wake Word" description="Type any word or phrase; default is Vision">
          <input
            aria-label="Custom wake word"
            value={wakeWord}
            onChange={event => setWakeWord(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') void saveWakeSettings() }}
            maxLength={100}
            placeholder="Vision, Orion, Hey Computer…"
            className="w-48 max-w-full rounded-lg border border-cyan-400/20 bg-slate-950 px-3 py-2 font-mono text-xs text-cyan-200 outline-none focus:border-cyan-400/60"
          />
        </SettingRow>
        <SettingRow label="Detection Sensitivity" description="High is the default; may increase false activations">
          <Select options={['high', 'balanced', 'low']} value={wakeSensitivity} onChange={setWakeSensitivity} />
        </SettingRow>
        <p className="font-mono text-[10px] leading-relaxed text-white/35">Wake listening uses the browser speech-recognition service while the app is open. It listens through the operating system’s default microphone; when the glasses expose an audio input, select that input as the Windows default. Offline detection for arbitrary phrases needs a local speech recognizer or a trained model.</p>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => void saveWakeSettings()} className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 font-mono text-xs text-cyan-200 hover:bg-cyan-400/20">Save Wake Settings</button>
          {wakeSaved && <span className="font-mono text-xs text-emerald-300">Saved</span>}
          {wakeSaveError && <span role="status" className="font-mono text-xs text-amber-300">{wakeSaveError}</span>}
        </div>

      </Section>

      {/* =========================
          SPEAKER
      ========================= */}

      <Section title="Speaker Settings">

        <SettingRow label="Volume">
          <div className="w-40">
            <Slider
              value={speakerVolume}
              onChange={setSpeakerVolume}
              color="#4d9eff"
            />
          </div>
        </SettingRow>

        <SettingRow
          label="TTS Voice"
          description="Text-to-speech engine"
        >
          <div className="flex items-center gap-2">
            <Select
              options={['', ...speechVoices.map(voice => voice.voiceURI)]}
              optionLabels={{ '': 'System default', ...Object.fromEntries(speechVoices.map(voice => [voice.voiceURI, voice.name + ' (' + voice.lang + ')'])) }}
              value={tts}
              onChange={value => { setTts(value); setPreferredSpeechVoice(value) }}
            />
            <button type="button" onClick={() => {
              setVoiceTestStatus('Playing test…')
              const started = speakText('This is a Visionary Nexus voice test. Your selected voice is active.', { force: true, onError: error => setVoiceTestStatus('Speech error: ' + error), onStart: () => setVoiceTestStatus('Speaking…') })
              if (!started) setVoiceTestStatus('Voice responses are disabled or unavailable.')
              else setVoiceTestStatus('Test requested. Check your speakers.')
            }} className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-xs text-cyan-100 hover:bg-cyan-400/20">Test</button>
          </div>
          {voiceTestStatus && <p className="text-[10px] text-white/50" role="status">{voiceTestStatus}</p>}
        </SettingRow>

        <SettingRow label="EQ Enhancement">
          <Toggle
            value={speakerEQ}
            onChange={setSpeakerEQ}
            color="#4d9eff"
          />
        </SettingRow>

      </Section>

      {/* =========================
          NETWORK & BACKEND
      ========================= */}

      <Section title="Network & Backend API">
        <SettingRow label="Backend endpoint" description="Resolved automatically from this deployment">
          <span className="font-mono text-xs text-cyan-300">Automatic</span>
        </SettingRow>
        <p className="font-mono text-[10px] leading-relaxed text-white/40">
          Visionary Nexus uses its configured API endpoint automatically. No fixed LAN IP or Wi-Fi name is stored in this page. Device Wi-Fi is configured during device provisioning.
        </p>
      </Section>

      {/* =========================
          APPEARANCE
      ========================= */}

      <Section title="Appearance">

        <SettingRow label="Theme">
          <Select
            options={[
              'Orion Dark',
              'Midnight',
              'Deep Space',
              'Cyber',
            ]}
            value={theme}
            onChange={setTheme}
          />
        </SettingRow>

        <SettingRow label="Accent Color">
          <Select
            options={[
              'Cyan',
              'Purple',
              'Blue',
              'Green',
              'Violet',
            ]}
            value={accentColor}
            onChange={setAccentColor}
          />
        </SettingRow>

        <SettingRow
          label="Animations"
          description="UI motion effects"
        >
          <Toggle
            value={animations}
            onChange={setAnimations}
          />
        </SettingRow>

        <SettingRow
          label="HUD Overlays"
          description="Camera HUD elements"
        >
          <Toggle
            value={hud}
            onChange={setHud}
          />
        </SettingRow>

        <SettingRow
          label="Glassmorphism Blur"
          description="Backdrop filter effects"
        >
          <Toggle
            value={blur}
            onChange={setBlur}
          />
        </SettingRow>

      </Section>

      {/* =========================
          DANGER ZONE
      ========================= */}

      <div
        className="glass rounded-2xl p-5"
        style={{
          border: '1px solid rgba(239,68,68,0.2)',
        }}
      >

        <div className="font-display text-xs tracking-widest text-red-400/70 uppercase mb-4">
          Danger Zone
        </div>

        <div className="flex flex-col sm:flex-row gap-3">

          <button
            type="button"
            onClick={() => onSignOut?.()}
            className="flex-1 py-2.5 rounded-xl font-display text-[11px] tracking-widest transition-all duration-300 hover:scale-[1.01]"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.2)', color: '#ffffff' }}
          >
            SIGN OUT
          </button>

          <button
            className="flex-1 py-2.5 rounded-xl font-display text-[11px] tracking-widest transition-all duration-300 hover:scale-[1.01]"
            style={{
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.3)',
              color: '#ef4444',
            }}
          >
            FACTORY RESET
          </button>

          <button
            className="flex-1 py-2.5 rounded-xl font-display text-[11px] tracking-widest transition-all duration-300 hover:scale-[1.01]"
            style={{
              background: 'rgba(245,158,11,0.08)',
              border: '1px solid rgba(245,158,11,0.3)',
              color: '#f59e0b',
            }}
          >
            REBOOT DEVICE
          </button>

        </div>

      </div>

    </div>
  )
}