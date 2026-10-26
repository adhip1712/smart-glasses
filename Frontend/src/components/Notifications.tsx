import { useCallback, useEffect, useState } from 'react'
import { apiFetch, readJson } from '../services/api'

interface NotificationItem {
  id: number
  title: string
  body: string
  kind: string
  is_read: boolean
  created_at: string
}

const kindColors: Record<string, string> = {
  device: '#00e5ff',
  system: '#4d9eff',
  ai: '#a855f7',
  alert: '#ef4444',
}

export default function Notifications() {
  const [items, setItems] = useState<NotificationItem[]>([])
  const [unread, setUnread] = useState(0)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const response = await apiFetch('/api/notifications')
      const data = await readJson<{ notifications?: NotificationItem[]; unread?: number }>(response)
      setItems(data?.notifications || [])
      setUnread(data?.unread || 0)
      setStatus('')
    } catch (error) {
      setStatus(`Could not load notifications: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
  }, [])

  useEffect(() => {
    void load()
    const interval = window.setInterval(() => void load(), 10000)
    return () => window.clearInterval(interval)
  }, [load])

  const markRead = async (id: number) => {
    setBusy(true)
    await apiFetch(`/api/notifications/${id}/read`, { method: 'POST', body: JSON.stringify({}) })
    await load()
    setBusy(false)
  }

  const markAllRead = async () => {
    setBusy(true)
    await apiFetch('/api/notifications/read-all', { method: 'POST', body: JSON.stringify({}) })
    await load()
    setBusy(false)
  }

  const remove = async (id: number) => {
    setBusy(true)
    await apiFetch(`/api/notifications/${id}`, { method: 'DELETE' })
    await load()
    setBusy(false)
  }

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-widest text-white">NOTIFICATIONS</h1>
          <div className="font-mono text-xs text-white/30 tracking-widest mt-0.5 uppercase">
            Device events · System messages · Assistant activity
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-white/50">{unread} unread</span>
          <button
            onClick={() => void load()}
            className="px-4 py-2 rounded-xl font-display text-[10px] tracking-widest border border-white/15 text-white/70 hover:border-cyan-400/40 transition-all"
          >
            REFRESH
          </button>
          <button
            onClick={() => void markAllRead()}
            disabled={busy || unread === 0}
            className="px-4 py-2 rounded-xl font-display text-[10px] tracking-widest border border-cyan-400/40 text-cyan-200 disabled:opacity-40 transition-all"
          >
            MARK ALL READ
          </button>
        </div>
      </div>

      {status && (
        <div className="font-mono text-xs px-4 py-3 border border-amber-400/30 text-amber-200 bg-amber-500/10">{status}</div>
      )}

      {items.length === 0 ? (
        <div className="glass rounded-2xl p-8 text-center">
          <p className="font-mono text-xs text-white/45">No notifications yet.</p>
          <p className="font-mono text-[10px] text-white/30 mt-2">
            Device pairing, camera check-ins and assistant events appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map(item => {
            const color = kindColors[item.kind] || '#4d9eff'
            return (
              <article
                key={item.id}
                className="glass rounded-xl p-4 flex items-start gap-4"
                style={{ border: item.is_read ? '1px solid rgba(255,255,255,0.06)' : `1px solid ${color}40` }}
              >
                <span
                  className="w-2 h-2 rounded-full mt-2 flex-shrink-0"
                  style={{ backgroundColor: color, boxShadow: item.is_read ? 'none' : `0 0 8px ${color}` }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className={`text-sm ${item.is_read ? 'text-white/70' : 'text-white font-medium'}`}>{item.title}</h2>
                    <span className="font-mono text-[9px] uppercase tracking-widest px-2 py-0.5 rounded-full" style={{ color, border: `1px solid ${color}50` }}>
                      {item.kind}
                    </span>
                  </div>
                  {item.body && <p className="font-mono text-[11px] text-white/50 mt-1">{item.body}</p>}
                  <div className="font-mono text-[10px] text-white/30 mt-2">
                    {item.created_at ? new Date(item.created_at).toLocaleString() : ''}
                  </div>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  {!item.is_read && (
                    <button
                      onClick={() => void markRead(item.id)}
                      disabled={busy}
                      className="px-3 py-1.5 rounded-lg border border-cyan-400/35 text-cyan-200 text-[10px] disabled:opacity-40"
                    >
                      MARK READ
                    </button>
                  )}
                  <button
                    onClick={() => void remove(item.id)}
                    disabled={busy}
                    className="px-3 py-1.5 rounded-lg border border-red-400/30 text-red-200 text-[10px] disabled:opacity-40"
                  >
                    DELETE
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
