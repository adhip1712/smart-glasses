import { useCallback, useEffect, useRef, useState } from 'react'

import {
  STATUS_COLORS,
  STATUS_LABELS,
  SETUP_STEPS,
  fetchDevice,
  fetchDevices,
  fetchProvisionStatus,
  provisionDevice,
  restartSetup,
  setupProgress,
  startSetupSession,
  type DeviceDetail,
  type DeviceStatus,
  type DeviceSummary,
} from '../api/device'

interface LogEntry {
  time: string
  message: string
  type: 'info' | 'warn' | 'success' | 'error'
}

const logColors = {
  info: '#4d9eff',
  warn: '#f59e0b',
  success: '#4ade80',
  error: '#ef4444',
}

// Polling intervals. Reads only - a poll never creates a device.
const LIST_POLL_MS = 5000
const STATUS_POLL_MS = 2000

const FAILURE_STATES: DeviceStatus[] = [
  'wifi_failed',
  'pairing_failed',
  'registration_failed',
  'camera_failed',
]

function nowTime() {
  return new Date().toLocaleTimeString('en-US', { hour12: false })
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

function StatusPill({ status }: { status: DeviceStatus }) {
  const color = STATUS_COLORS[status] ?? '#9ca3af'

  return (
    <span
      className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full font-mono text-[10px] tracking-widest"
      style={{ color, border: `1px solid ${color}40`, background: `${color}12` }}
    >
      <span className="w-1.5 h-1.5 rounded-full animate-status-blink" style={{ background: color, color }} />
      {STATUS_LABELS[status] ?? status.toUpperCase()}
    </span>
  )
}

function humanAge(seconds: number | null) {
  if (seconds === null || seconds === undefined) return 'never'
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}

export default function Device() {
  const [devices, setDevices] = useState<DeviceSummary[]>([])
  const [backendError, setBackendError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [log, setLog] = useState<LogEntry[]>([])

  // ---- setup wizard -------------------------------------------------
  const [wizardOpen, setWizardOpen] = useState(false)
  const [wizardStep, setWizardStep] = useState<'network' | 'waiting' | 'done'>('network')
  const [sessionDevice, setSessionDevice] = useState<DeviceDetail | null>(null)
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [ssid, setSsid] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // Guards: a rerender, a double click or a StrictMode double-mount must
  // never turn into a second "create device" call.
  const addGlassesRef = useRef(false)
  const lastLoggedStatus = useRef<string | null>(null)

  const appendLog = useCallback((message: string, type: LogEntry['type'] = 'info') => {
    setLog(prev => [{ time: nowTime(), message, type }, ...prev].slice(0, 40))
  }, [])

  // ---- reads only ---------------------------------------------------
  const loadDevices = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await fetchDevices(signal)

      setDevices(data.devices)
      setBackendError(null)

      const primary = data.devices[0]

      if (primary && lastLoggedStatus.current !== primary.status) {
        appendLog(
          `Device ${primary.device_id}: ${STATUS_LABELS[primary.status] ?? primary.status}`,
          primary.online ? 'success' : FAILURE_STATES.includes(primary.status) ? 'error' : 'info',
        )
        lastLoggedStatus.current = primary.status
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        setBackendError((error as Error).message)
      }
    } finally {
      setLoading(false)
    }
  }, [appendLog])

  useEffect(() => {
    const controller = new AbortController()

    void loadDevices(controller.signal)
    const interval = window.setInterval(() => void loadDevices(controller.signal), LIST_POLL_MS)

    return () => {
      controller.abort()
      window.clearInterval(interval)
    }
  }, [loadDevices])

  // Wizard polling: read-only, one interval per open wizard, cleaned up on
  // unmount / HMR so it cannot pile up.
  const sessionDeviceId = sessionDevice?.device_id ?? null

  useEffect(() => {
    if (!wizardOpen || wizardStep === 'done' || !sessionDeviceId) return

    const controller = new AbortController()
    let cancelled = false

    const tick = async () => {
      try {
        const data = await fetchProvisionStatus(sessionDeviceId, controller.signal)

        if (cancelled) return

        setSessionDevice(data.device)

        if (data.device.status === 'online') {
          setWizardStep('done')
          appendLog(`Device ${data.device.device_id} is ONLINE (heartbeat received)`, 'success')
        }
      } catch {
        // polling is best-effort; the list poll surfaces backend problems
      }
    }

    void tick()
    const interval = window.setInterval(() => void tick(), STATUS_POLL_MS)

    return () => {
      cancelled = true
      controller.abort()
      window.clearInterval(interval)
    }
  }, [wizardOpen, wizardStep, sessionDeviceId, appendLog])

  // ---- actions ------------------------------------------------------

  /** "Add Glasses" - resume or reserve the ONE setup session. */
  const handleAddGlasses = useCallback(async () => {
    if (addGlassesRef.current) return
    addGlassesRef.current = true
    setBusy(true)
    setFormError(null)

    try {
      const existing = devices[0]

      if (existing) {
        // A device already exists (pending, failed or registered) - adopt it.
        const detail = await fetchDevice(existing.device_id)
        setSessionDevice(detail.device)
        setSsid(existing.wifi_ssid ?? '')
        appendLog(`Resuming setup for existing device ${existing.device_id}`, 'info')
      } else {
        const session = await startSetupSession()
        setSessionDevice(session.device)
        appendLog(
          session.created
            ? `Reserved device identity ${session.device.device_id}`
            : `Reusing device ${session.device.device_id}`,
          'success',
        )
      }

      setPairingCode(null)
      setWizardStep('network')
      setWizardOpen(true)
      void loadDevices()
    } catch (error) {
      setFormError((error as Error).message)
      appendLog(`Could not start setup: ${(error as Error).message}`, 'error')
    } finally {
      setBusy(false)
      addGlassesRef.current = false
    }
  }, [devices, appendLog, loadDevices])

  /** Queue Wi-Fi credentials on the SAME device and reuse its token. */
  const handleProvision = useCallback(async (event: React.FormEvent) => {
    event.preventDefault()

    if (!ssid.trim()) {
      setFormError('Enter the Wi-Fi network name')
      return
    }

    setBusy(true)
    setFormError(null)

    try {
      const provisioned = await provisionDevice({
        deviceId: sessionDeviceId,
        ssid: ssid.trim(),
        password,
      })

      setSessionDevice(provisioned.device)
      setPairingCode(provisioned.pairing_code ?? null)
      setWizardStep('waiting')

      appendLog(
        `Wi-Fi "${provisioned.device.wifi_ssid}" queued for ${provisioned.device.device_id} ` +
        `(device token ${provisioned.device_token_reused ? 'reused' : 'issued'}, ` +
        `still ${STATUS_LABELS[provisioned.device.status]})`,
        'success',
      )

      void loadDevices()
    } catch (error) {
      setFormError((error as Error).message)
      appendLog(`Provisioning failed: ${(error as Error).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }, [sessionDeviceId, ssid, password, appendLog, loadDevices])

  /** Retry on a failed device without creating a new one. */
  const handleRestartSetup = useCallback(async (deviceId: string) => {
    setBusy(true)
    setFormError(null)

    try {
      const restarted = await restartSetup(deviceId)

      setSessionDevice(restarted.device)
      setPairingCode(null)
      setWizardStep('network')
      setWizardOpen(true)
      appendLog(`Setup restarted on device ${restarted.device.device_id} (same identity)`, 'warn')
      void loadDevices()
    } catch (error) {
      setFormError((error as Error).message)
      appendLog(`Could not restart setup: ${(error as Error).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }, [appendLog, loadDevices])

  const closeWizard = useCallback(() => {
    setWizardOpen(false)
    setFormError(null)
  }, [])

  // ---- derived ------------------------------------------------------
  const primary = devices[0] ?? null
  const liveStatus: DeviceStatus | null = sessionDevice?.status ?? primary?.status ?? null
  const online = liveStatus === 'online'
  const progress = liveStatus ? setupProgress(liveStatus) : 0
  const failed = liveStatus ? FAILURE_STATES.includes(liveStatus) : false
  const battery = primary?.battery ?? 74
  const rssi = primary?.rssi ?? null
  const signalStrength = rssi === null ? 4 : rssi > -50 ? 5 : rssi > -60 ? 4 : rssi > -70 ? 3 : 2

  const components = [
    {
      name: 'ESP32-CAM',
      model: 'AI-Thinker v2',
      status: online ? 'ONLINE' : liveStatus ? (STATUS_LABELS[liveStatus] ?? 'UNKNOWN') : 'NOT PAIRED',
      statusColor: online ? '#4ade80' : liveStatus ? (STATUS_COLORS[liveStatus] ?? '#9ca3af') : '#9ca3af',
      details: [
        { label: 'Firmware', value: primary?.firmware ?? '—' },
        { label: 'Resolution', value: '1920×1080' },
        { label: 'Device ID', value: primary?.device_id ?? '—' },
        { label: 'Token', value: primary?.device_token_last4 ? `••••${primary.device_token_last4}` : '—' },
      ],
      borderColor: online ? 'rgba(74,222,128,0.2)' : 'rgba(255,255,255,0.08)',
    },
    {
      name: 'INMP441',
      model: 'MEMs Microphone',
      status: online ? 'READY' : 'IDLE',
      statusColor: online ? '#a855f7' : '#6b7280',
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
      status: online ? 'IDLE' : 'IDLE',
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
            Hardware Interface Layer · {devices.length} device{devices.length === 1 ? '' : 's'} known
          </div>
        </div>
        <div className="flex items-center gap-4">
          <BatteryIcon level={battery} />
          <SignalBars strength={signalStrength} />
        </div>
      </div>

      {backendError && (
        <div className="glass rounded-2xl p-4 font-mono text-xs"
          style={{ border: '1px solid rgba(239,68,68,0.35)', color: '#fca5a5' }}>
          Backend unreachable ({backendError}). Polling continues; no device is created by this screen.
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void handleAddGlasses()}
          disabled={busy}
          className="px-4 py-2.5 rounded-xl font-display text-xs tracking-widest transition-all duration-300 disabled:opacity-40"
          style={{
            color: '#00e5ff',
            border: '1px solid rgba(0,229,255,0.4)',
            background: 'rgba(0,229,255,0.08)',
            boxShadow: '0 0 18px rgba(0,229,255,0.15)',
          }}
        >
          {primary ? 'SET UP DEVICE' : 'ADD GLASSES'}
        </button>
        <button
          onClick={() => void loadDevices()}
          disabled={loading}
          className="px-4 py-2.5 rounded-xl font-display text-xs tracking-widest text-white/60 hover:text-white/90 transition-colors"
          style={{ border: '1px solid rgba(255,255,255,0.12)' }}
        >
          REFRESH
        </button>
        <span className="font-mono text-[10px] text-white/30">
          refresh &amp; polling are read-only — they never create a device
        </span>
      </div>

      {/* Registered devices */}
      <div className="glass rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <span className="font-display text-xs tracking-widest text-white/50 uppercase">
            Registered Devices
          </span>
          <span className="font-mono text-[10px] text-white/30">
            {devices.length} record{devices.length === 1 ? '' : 's'} · one per physical unit
          </span>
        </div>

        {devices.length === 0 ? (
          <div className="font-mono text-[11px] text-white/30 py-6 text-center">
            {loading ? 'Loading…' : 'No device yet. “Add Glasses” reserves exactly one setup session.'}
          </div>
        ) : (
          <div className="space-y-3">
            {devices.map(device => (
              <div key={device.device_id} className="rounded-xl p-4 grid grid-cols-1 lg:grid-cols-[1.4fr_1fr_auto] gap-4 items-start"
                style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)' }}>
                <div className="space-y-2">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="font-display text-sm font-bold text-white tracking-wider">{device.name}</span>
                    <StatusPill status={device.status} />
                  </div>
                  <div className="font-mono text-[10px] text-white/40 flex flex-wrap gap-x-4 gap-y-1">
                    <span>ID <span style={{ color: '#00e5ff' }}>{device.device_id}</span></span>
                    <span>HW {device.hardware_uid ?? 'not reported yet'}</span>
                    <span>TOKEN ••••{device.device_token_last4 ?? '----'}</span>
                  </div>
                  <div className="font-mono text-[10px] text-white/30">
                    {device.status_detail ?? '—'}
                  </div>
                </div>

                <div className="font-mono text-[10px] text-white/40 grid grid-cols-2 gap-x-4 gap-y-1">
                  <span>Wi-Fi</span><span className="text-white/70">{device.wifi_ssid ?? '—'}</span>
                  <span>IP</span><span className="text-white/70">{device.ip_address ?? '—'}</span>
                  <span>Heartbeat</span><span className="text-white/70">{humanAge(device.heartbeat_age_seconds)}</span>
                  <span>Counts</span>
                  <span className="text-white/70">
                    reg {device.registration_count} · hb {device.heartbeat_count} · setup {device.setup_attempts}
                  </span>
                </div>

                <div className="flex lg:flex-col gap-2">
                  <button
                    onClick={() => void handleRestartSetup(device.device_id)}
                    disabled={busy}
                    className="px-3 py-1.5 rounded-lg font-mono text-[10px] tracking-widest text-amber-300/80 hover:text-amber-200 disabled:opacity-40 transition-colors"
                    style={{ border: '1px solid rgba(245,158,11,0.25)' }}
                  >
                    RETRY SETUP
                  </button>
                  <button
                    onClick={() => {
                      void (async () => {
                        try {
                          const detail = await fetchDevice(device.device_id)
                          setSessionDevice(detail.device)
                          setPairingCode(null)
                          setWizardStep(
                            detail.device.status === 'online'
                              ? 'done'
                              : detail.device.status === 'registered'
                                ? 'waiting'
                                : 'network',
                          )
                          setWizardOpen(true)
                        } catch (error) {
                          appendLog(`Could not open device: ${(error as Error).message}`, 'error')
                        }
                      })()
                    }}
                    className="px-3 py-1.5 rounded-lg font-mono text-[10px] tracking-widest text-cyan-300/80 hover:text-cyan-200 transition-colors"
                    style={{ border: '1px solid rgba(0,229,255,0.25)' }}
                  >
                    {device.online ? 'VIEW' : 'RESUME'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Setup wizard */}
      {wizardOpen && sessionDevice && (
        <div className="glass rounded-2xl p-5" style={{ border: '1px solid rgba(0,229,255,0.18)' }}>
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <div className="font-display text-xs tracking-widest text-white/60 uppercase">
                Setup · {sessionDevice.device_id}
              </div>
              <div className="font-mono text-[10px] text-white/30 mt-1">
                Device token ••••{sessionDevice.device_token_last4 ?? '----'} · reusing this identity on every retry
              </div>
            </div>
            <button onClick={closeWizard} className="font-mono text-[11px] text-white/40 hover:text-white/80">
              CLOSE
            </button>
          </div>

          {/* Progress */}
          <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-5">
            {SETUP_STEPS.map((step, index) => {
              const done = index < progress || online
              const active = index === progress && !online

              return (
                <div key={step.status} className="rounded-lg p-2"
                  style={{
                    border: `1px solid ${done ? 'rgba(74,222,128,0.35)' : active ? 'rgba(0,229,255,0.45)' : 'rgba(255,255,255,0.08)'}`,
                    background: done ? 'rgba(74,222,128,0.07)' : active ? 'rgba(0,229,255,0.07)' : 'transparent',
                  }}>
                  <div className="font-mono text-[9px] tracking-widest"
                    style={{ color: done ? '#4ade80' : active ? '#00e5ff' : 'rgba(255,255,255,0.35)' }}>
                    {step.label.toUpperCase()}
                  </div>
                  <div className="font-mono text-[9px] text-white/30 mt-1">{step.detail}</div>
                </div>
              )
            })}
          </div>

          {wizardStep === 'network' && (
            <form onSubmit={handleProvision} className="space-y-3 max-w-md">
              <div className="grid grid-cols-1 gap-3">
                <label className="font-mono text-[10px] text-white/40 tracking-widest uppercase">
                  Wi-Fi network
                  <input
                    value={ssid}
                    onChange={event => setSsid(event.target.value)}
                    placeholder="SG-Network-5G"
                    className="mt-1 w-full px-3 py-2 rounded-lg bg-black/40 font-mono text-xs text-white/90 outline-none"
                    style={{ border: '1px solid rgba(255,255,255,0.12)' }}
                  />
                </label>
                <label className="font-mono text-[10px] text-white/40 tracking-widest uppercase">
                  Wi-Fi password
                  <input
                    type="password"
                    value={password}
                    onChange={event => setPassword(event.target.value)}
                    placeholder="••••••••"
                    className="mt-1 w-full px-3 py-2 rounded-lg bg-black/40 font-mono text-xs text-white/90 outline-none"
                    style={{ border: '1px solid rgba(255,255,255,0.12)' }}
                  />
                </label>
              </div>

              {formError && <div className="font-mono text-[10px] text-red-300">{formError}</div>}

              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={busy}
                  className="px-4 py-2 rounded-lg font-display text-[11px] tracking-widest disabled:opacity-40"
                  style={{ color: '#00e5ff', border: '1px solid rgba(0,229,255,0.4)', background: 'rgba(0,229,255,0.08)' }}
                >
                  {busy ? 'PROVISIONING…' : 'PROVISION WI-FI'}
                </button>
                <span className="font-mono text-[10px] text-white/30">
                  updates the existing device · no new record
                </span>
              </div>
            </form>
          )}

          {wizardStep !== 'network' && (
            <div className="space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <StatusPill status={liveStatus ?? 'awaiting_setup'} />
                <span className="font-mono text-[11px] text-white/50">
                  {sessionDevice.status_detail ?? '—'}
                </span>
              </div>

              {pairingCode && (
                <div className="font-mono text-[11px] text-white/50">
                  Pairing code for the device: <span style={{ color: '#00e5ff' }}>{pairingCode}</span>
                  {' '}· the ESP32 exchanges it for its existing device token
                </div>
              )}

              {failed && (
                <div className="font-mono text-[11px]" style={{ color: '#fca5a5' }}>
                  {sessionDevice.last_error ?? 'Setup reported a failure.'}
                </div>
              )}

              <div className="font-mono text-[10px] text-white/30 space-y-1">
                <div>wifi_configured: {sessionDevice.wifi_configured_at ?? 'pending'}</div>
                <div>credentials_collected: {sessionDevice.credentials_collected_at ?? 'pending'}</div>
                <div>registered: {sessionDevice.registered_at ?? 'pending'}</div>
                <div>last_heartbeat: {sessionDevice.last_heartbeat_at ?? 'pending'}</div>
              </div>

              {wizardStep === 'done' && (
                <div className="font-mono text-xs" style={{ color: '#4ade80' }}>
                  Device is ONLINE. Heartbeats are updating this same record.
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={() => setWizardStep('network')}
                  className="px-3 py-1.5 rounded-lg font-mono text-[10px] tracking-widest text-white/50 hover:text-white/80"
                  style={{ border: '1px solid rgba(255,255,255,0.12)' }}
                >
                  CHANGE WI-FI
                </button>
                <button
                  onClick={() => void handleRestartSetup(sessionDevice.device_id)}
                  disabled={busy}
                  className="px-3 py-1.5 rounded-lg font-mono text-[10px] tracking-widest text-amber-300/80 hover:text-amber-200 disabled:opacity-40"
                  style={{ border: '1px solid rgba(245,158,11,0.25)' }}
                >
                  RESTART SETUP
                </button>
                <span className="font-mono text-[10px] text-white/30">
                  both keep device {sessionDevice.device_id}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Hardware components */}
        <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-3 gap-4">
          {components.map((comp) => (
            <div
              key={comp.name}
              className="glass rounded-2xl p-5 hover:scale-[1.02] transition-transform duration-300"
              style={{ border: `1px solid ${comp.borderColor}` }}
            >
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
                  <div key={label} className="flex justify-between items-center gap-2">
                    <span className="font-mono text-[10px] text-white/30">{label}</span>
                    <span className="font-mono text-[10px] text-white/70 truncate">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Live telemetry straight from the backend */}
          <div className="md:col-span-3 glass rounded-2xl p-5">
            <div className="font-display text-xs tracking-widest text-white/50 uppercase mb-4">
              Live Device Telemetry
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: 'Heartbeats', value: String(primary?.heartbeat_count ?? 0), color: '#00e5ff' },
                { label: 'Registrations', value: String(primary?.registration_count ?? 0), color: '#a855f7' },
                { label: 'Setup attempts', value: String(primary?.setup_attempts ?? 0), color: '#4d9eff' },
                { label: 'RSSI', value: rssi === null ? '—' : `${rssi} dBm`, color: '#4ade80' },
              ].map(({ label, value, color }) => (
                <div key={label} className="flex flex-col gap-1">
                  <span className="font-mono text-[9px] text-white/30 uppercase tracking-widest">{label}</span>
                  <span className="font-mono text-sm font-medium" style={{ color }}>{value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Lifecycle log */}
        <div className="glass rounded-2xl p-5 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <span className="font-display text-xs tracking-widest text-white/50 uppercase">Lifecycle Log</span>
            <div className="w-2 h-2 rounded-full animate-status-blink"
              style={{ color: online ? '#4ade80' : '#f59e0b', background: online ? '#4ade80' : '#f59e0b' }} />
          </div>
          <div className="flex-1 space-y-1.5 overflow-auto font-mono text-[10px]" style={{ maxHeight: 380 }}>
            {log.length === 0 && (
              <div className="text-white/25 py-2">No events yet.</div>
            )}
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
