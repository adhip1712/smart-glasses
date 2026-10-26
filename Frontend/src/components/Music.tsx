import { useEffect, useRef, useState } from 'react'
import { apiFetch, readJson } from '../services/api'

interface Track {
  id: string
  name: string
  artist?: string
  album?: string
  duration?: number
  image?: string
  audio?: string
  url?: string
  genre?: string
}

interface ProviderConfig {
  success: boolean
  provider: string
  configured: boolean
  requiresApiKey: boolean
  message: string
}

const emptyConfig: ProviderConfig = {
  success: false,
  provider: 'none',
  configured: false,
  requiresApiKey: true,
  message: 'Checking music provider…',
}

function formatDuration(ms?: number): string {
  if (!ms) return ''
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export default function Music() {
  const [config, setConfig] = useState<ProviderConfig>(emptyConfig)
  const [query, setQuery] = useState('')
  const [tracks, setTracks] = useState<Track[]>([])
  const [queue, setQueue] = useState<Track[]>([])
  const [current, setCurrent] = useState<Track | null>(null)
  const [playing, setPlaying] = useState(false)
  const [volume, setVolume] = useState(70)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const loadConfig = async () => {
    const response = await apiFetch('/api/music/config')
    const data = await readJson<ProviderConfig>(response)
    if (data) setConfig(data)
  }

  useEffect(() => {
    void loadConfig()
    return () => {
      audioRef.current?.pause()
      audioRef.current = null
    }
  }, [])

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume / 100
  }, [volume])

  const playTrack = async (track: Track) => {
    setCurrent(track)
    if (track.audio) {
      if (!audioRef.current) {
        audioRef.current = new Audio()
        audioRef.current.addEventListener('ended', () => setPlaying(false))
      }
      audioRef.current.src = track.audio
      audioRef.current.volume = volume / 100
      try {
        await audioRef.current.play()
        setPlaying(true)
      } catch (error) {
        setPlaying(false)
        setMessage(`Preview playback was blocked: ${error instanceof Error ? error.message : 'unknown error'}`)
      }
    }
    const response = await apiFetch('/api/music/play', {
      method: 'POST',
      body: JSON.stringify({ query: track.name }),
    })
    const data = await readJson<{ success?: boolean; message?: string }>(response)
    if (data?.message) setMessage(data.message)
  }

  const searchTracks = async (event: React.FormEvent) => {
    event.preventDefault()
    const term = query.trim()
    if (!term) return
    setBusy(true)
    setMessage('')
    try {
      const response = await apiFetch('/api/music/search', {
        method: 'POST',
        body: JSON.stringify({ query: term }),
      })
      const data = await readJson<{ success?: boolean; tracks?: Track[]; message?: string }>(response)
      const found = data?.tracks || []
      setTracks(found)
      setMessage(data?.message || (found.length ? `Found ${found.length} track(s).` : 'No matches found.'))
    } catch (error) {
      setMessage(`Music search failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    } finally {
      setBusy(false)
    }
  }

  const control = async (action: 'pause' | 'resume' | 'next' | 'previous') => {
    if (action === 'pause') {
      audioRef.current?.pause()
      setPlaying(false)
    }
    if (action === 'resume') {
      void audioRef.current?.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
    }
    if (action === 'next' && queue.length > 0) {
      const [nextTrack, ...rest] = queue
      setQueue(rest)
      void playTrack(nextTrack)
      return
    }
    if (action === 'previous' && current) {
      void playTrack(current)
      return
    }
    const response = await apiFetch(`/api/music/${action}`, { method: 'POST', body: JSON.stringify({}) })
    const data = await readJson<{ success?: boolean; message?: string }>(response)
    if (data?.message) setMessage(data.message)
  }

  const addToQueue = (track: Track) => {
    setQueue(previous => (previous.some(item => item.id === track.id) ? previous : [...previous, track]))
  }

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-widest text-white">MUSIC</h1>
          <div className="font-mono text-xs text-white/30 tracking-widest mt-0.5 uppercase">
            Provider abstraction · Apple Music · Navidrome · YouTube
          </div>
        </div>
        <div className="glass rounded-full px-4 py-2 flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${config.configured ? 'bg-green-400' : 'bg-amber-400'}`} />
          <span className="font-mono text-[10px] uppercase tracking-widest text-white/60">
            {config.provider} · {config.configured ? 'configured' : 'not configured'}
          </span>
        </div>
      </div>

      {!config.configured && (
        <div className="font-mono text-xs px-4 py-3 border border-amber-400/30 text-amber-200 bg-amber-500/10">
          {config.message}
        </div>
      )}

      {message && (
        <div className="font-mono text-xs px-4 py-3 border border-cyan-400/30 text-cyan-100 bg-cyan-500/10">{message}</div>
      )}

      <form onSubmit={event => void searchTracks(event)} className="flex gap-3">
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search for a song or artist…"
          className="flex-1 bg-black/30 border border-white/15 px-4 py-3 text-white text-sm"
        />
        <button
          type="submit"
          disabled={busy || !query.trim()}
          className="px-5 py-3 rounded-xl font-display text-[11px] tracking-widest border border-cyan-400/40 text-cyan-200 disabled:opacity-40"
        >
          {busy ? 'SEARCHING' : 'SEARCH'}
        </button>
      </form>

      {/* Now playing */}
      <div className="glass rounded-2xl p-5">
        <div className="font-display text-xs tracking-widest text-white/50 uppercase mb-4">Now Playing</div>
        {current ? (
          <div className="flex items-center gap-4">
            {current.image && <img src={current.image} alt="" className="w-16 h-16 rounded-lg object-cover border border-white/10" />}
            <div className="flex-1 min-w-0">
              <div className="text-sm text-white font-medium truncate">{current.name}</div>
              <div className="text-xs text-white/60 truncate">{current.artist || 'Unknown artist'}{current.album ? ` · ${current.album}` : ''}</div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => void control('previous')} className="px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-xs">Prev</button>
              <button onClick={() => void control(playing ? 'pause' : 'resume')} className="px-3 py-2 rounded-lg border border-cyan-400/40 bg-cyan-400/10 text-xs text-cyan-200">
                {playing ? 'Pause' : 'Resume'}
              </button>
              <button onClick={() => void control('next')} className="px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-xs">Next</button>
            </div>
          </div>
        ) : (
          <p className="font-mono text-xs text-white/40">Nothing is playing yet. Search for a track to start.</p>
        )}
        <div className="mt-4 flex items-center gap-3">
          <span className="font-mono text-[10px] text-white/40 uppercase tracking-widest w-16">Volume</span>
          <input type="range" min={0} max={100} value={volume} onChange={event => setVolume(Number(event.target.value))} className="flex-1" style={{ accentColor: '#00e5ff' }} />
          <span className="font-mono text-xs text-cyan-400 w-10 text-right">{volume}%</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Search results */}
        <div className="glass rounded-2xl p-5">
          <div className="font-display text-xs tracking-widest text-white/50 uppercase mb-4">Search Results ({tracks.length})</div>
          {tracks.length === 0 ? (
            <p className="font-mono text-xs text-white/40">No results yet. Try “Bohemian Rhapsody” or any artist.</p>
          ) : (
            <div className="space-y-2">
              {tracks.map(track => (
                <div key={track.id} className="flex items-center gap-3 p-2 rounded-xl hover:bg-white/5 transition-all">
                  <button onClick={() => void playTrack(track)} className="w-9 h-9 rounded-lg bg-cyan-400/10 border border-cyan-400/30 text-cyan-300 text-xs flex-shrink-0">▶</button>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-white truncate">{track.name}</div>
                    <div className="text-[10px] text-white/50 truncate">{track.artist}{track.genre ? ` · ${track.genre}` : ''}</div>
                  </div>
                  <span className="font-mono text-[10px] text-white/30">{formatDuration(track.duration)}</span>
                  <button onClick={() => addToQueue(track)} className="px-2 py-1 rounded border border-white/10 text-[10px] text-white/60">Queue</button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Queue */}
        <div className="glass rounded-2xl p-5">
          <div className="font-display text-xs tracking-widest text-white/50 uppercase mb-4">Queue ({queue.length})</div>
          {queue.length === 0 ? (
            <p className="font-mono text-xs text-white/40">The queue is empty. Add tracks from the search results.</p>
          ) : (
            <div className="space-y-2">
              {queue.map((track, index) => (
                <div key={`${track.id}-${index}`} className="flex items-center gap-3 p-2 rounded-xl hover:bg-white/5 transition-all">
                  <span className="font-mono text-[10px] text-white/30 w-5">{index + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-white truncate">{track.name}</div>
                    <div className="text-[10px] text-white/50 truncate">{track.artist}</div>
                  </div>
                  <button onClick={() => setQueue(previous => previous.filter((_, i) => i !== index))} className="px-2 py-1 rounded border border-white/10 text-[10px] text-white/60">Remove</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
