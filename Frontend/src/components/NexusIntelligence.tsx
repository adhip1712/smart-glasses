import { useCallback, useEffect, useState } from 'react'
import { apiFetch, readJson } from '../services/api'
import { APP_DIRECTORY, openApp } from '../services/universalApps'
import { getAvailableSpeechVoices, speakText } from '../services/speech'

type Memory = { id: number; content: string; category: string; created_at: string }
type Reminder = { id: number; title: string; notes: string; due_at: string; timezone: string; completed: boolean }
type Workflow = { id: number; name: string; description: string; trigger_type: string; enabled: boolean }
type DeviceHealth = { device_id: string; name: string; model: string; status: string; online: boolean; battery: number | null; temperature: number | null; rssi: number | null; camera_ready: boolean; camera_sensor: string | null; heartbeat_age_seconds: number | null; firmware: string | null }

const panel = 'rounded-2xl border border-white/10 bg-white/[0.035] p-5'
const field = 'w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-400/50'
const action = 'rounded-xl border border-cyan-300/25 bg-cyan-300/10 px-4 py-2 text-xs font-semibold tracking-wide text-cyan-100 transition hover:bg-cyan-300/20 disabled:opacity-40'

function FeatureCard({ number, title, detail, status, onClick }: { number: string; title: string; detail: string; status: string; onClick?: () => void }) {
  return <button type="button" onClick={onClick} className={`${panel} text-left transition hover:border-cyan-300/30 hover:bg-white/[0.055]`}>
    <div className="mb-3 flex items-center justify-between"><span className="font-mono text-[10px] tracking-[0.2em] text-white/35">{number}</span><span className="rounded-full border border-white/10 px-2 py-1 text-[9px] uppercase tracking-wider text-white/55">{status}</span></div>
    <h3 className="text-sm font-semibold text-white">{title}</h3><p className="mt-2 text-xs leading-relaxed text-white/45">{detail}</p>
  </button>
}

