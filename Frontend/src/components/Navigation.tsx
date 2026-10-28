import { useCallback, useEffect, useState } from 'react'
import { apiFetch, readJson } from '../services/api'

interface RouteStep {
  instruction: string
  type?: string
  modifier?: string
  distance_meters?: number
}

interface RouteResult {
  success?: boolean
  destination?: string
  distance_km?: number
  duration_minutes?: number
  steps?: RouteStep[]
  source?: string
  message?: string
}

interface RecentLocation {
  kind: string
  query: string
  latitude?: string | null
  longitude?: string | null
  created_at: string
}

const FALLBACK_ORIGIN = { latitude: 12.9716, longitude: 77.5946, label: 'Bengaluru (default)' }

export default function Navigation({ initialDestination = '' }: { initialDestination?: string }) {
  const [destination, setDestination] = useState('')
  const [route, setRoute] = useState<RouteResult | null>(null)
  const [recent, setRecent] = useState<RecentLocation[]>([])
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [origin, setOrigin] = useState<{ latitude: number; longitude: number; label: string }>(FALLBACK_ORIGIN)

  useEffect(() => {
    if (!('geolocation' in navigator)) return
    navigator.geolocation.getCurrentPosition(
      position => setOrigin({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        label: 'Browser GPS',
      }),
      () => {
        // Permission denied or unavailable: keep the explicit default origin.
      },
      { timeout: 5000 },
    )
  }, [])

  const loadRecent = useCallback(async () => {
    const response = await apiFetch('/api/locations/recent?kind=navigation')
    const data = await readJson<{ locations?: RecentLocation[] }>(response)
    setRecent(data?.locations || [])
  }, [])

  useEffect(() => {
    void loadRecent()
  }, [loadRecent])

  const calculateRoute = async (target: string) => {
    if (!target.trim()) return
    setBusy(true)
    setStatus('')
    try {
      const response = await apiFetch('/api/navigation/route', {
        method: 'POST',
        body: JSON.stringify({
          destination: target.trim(),
          latitude: origin.latitude,
          longitude: origin.longitude,
        }),
      })
      const data = await readJson<RouteResult>(response)
      if (data && data.success) {
        setRoute(data)
      } else {
        setRoute(null)
        setStatus(data?.message || `No route was found for "${target}".`)
      }
      void loadRecent()
    } catch (error) {
      setStatus(`Navigation failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const target = initialDestination.trim()
    if (!target) return
    setDestination(target)
    void calculateRoute(target)
  }, [initialDestination])

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    void calculateRoute(destination)
  }

  const isMock = route?.source === 'mock'

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-widest text-white">NAVIGATION</h1>
          <div className="font-mono text-xs text-white/30 tracking-widest mt-0.5 uppercase">
            OpenStreetMap geocoding · OSRM routing · Turn-by-turn
          </div>
        </div>
        <div className="glass rounded-full px-4 py-2">
          <span className="font-mono text-[10px] uppercase tracking-widest text-white/60">
            Origin: {origin.label}
          </span>
        </div>
      </div>

      <form onSubmit={submit} className="flex gap-3">
        <input
          value={destination}
          onChange={event => setDestination(event.target.value)}
          placeholder="Where do you want to go?"
          className="flex-1 bg-black/30 border border-white/15 px-4 py-3 text-white text-sm"
        />
        <button
          type="submit"
          disabled={busy || !destination.trim()}
          className="px-5 py-3 rounded-xl font-display text-[11px] tracking-widest border border-cyan-400/40 text-cyan-200 disabled:opacity-40"
        >
          {busy ? 'ROUTING' : 'CALCULATE ROUTE'}
        </button>
      </form>

      {status && (
        <div className="font-mono text-xs px-4 py-3 border border-amber-400/30 text-amber-200 bg-amber-500/10">{status}</div>
      )}

      {route && (
        <>
          <div className="glass rounded-2xl p-6">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <div className="font-display text-xs tracking-widest text-white/50 uppercase">Current Route</div>
                <div className="text-white text-sm mt-1 max-w-xl">{route.destination}</div>
              </div>
              <div className="flex gap-3">
                <div className="text-center p-3 rounded-xl" style={{ background: 'rgba(0,229,255,0.05)', border: '1px solid rgba(0,229,255,0.15)' }}>
                  <div className="font-mono text-[9px] text-white/30 uppercase">Distance</div>
                  <div className="font-mono text-lg font-bold text-cyan-300">{route.distance_km ?? '--'} km</div>
                </div>
                <div className="text-center p-3 rounded-xl" style={{ background: 'rgba(168,85,247,0.05)', border: '1px solid rgba(168,85,247,0.15)' }}>
                  <div className="font-mono text-[9px] text-white/30 uppercase">Duration</div>
                  <div className="font-mono text-lg font-bold text-purple-300">{route.duration_minutes ?? '--'} min</div>
                </div>
              </div>
            </div>
            <div className="mt-3 font-mono text-[10px] text-white/40 uppercase tracking-widest">
              Source: {isMock ? 'mock provider (simulated route)' : route.source || 'live'} · GPS origin {origin.label}
            </div>
          </div>

          <div className="glass rounded-2xl p-5">
            <div className="font-display text-xs tracking-widest text-white/50 uppercase mb-4">
              Turn-by-turn ({(route.steps || []).length})
            </div>
            {(route.steps || []).length === 0 ? (
              <p className="font-mono text-xs text-white/40">No turn instructions were returned for this route.</p>
            ) : (
              <ol className="space-y-2">
                {(route.steps || []).map((step, index) => (
                  <li key={index} className="flex items-start gap-3 p-2 rounded-lg hover:bg-white/5">
                    <span className="font-mono text-[10px] text-cyan-400 w-6 flex-shrink-0">{String(index + 1).padStart(2, '0')}</span>
                    <div className="flex-1">
                      <div className="text-xs text-white/85">{step.instruction}</div>
                      <div className="font-mono text-[10px] text-white/35">
                        {step.modifier ? `${step.modifier} · ` : ''}{step.type || 'continue'}
                        {step.distance_meters ? ` · ${step.distance_meters} m` : ''}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </>
      )}

      <div className="glass rounded-2xl p-5">
        <div className="font-display text-xs tracking-widest text-white/50 uppercase mb-4">Recent Destinations</div>
        {recent.length === 0 ? (
          <p className="font-mono text-xs text-white/40">No destinations calculated yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {recent.map(item => (
              <button
                key={`${item.query}-${item.created_at}`}
                onClick={() => { setDestination(item.query); void calculateRoute(item.query) }}
                className="px-3 py-1.5 rounded-full border border-white/15 bg-white/5 text-xs text-white/70 hover:border-cyan-400/40 hover:text-cyan-200 transition-all"
              >
                {item.query}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
