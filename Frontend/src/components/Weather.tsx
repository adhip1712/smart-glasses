import { useCallback, useEffect, useState } from 'react'
import { apiFetch, readJson } from '../services/api'

interface WeatherResult {
  success?: boolean
  location?: string
  region?: string
  country?: string
  temperature_c?: number
  feels_like_c?: number
  humidity?: number
  wind_kph?: number
  condition?: string
  condition_icon?: string
  last_updated?: string
  source?: string
  message?: string
  forecast?: { date?: string; condition?: string; temperature_c?: number; max_c?: number }[]
}

interface RecentLocation {
  kind: string
  query: string
  created_at: string
}

async function getDirectOpenMeteoWeather(city: string): Promise<WeatherResult> {
  const geoUrl = 'https://geocoding-api.open-meteo.com/v1/search?' + new URLSearchParams({
    name: city, count: '1', language: 'en', format: 'json',
  }).toString()
  const geoResponse = await fetch(geoUrl)
  if (!geoResponse.ok) throw new Error('Weather location lookup failed (HTTP ' + geoResponse.status + ').')
  const geoData = await geoResponse.json() as { results?: { name?: string; admin1?: string; country?: string; latitude: number; longitude: number }[] }
  const place = geoData.results?.[0]
  if (!place) throw new Error('Could not find weather for "' + city + '".')

  const forecastUrl = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min',
    timezone: 'auto',
    forecast_days: '7',
  }).toString()
  const weatherResponse = await fetch(forecastUrl)
  if (!weatherResponse.ok) throw new Error('Weather provider failed (HTTP ' + weatherResponse.status + ').')
  const weatherData = await weatherResponse.json() as {
    current?: { temperature_2m?: number; apparent_temperature?: number; relative_humidity_2m?: number; wind_speed_10m?: number; weather_code?: number; time?: string }
    daily?: { time?: string[]; weather_code?: number[]; temperature_2m_max?: number[]; temperature_2m_min?: number[] }
  }
  const current = weatherData.current || {}
  const daily = weatherData.daily || {}
  const describe = (code: number) => ({
    0: 'Clear sky', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Foggy', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle',
    61: 'Light rain', 63: 'Moderate rain', 65: 'Heavy rain', 71: 'Light snow', 73: 'Snow',
    75: 'Heavy snow', 80: 'Rain showers', 81: 'Heavy rain showers', 82: 'Violent rain showers',
    95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Severe thunderstorm',
  } as Record<number, string>)[code] || 'Unknown'
  const dates = daily.time || []
  const highs = daily.temperature_2m_max || []
  const lows = daily.temperature_2m_min || []
  const codes = daily.weather_code || []

  return {
    success: true,
    location: place.name || city,
    region: place.admin1 || '',
    country: place.country || '',
    temperature_c: current.temperature_2m,
    feels_like_c: current.apparent_temperature,
    humidity: current.relative_humidity_2m,
    wind_kph: current.wind_speed_10m,
    condition: describe(current.weather_code ?? -1),
    last_updated: current.time,
    source: 'Open-Meteo direct fallback',
    forecast: dates.map((date, index) => ({
      date,
      condition: describe(codes[index] ?? -1),
      temperature_c: highs[index] != null && lows[index] != null ? (highs[index] + lows[index]) / 2 : undefined,
      max_c: highs[index],
    })),
  }
}

