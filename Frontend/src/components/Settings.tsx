import { useEffect, useState } from 'react'
import { apiFetch, readJson, setSession } from '../services/api'

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

export default function Settings({ onSignOut }: { onSignOut?: () => void }) {
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
  const [tts, setTts] = useState('Neural-en-US')
  const [speakerEQ, setSpeakerEQ] = useState(false)

  // =========================
  // NETWORK
  // =========================

  const [wifiSSID] = useState('SG-Network-5G')
  const [autoConnect, setAutoConnect] = useState(true)
  const [cloudSync, setCloudSync] = useState(true)

  // =========================
  // APPEARANCE
  // =========================

  const [theme, setTheme] = useState('Orion Dark')
  const [accentColor, setAccentColor] = useState('Cyan')
  const [animations, setAnimations] = useState(true)
  const [hud, setHud] = useState(true)
  const [blur, setBlur] = useState(true)

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

      {/* =========================
          AI CONFIGURATION
      ========================= */}

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
            onChange={setVoiceResponse}
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
          <Select
            options={[
              'Neural-en-US',
              'Neural-en-GB',
              'Neural-en-AU',
              'Standard-en-US',
            ]}
            value={tts}
            onChange={setTts}
          />
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

      <Section title="Network">

        <SettingRow
          label="Network"
          description="Current SSID"
        >
          <span className="font-mono text-xs text-cyan-400">
            {wifiSSID}
          </span>
        </SettingRow>

        <SettingRow label="Auto Connect">
          <Toggle
            value={autoConnect}
            onChange={setAutoConnect}
          />
        </SettingRow>

        <SettingRow
          label="Cloud Sync"
          description="Upload events to SG-Cloud"
        >
          <Toggle
            value={cloudSync}
            onChange={setCloudSync}
          />
        </SettingRow>


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

      <Section title="Account">
        <SettingRow label="Current session" description="Your Visionary Nexus account is signed in.">
          <button
            type="button"
            onClick={() => {
              setSession(null, null)
              onSignOut?.()
            }}
            className="rounded-lg border border-red-400/30 bg-red-400/10 px-4 py-2 font-mono text-xs tracking-wider text-red-300 hover:bg-red-400/20"
          >
            SIGN OUT
          </button>
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