export default function NexusIntelligence({ onOpenVision, onOpenDevice }: { onOpenVision: () => void; onOpenDevice: () => void }) {
  const [memories, setMemories] = useState<Memory[]>([])
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [devices, setDevices] = useState<DeviceHealth[]>([])
  const [memoryText, setMemoryText] = useState('')
  const [memoryCategory, setMemoryCategory] = useState('preference')
  const [reminderTitle, setReminderTitle] = useState('')
  const [reminderDue, setReminderDue] = useState('')
  const [reminderNotes, setReminderNotes] = useState('')
  const [workflowName, setWorkflowName] = useState('')
  const [workflowDescription, setWorkflowDescription] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [voiceCount, setVoiceCount] = useState(0)
  const [alertsEnabled, setAlertsEnabled] = useState(typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [m, r, w, d] = await Promise.all([
        apiFetch('/api/assistant/memories'),
        apiFetch('/api/assistant/reminders'),
        apiFetch('/api/assistant/workflows'),
        apiFetch('/api/assistant/device-health'),
      ])
      if ([m, r, w, d].some(response => !response.ok)) throw new Error('Could not load all personal-intelligence data. Check your sign-in and backend connection.')
      const [memoryData, reminderData, workflowData, deviceData] = await Promise.all([
        readJson<{ memories: Memory[] }>(m), readJson<{ reminders: Reminder[] }>(r),
        readJson<{ workflows: Workflow[] }>(w), readJson<{ devices: DeviceHealth[] }>(d),
      ])
      setMemories(memoryData?.memories || [])
      setReminders(reminderData?.reminders || [])
      setWorkflows(workflowData?.workflows || [])
      setDevices(deviceData?.devices || [])
    } catch (cause) {
      setError((cause as Error).message || 'Could not load personal intelligence.')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    void load()
    setVoiceCount(getAvailableSpeechVoices().length)
    const refresh = () => setVoiceCount(getAvailableSpeechVoices().length)
    if ('speechSynthesis' in window) window.speechSynthesis.addEventListener('voiceschanged', refresh)
    return () => { if ('speechSynthesis' in window) window.speechSynthesis.removeEventListener('voiceschanged', refresh) }
  }, [load])

  useEffect(() => {
    let active = true
    const refreshDeviceHealth = async () => {
      try {
        const response = await apiFetch('/api/assistant/device-health')
        if (!response.ok) return
        const data = await readJson<{ devices: DeviceHealth[] }>(response)
        if (active && data?.devices) setDevices(data.devices)
      } catch { /* retain last known telemetry during brief disconnects */ }
    }
    const timer = window.setInterval(() => { void refreshDeviceHealth() }, 10000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  const saveMemory = async () => {
    if (!memoryText.trim() || busy) return
    setBusy(true); setMessage(''); setError('')
    try {
      const response = await apiFetch('/api/assistant/memories', { method: 'POST', body: JSON.stringify({ content: memoryText.trim(), category: memoryCategory }) })
      const data = await readJson<{ memory?: Memory; detail?: string }>(response)
      if (!response.ok || !data?.memory) throw new Error(data?.detail || 'Could not save memory.')
      setMemories(previous => [data.memory!, ...previous]); setMemoryText(''); setMessage('Memory saved to your account.')
    } catch (cause) { setError((cause as Error).message) } finally { setBusy(false) }
  }

  const removeMemory = async (id: number) => {
    const response = await apiFetch('/api/assistant/memories/' + id, { method: 'DELETE' })
    if (!response.ok) { setError('Could not delete that memory.'); return }
    setMemories(previous => previous.filter(item => item.id !== id))
  }

  const enableReminderAlerts = async () => {
    if (!('Notification' in window)) {
      setError('This browser does not support desktop notifications. Keep the Intelligence workspace open to receive spoken reminders.')
      return
    }
    const permission = await Notification.requestPermission()
    setAlertsEnabled(permission === 'granted')
    setMessage(permission === 'granted'
      ? 'Reminder alerts enabled. Alerts are checked while the Intelligence workspace is open.'
      : 'Notifications were not enabled. You can change this in your browser site settings.')
  }

  useEffect(() => {
    if (!alertsEnabled) return
    const checkDueReminders = () => {
      const now = Date.now()
      reminders.forEach(item => {
        if (item.completed) return
        const due = new Date(item.due_at).getTime()
        if (!Number.isFinite(due) || due > now) return
        const key = 'visionary-reminder-alerted-' + item.id + '-' + item.due_at
        try {
          if (localStorage.getItem(key)) return
          localStorage.setItem(key, '1')
        } catch { /* best-effort duplicate prevention */ }
        try {
          new Notification('Visionary Nexus reminder', {
            body: item.title + (item.notes ? '\\n' + item.notes : ''),
            tag: key,
          })
        } catch { /* notification may be blocked by the browser */ }
        speakText('Reminder: ' + item.title)
        setMessage('Reminder due: ' + item.title)
      })
    }
    checkDueReminders()
    const timer = window.setInterval(checkDueReminders, 15000)
    return () => window.clearInterval(timer)
  }, [alertsEnabled, reminders])

  const saveReminder = async () => {
    if (!reminderTitle.trim() || !reminderDue || busy) return
    setBusy(true); setMessage(''); setError('')
    try {
      const due = new Date(reminderDue)
      if (Number.isNaN(due.getTime())) throw new Error('Choose a valid reminder date and time.')
      const response = await apiFetch('/api/assistant/reminders', { method: 'POST', body: JSON.stringify({ title: reminderTitle.trim(), notes: reminderNotes.trim(), due_at: due.toISOString(), timezone_name: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }) })
      const data = await readJson<{ reminder?: Reminder; detail?: string }>(response)
      if (!response.ok || !data?.reminder) throw new Error(data?.detail || 'Could not save reminder.')
      setReminders(previous => [...previous, data.reminder!].sort((a,b) => a.due_at.localeCompare(b.due_at)))
      setReminderTitle(''); setReminderDue(''); setReminderNotes(''); setMessage(alertsEnabled ? 'Reminder saved. Alerts will be checked while this workspace is open.' : 'Reminder saved. Enable browser alerts to be notified while this workspace is open.')
    } catch (cause) { setError((cause as Error).message) } finally { setBusy(false) }
  }

  const completeReminder = async (item: Reminder) => {
    const response = await apiFetch('/api/assistant/reminders/' + item.id, { method: 'PATCH', body: JSON.stringify({ completed: !item.completed }) })
    const data = await readJson<{ reminder?: Reminder }>(response)
    if (response.ok && data?.reminder) setReminders(previous => previous.map(row => row.id === item.id ? data.reminder! : row))
  }

  const deleteReminder = async (item: Reminder) => {
    const response = await apiFetch('/api/assistant/reminders/' + item.id, { method: 'DELETE' })
    if (!response.ok) { setError('Could not delete that reminder.'); return }
    setReminders(previous => previous.filter(row => row.id !== item.id))
    setMessage('Reminder deleted.')
  }

  const saveWorkflow = async () => {
    if (!workflowName.trim() || busy) return
    setBusy(true); setError(''); setMessage('')
    try {
      const response = await apiFetch('/api/assistant/workflows', { method: 'POST', body: JSON.stringify({ name: workflowName.trim(), description: workflowDescription.trim(), trigger_type: 'manual', definition: { steps: [] } }) })
      const data = await readJson<{ workflow?: Workflow; detail?: string }>(response)
      if (!response.ok || !data?.workflow) throw new Error(data?.detail || 'Could not save workflow.')
      setWorkflows(previous => [data.workflow!, ...previous]); setWorkflowName(''); setWorkflowDescription('')
      setMessage('Workflow saved as a draft. It will not run until an execution engine and permissions are configured.')
    } catch (cause) { setError((cause as Error).message) } finally { setBusy(false) }
  }

  const onlineDevices = devices.filter(device => device.online).length
  const dueLabel = (value: string) => {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
  }

  return <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-8">
    <header className="space-y-2"><p className="font-mono text-[10px] tracking-[0.25em] text-cyan-200/55">VISIONARY NEXUS / INTELLIGENCE LAYER</p><h2 className="text-2xl font-semibold tracking-tight text-white">Your assistant, connected.</h2><p className="max-w-2xl text-sm leading-relaxed text-white/45">Six capabilities in one workspace. Private information stays account-scoped, and anything that needs external permissions remains behind an explicit connection step.</p></header>

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <FeatureCard number="01 / CONTROL" title="Universal App Control" status="Available" detail="Open supported apps from natural-language requests. Private account actions still require authorised integrations." onClick={() => document.getElementById('vn-apps')?.scrollIntoView({ behavior: 'smooth' })} />
      <FeatureCard number="02 / MEMORY" title="Long-Term AI Memory" status="Account saved" detail="Save preferences and project context explicitly, then review or delete each memory." onClick={() => document.getElementById('vn-memory')?.scrollIntoView({ behavior: 'smooth' })} />
      <FeatureCard number="03 / VISION" title="Real-Time Vision" status="Existing pipeline" detail="Use the camera and object-detection pipeline to inspect what the glasses can currently see." onClick={onOpenVision} />
      <FeatureCard number="04 / ASSISTANT" title="Personal Assistant" status="Reminders beta" detail="Create and manage personal reminders. Calendar sync and scheduled notifications are separate integration steps." onClick={() => document.getElementById('vn-reminders')?.scrollIntoView({ behavior: 'smooth' })} />
      <FeatureCard number="05 / VOICE" title="Advanced Voice" status={voiceCount ? voiceCount + ' voices' : 'Browser voice'} detail="Use the existing wake-word, dictation and speech services, test speech output, or stop current playback." onClick={() => document.getElementById('vn-voice')?.scrollIntoView({ behavior: 'smooth' })} />
      <FeatureCard number="06 / DEVICE" title="Glasses Intelligence" status={onlineDevices ? 'Online' : 'Check device'} detail="Review connection, battery, camera readiness, signal and heartbeat diagnostics." onClick={onOpenDevice} />
    </div>

    {error && <div role="alert" className="rounded-xl border border-red-400/25 bg-red-400/10 px-4 py-3 text-xs text-red-200">{error}</div>}
    {message && <div role="status" className="rounded-xl border border-emerald-300/20 bg-emerald-300/10 px-4 py-3 text-xs text-emerald-100">{message}</div>}
    {loading && <p className="text-xs text-white/40">Loading your private workspace…</p>}

    <section id="vn-apps" className={panel}>
      <div className="mb-4"><p className="font-mono text-[10px] tracking-widest text-white/35">01 / APP CONTROL</p><h3 className="mt-1 text-base font-semibold text-white">Launch your apps</h3><p className="mt-1 text-xs text-white/40">Uses your existing browser sign-in. Opening an app does not grant Visionary Nexus access to its private data.</p></div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{APP_DIRECTORY.map(app => <button key={app.id} onClick={() => openApp(app)} className="flex items-center justify-between rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-left hover:border-cyan-300/30"><span><b className="block text-xs text-white/85">{app.name}</b><small className="mt-1 block text-[10px] text-white/35">{app.description}</small></span><span className="text-[10px] text-cyan-200">OPEN ↗</span></button>)}</div>
    </section>

    <section id="vn-memory" className={panel}>
      <div className="mb-4"><p className="font-mono text-[10px] tracking-widest text-white/35">02 / MEMORY</p><h3 className="mt-1 text-base font-semibold text-white">What should Nexus remember?</h3><p className="mt-1 text-xs text-white/40">Only save information you intentionally add here. You can delete it at any time.</p></div>
      <div className="grid gap-2 md:grid-cols-[1fr_160px_auto]"><input className={field} value={memoryText} onChange={event => setMemoryText(event.target.value)} maxLength={1200} placeholder="Example: My Visionary Nexus project uses FastAPI and React." /><select className={field} value={memoryCategory} onChange={event => setMemoryCategory(event.target.value)}><option value="preference">Preference</option><option value="project">Project</option><option value="workflow">Workflow</option><option value="other">Other</option></select><button className={action} disabled={!memoryText.trim() || busy} onClick={() => void saveMemory()}>SAVE MEMORY</button></div>
      <div className="mt-4 space-y-2">{memories.length ? memories.map(item => <div key={item.id} className="flex items-start justify-between gap-3 rounded-xl border border-white/8 bg-black/20 p-3"><div className="min-w-0"><span className="text-[9px] uppercase tracking-wider text-cyan-200/60">{item.category}</span><p className="mt-1 break-words text-xs text-white/75">{item.content}</p></div><button className="text-[10px] text-red-200/70 hover:text-red-200" onClick={() => void removeMemory(item.id)}>DELETE</button></div>) : <p className="text-xs text-white/35">No saved memories yet.</p>}</div>
    </section>

    <section id="vn-reminders" className={panel}>
      <div className="mb-4"><p className="font-mono text-[10px] tracking-widest text-white/35">04 / PERSONAL ASSISTANT</p><h3 className="mt-1 text-base font-semibold text-white">Reminders</h3><p className="mt-1 text-xs text-white/40">Enable browser alerts to receive a desktop notification and spoken reminder while this workspace is open.</p></div>
      <button className={action + ' mb-3'} onClick={() => void enableReminderAlerts()}>{alertsEnabled ? 'BROWSER ALERTS ENABLED' : 'ENABLE BROWSER ALERTS'}</button>
      <div className="grid gap-2 md:grid-cols-2"><input className={field} value={reminderTitle} onChange={event => setReminderTitle(event.target.value)} maxLength={180} placeholder="Reminder title" /><input className={field} type="datetime-local" value={reminderDue} onChange={event => setReminderDue(event.target.value)} /></div>
      <div className="mt-2 flex flex-col gap-2 md:flex-row"><input className={field} value={reminderNotes} onChange={event => setReminderNotes(event.target.value)} maxLength={1000} placeholder="Notes (optional)" /><button className={action} disabled={!reminderTitle.trim() || !reminderDue || busy} onClick={() => void saveReminder()}>ADD REMINDER</button></div>
      <div className="mt-4 space-y-2">{reminders.length ? reminders.map(item => <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/8 bg-black/20 p-3"><label className="flex min-w-0 items-start gap-3"><input type="checkbox" checked={item.completed} onChange={() => void completeReminder(item)} className="mt-1 accent-cyan-300" /><span className="min-w-0"><b className={`block text-xs ${item.completed ? 'text-white/35 line-through' : 'text-white/80'}`}>{item.title}</b><small className="mt-1 block text-[10px] text-white/35">{dueLabel(item.due_at)} · {item.timezone}</small>{item.notes && <small className="mt-1 block text-[10px] text-white/30">{item.notes}</small>}</span></label><button type="button" className="shrink-0 text-[10px] text-red-200/70 hover:text-red-200" onClick={() => void deleteReminder(item)}>DELETE</button></div>) : <p className="text-xs text-white/35">No reminders yet.</p>}</div>
    </section>

    <section id="vn-workflows" className={panel}>
      <div className="mb-4"><p className="font-mono text-[10px] tracking-widest text-white/35">WORKFLOW BUILDER / EARLY ACCESS</p><h3 className="mt-1 text-base font-semibold text-white">Describe an automation</h3><p className="mt-1 text-xs text-white/40">Save workflow ideas as drafts. Automatic execution is deliberately disabled until permissions, triggers and a secure runner are implemented.</p></div>
      <div className="grid gap-2 md:grid-cols-[220px_1fr_auto]"><input className={field} value={workflowName} onChange={event => setWorkflowName(event.target.value)} placeholder="Workflow name" maxLength={120} /><input className={field} value={workflowDescription} onChange={event => setWorkflowDescription(event.target.value)} placeholder="When this happens, I want Nexus to…" maxLength={1000} /><button className={action} disabled={!workflowName.trim() || busy} onClick={() => void saveWorkflow()}>SAVE DRAFT</button></div>
      <div className="mt-3 space-y-2">{workflows.map(item => <div key={item.id} className="rounded-xl border border-white/8 bg-black/20 p-3"><div className="flex items-center justify-between"><b className="text-xs text-white/80">{item.name}</b><span className="text-[9px] uppercase tracking-wider text-amber-200/70">Draft · Not running</span></div>{item.description && <p className="mt-1 text-xs text-white/40">{item.description}</p>}</div>)}</div>
    </section>

    <section id="vn-voice" className={panel}>
      <div className="mb-3"><p className="font-mono text-[10px] tracking-widest text-white/35">05 / VOICE</p><h3 className="mt-1 text-base font-semibold text-white">Voice controls</h3><p className="mt-1 text-xs text-white/40">Voice recognition and wake-word controls remain in the existing Voice bar and Settings.</p></div>
      <div className="flex flex-wrap gap-2"><button className={action} onClick={() => speakText('Visionary Nexus voice output is working.')}>TEST VOICE</button><button className="rounded-xl border border-white/15 px-4 py-2 text-xs text-white/70 hover:bg-white/5" onClick={() => { if ('speechSynthesis' in window) window.speechSynthesis.cancel() }}>STOP SPEECH</button><button className="rounded-xl border border-white/15 px-4 py-2 text-xs text-white/70 hover:bg-white/5" onClick={() => setVoiceCount(getAvailableSpeechVoices().length)}>REFRESH VOICES</button></div>
      <p className="mt-3 text-[10px] text-white/35">{voiceCount} browser speech voices detected. Multilingual accuracy depends on the selected recognition and speech providers.</p>
    </section>

    <section className={panel}>
      <div className="mb-4"><p className="font-mono text-[10px] tracking-widest text-white/35">06 / DEVICE INTELLIGENCE</p><h3 className="mt-1 text-base font-semibold text-white">Glasses health</h3><p className="mt-1 text-xs text-white/40">Live diagnostics from registered device heartbeat records.</p></div>
      {devices.length ? <div className="grid gap-2 md:grid-cols-2">{devices.map(device => <div key={device.device_id} className="rounded-xl border border-white/8 bg-black/20 p-3"><div className="flex items-center justify-between"><b className="text-xs text-white/85">{device.name}</b><span className={`text-[10px] ${device.online ? 'text-emerald-200' : 'text-amber-200'}`}>{device.status}</span></div><div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-white/45"><span>Battery: {device.battery == null ? '—' : device.battery + '%'}</span><span>Signal: {device.rssi == null ? '—' : device.rssi + ' dBm'}</span><span>Camera: {device.camera_ready ? 'Ready' : 'Unavailable'}</span><span>Heartbeat: {device.heartbeat_age_seconds == null ? 'Never' : device.heartbeat_age_seconds + 's ago'}</span><span>Firmware: {device.firmware || 'Unknown'}</span></div></div>)}</div> : <p className="text-xs text-white/35">No registered glasses found. Open Device to pair a device.</p>}
      <button className="mt-4 text-xs text-cyan-200 hover:text-cyan-100" onClick={onOpenDevice}>OPEN DEVICE MANAGEMENT ↗</button>
    </section>
    <p className="text-[10px] leading-relaxed text-white/25">Privacy: saved memories, reminders and workflow drafts are scoped to your signed-in account. App access, calendar sync, camera analysis and device controls require the relevant device or provider to be connected.</p>
  </div>
}