export default function Weather() {
  const [city, setCity] = useState('')
  const [activeCity, setActiveCity] = useState('Bengaluru')
  const [current, setCurrent] = useState<WeatherResult | null>(null)
  const [recent, setRecent] = useState<RecentLocation[]>([])
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  const loadRecent = useCallback(async () => {
    const response = await apiFetch('/api/locations/recent?kind=weather')
    const data = await readJson<{ locations?: RecentLocation[] }>(response)
    setRecent(data?.locations || [])
  }, [])

  const loadWeather = useCallback(async (target: string) => {
    setBusy(true)
    setStatus('')
    try {
      let data: WeatherResult | null = null
      try {
        const response = await apiFetch('/api/weather/' + encodeURIComponent(target))
        const payload = await readJson<WeatherResult>(response)
        if (response.ok && payload?.success !== false) data = payload
      } catch {
        // Browser-side fallback avoids depending on backend outbound weather access.
      }
      if (!data) data = await getDirectOpenMeteoWeather(target)
      if (data && data.success !== false) {
        setCurrent(data)
        setActiveCity(data.location || target)
      } else {
        setCurrent(null)
        setStatus(data?.message || 'Weather for ' + target + ' is unavailable.')
      }
      void loadRecent()
    } catch (error) {
      setCurrent(null)
      setStatus(error instanceof Error ? error.message : 'Weather request failed. Please retry.')
    } finally {
      setBusy(false)
    }
  }, [loadRecent])

  useEffect(() => {
    void (async () => {
      const response = await apiFetch('/api/settings')
      const data = await readJson<{ settings?: { weather_city?: string } }>(response)
      const preferred = data?.settings?.weather_city || 'Bengaluru'
      setCity(preferred)
      await loadWeather(preferred)
      await loadRecent()
    })()
  }, [loadWeather, loadRecent])

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    const target = city.trim()
    if (target) void loadWeather(target)
  }

  const forecast = current?.forecast || []
  const isMock = current?.source === 'mock'

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-widest text-white">WEATHER</h1>
          <div className="font-mono text-xs text-white/30 tracking-widest mt-0.5 uppercase">
            Current conditions · Forecast · Recent locations
          </div>
        </div>
        <div className="glass rounded-full px-4 py-2 flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${current ? (isMock ? 'bg-amber-400' : 'bg-green-400') : 'bg-white/30'}`} />
          <span className="font-mono text-[10px] uppercase tracking-widest text-white/60">
            {current ? (isMock ? 'mock provider' : `provider: ${current.source || 'live'}`) : 'no data'}
          </span>
        </div>
      </div>

      <form onSubmit={submit} className="flex gap-3">
        <input
          value={city}
          onChange={event => setCity(event.target.value)}
          placeholder="Search a city…"
          className="flex-1 bg-black/30 border border-white/15 px-4 py-3 text-white text-sm"
        />
        <button
          type="submit"
          disabled={busy || !city.trim()}
          className="px-5 py-3 rounded-xl font-display text-[11px] tracking-widest border border-cyan-400/40 text-cyan-200 disabled:opacity-40"
        >
          {busy ? 'LOADING' : 'GET WEATHER'}
        </button>
      </form>

      {status && (
        <div className="font-mono text-xs px-4 py-3 border border-amber-400/30 text-amber-200 bg-amber-500/10">{status}</div>
      )}

      {current && (
        <>
          <div className="glass rounded-2xl p-6 flex flex-col md:flex-row md:items-center gap-6">
            <div className="flex items-center gap-4">
              {current.condition_icon && (
                <img src={current.condition_icon.startsWith('//') ? `https:${current.condition_icon}` : current.condition_icon} alt="" className="w-16 h-16" />
              )}
              <div>
                <div className="font-display text-5xl font-black text-cyan-400 text-glow-cyan">
                  {current.temperature_c ?? '--'}°C
                </div>
                <div className="font-mono text-xs text-white/50 mt-1">{current.condition || 'Unknown conditions'}</div>
              </div>
            </div>
            <div className="flex-1 grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { label: 'Location', value: [current.location, current.country].filter(Boolean).join(', ') || '—' },
                { label: 'Feels like', value: `${current.feels_like_c ?? '--'}°C` },
                { label: 'Humidity', value: `${current.humidity ?? '--'}%` },
                { label: 'Wind', value: `${current.wind_kph ?? '--'} km/h` },
              ].map(({ label, value }) => (
                <div key={label} className="text-center p-3 rounded-xl" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="font-mono text-[9px] text-white/30 uppercase">{label}</div>
                  <div className="font-mono text-xs font-bold mt-1 text-white/80">{value}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="glass rounded-2xl p-5">
            <div className="font-display text-xs tracking-widest text-white/50 uppercase mb-4">Forecast</div>
            {forecast.length === 0 ? (
              <p className="font-mono text-xs text-white/40">No forecast rows were returned for this location.</p>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {forecast.map((day, index) => (
                  <div key={`${day.date}-${index}`} className="p-3 rounded-xl text-center" style={{ background: 'rgba(0,229,255,0.04)', border: '1px solid rgba(0,229,255,0.12)' }}>
                    <div className="font-mono text-[10px] text-white/50 uppercase">{day.date}</div>
                    <div className="font-mono text-lg text-cyan-300 mt-1">{day.max_c ?? day.temperature_c ?? '--'}°C</div>
                    <div className="font-mono text-[10px] text-white/50 mt-1">{day.condition}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <div className="glass rounded-2xl p-5">
        <div className="font-display text-xs tracking-widest text-white/50 uppercase mb-4">Recent Locations</div>
        {recent.length === 0 ? (
          <p className="font-mono text-xs text-white/40">No weather lookups yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {recent.map(item => (
              <button
                key={`${item.query}-${item.created_at}`}
                onClick={() => { setCity(item.query); void loadWeather(item.query) }}
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
