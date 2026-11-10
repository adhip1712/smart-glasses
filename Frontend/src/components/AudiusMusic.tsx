import { useEffect, useRef, useState } from 'react'
import { apiFetch, readJson } from '../services/api'
import { speakText } from '../services/speech'

type AudiusTrack = {
  id: string
  name: string
  artist: string
  image?: string
  url?: string
  stream_url: string
  duration?: number
  genre?: string
  provider: 'audius'
  matched?: boolean
  match_score?: number
}

type SavedPlaylist = { name: string; tracks: AudiusTrack[] }
type StoredPlaylist = { name: string; tracks: any[] }

function formatTime(seconds = 0) {
  const safe = Math.max(0, Math.floor(seconds || 0))
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`
}

export default function AudiusMusic() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<AudiusTrack[]>([])
  const [current, setCurrent] = useState<AudiusTrack | null>(null)
  const [queue, setQueue] = useState<AudiusTrack[]>([])
  const [message, setMessage] = useState('Search the Audius catalogue and stream tracks in Visionary Nexus.')
  const [busy, setBusy] = useState(false)
  const [playlistName, setPlaylistName] = useState('')
  const [playlists, setPlaylists] = useState<SavedPlaylist[]>([])
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    let cancelled = false
    void apiFetch('/api/music/playlists')
      .then(response => readJson<{ playlists?: StoredPlaylist[] }>(response))
      .then(data => {
        if (!cancelled) {
          setPlaylists((data?.playlists || [])
            .map(item => ({ name: item.name, tracks: (item.tracks || []).filter(track => track?.provider === 'audius' && track?.stream_url) }))
            .filter(item => item.tracks.length))
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = 0.75
  }, [current])

  const search = async (term = query, autoplay = false) => {
    const clean = term.trim()
    if (!clean) return
    setQuery(clean)
    setBusy(true)
    setMessage('Searching Audius…')
    try {
      const response = await apiFetch(`/api/music/audius-search?q=${encodeURIComponent(clean)}&limit=18`)
      const data = await readJson<{ success?: boolean; tracks?: AudiusTrack[]; message?: string }>(response)
      if (!response.ok) throw new Error(data?.message || `Audius search failed (HTTP ${response.status}).`)
      if (!data?.success) throw new Error(data?.message || 'Audius search failed.')
      const found = (data.tracks || []).filter(track => track?.provider === 'audius' && track.id && track.stream_url)
      const matching = found.filter(track => track.matched)
      setResults(matching.length ? matching : found)
      if (autoplay && matching[0]) {
        setQueue(matching.slice(1))
        setCurrent(matching[0])
        setMessage(`SoundCloud had no close match. Audius found ${matching[0].name} by ${matching[0].artist}.`)
      } else if (autoplay) {
        setQueue([])
        setCurrent(null)
        setMessage('No sufficiently close match was found on SoundCloud or Audius. I did not autoplay an unrelated track.')
      } else {
        setMessage(data.message || `Found ${found.length} tracks.`)
      }
    } catch (error) {
      setResults([])
      setMessage(error instanceof Error ? error.message : 'Audius search failed.')
    } finally {
      setBusy(false)
    }
  }

  const playTrack = (track: AudiusTrack, sequence: AudiusTrack[] = results) => {
    setCurrent(track)
    const index = sequence.findIndex(item => item.id === track.id)
    setQueue(index >= 0 ? sequence.slice(index + 1) : [])
    setMessage(`Now playing ${track.name} — ${track.artist}`)
    speakText(`Playing ${track.name} by ${track.artist}`)
  }

  const playNext = () => {
    if (!queue.length) {
      setCurrent(null)
      setMessage('Queue finished.')
      return
    }
    const [next, ...remaining] = queue
    setQueue(remaining)
    setCurrent(next)
    setMessage(`Now playing ${next.name} — ${next.artist}`)
  }

  const savePlaylist = async () => {
    const name = playlistName.trim()
    if (!name || !results.length) {
      setMessage('Enter a playlist name and search for tracks first.')
      return
    }
    const next = [...playlists.filter(item => item.name.toLowerCase() !== name.toLowerCase()), { name, tracks: results }]
    setPlaylists(next)
    setPlaylistName('')
    try {
      const response = await apiFetch('/api/music/playlists')
      const data = await readJson<{ playlists?: StoredPlaylist[] }>(response)
      const existing = data?.playlists || []
      const merged = [
        ...existing.filter(item => !playlists.some(saved => saved.name.toLowerCase() === item.name.toLowerCase()) && item.name.toLowerCase() !== name.toLowerCase()),
        ...next,
      ]
      const saved = await apiFetch('/api/music/playlists', {
        method: 'PUT',
        body: JSON.stringify({ playlists: merged }),
      })
      if (!saved.ok) throw new Error('Playlist database save failed.')
      setMessage(`Saved “${name}” to your Visionary Nexus library.`)
    } catch {
      setMessage('Playlist is available in this session, but database sync failed.')
    }
  }

  const loadPlaylist = (playlist: SavedPlaylist) => {
    setResults(playlist.tracks)
    setQueue([])
    setCurrent(null)
    setMessage(`Loaded playlist “${playlist.name}”. Select a track to play.`)
  }

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string; activeTab?: string; action?: string; query?: string }>).detail
      if (detail?.activeTab !== 'music') return
      const text = (detail.text || '').toLowerCase().replace(/[.!?,]+/g, ' ').replace(/\s+/g, ' ').trim()
      const action = (detail.action || '').toLowerCase()
      if (action === 'pause' || /^(pause|stop)( music)?$/.test(text)) {
        audioRef.current?.pause()
        setMessage('Audius playback paused.')
        return
      }
      if (action === 'resume' || /^(resume|continue)( music)?$/.test(text)) {
        void audioRef.current?.play().catch(() => setMessage('Press Play in the audio player to resume.'))
        return
      }
      if (action === 'next' || /^(next|skip)( song| track)?$/.test(text)) {
        playNext()
        return
      }
      const target = (detail.query || '').trim() || text.replace(/^(please )?(play|listen to|put on|start playing|i want to listen to)\s+/, '').replace(/\b(my|the|playlist|music|song)\b/g, '').trim()
      if (!target || /^(music|something|audius)$/.test(target)) return
      const saved = playlists.find(item => item.name.toLowerCase() === target.toLowerCase() || item.name.toLowerCase().includes(target.toLowerCase()))
      if (saved?.tracks.length) {
        setResults(saved.tracks)
        setQueue(saved.tracks.slice(1))
        setCurrent(saved.tracks[0])
        setMessage(`Playing your Audius playlist “${saved.name}”.`)
        return
      }
      void search(target, action !== 'search' && action !== 'open')
    }
    window.addEventListener('visionary:voice-command', handler)
    return () => window.removeEventListener('visionary:voice-command', handler)
  }, [queue, playlists, results])

  return (
    <div className="min-h-screen bg-[#080808] p-4 text-white md:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-300">Alternative music catalogue</p>
            <h1 className="mt-2 text-3xl font-bold">Audius</h1>
            <p className="mt-1 text-sm text-white/55">Discover independent music and stream available tracks.</p>
          </div>
          <span className="rounded-full border border-cyan-300/30 px-3 py-2 text-xs text-cyan-200">AUDIO STREAM READY</span>
        </header>

        <form className="flex flex-col gap-2 sm:flex-row" onSubmit={event => { event.preventDefault(); void search() }}>
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search songs, artists or genres…" className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 outline-none focus:border-cyan-300/60" />
          <button type="submit" disabled={busy || !query.trim()} className="rounded-2xl bg-cyan-300 px-6 py-3 font-semibold text-black disabled:opacity-50">{busy ? 'Searching…' : 'Search Audius'}</button>
        </form>

        <p className="text-sm text-white/60" role="status">{message}</p>

        {current && (
          <section className="rounded-3xl border border-cyan-300/20 bg-white/[0.04] p-4 md:p-5">
            <div className="flex items-center gap-4">
              {current.image ? <img src={current.image} alt="" className="h-16 w-16 rounded-xl object-cover" /> : <div className="h-16 w-16 rounded-xl bg-white/10" />}
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{current.name}</p>
                <p className="truncate text-sm text-white/55">{current.artist}</p>
                {current.genre && <p className="mt-1 text-xs text-cyan-200/70">{current.genre}</p>}
              </div>
              {current.url && <a href={current.url} target="_blank" rel="noreferrer" className="text-xs text-cyan-200 underline">Audius page</a>}
            </div>
            <audio
              ref={audioRef}
              key={current.id}
              src={current.stream_url}
              controls
              autoPlay
              onEnded={playNext}
              onError={() => setMessage('This track could not be streamed. Try another result.')}
              className="mt-4 w-full"
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-white/50">
              <span>{queue.length} track{queue.length === 1 ? '' : 's'} remaining in queue</span>
              <button onClick={playNext} disabled={!queue.length} className="rounded-full border border-white/15 px-4 py-2 text-white disabled:opacity-40">Next track</button>
            </div>
          </section>
        )}

        <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Search results</h2>
              <span className="text-xs text-white/40">{results.length} tracks</span>
            </div>
            {results.map((track, index) => (
              <div key={track.id} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.035] p-3">
                {track.image ? <img src={track.image} alt="" className="h-12 w-12 rounded-lg object-cover" /> : <div className="h-12 w-12 rounded-lg bg-white/10" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{track.name}</p>
                  <p className="truncate text-xs text-white/50">{track.artist} · {formatTime(track.duration)}</p>
                </div>
                <button onClick={() => playTrack(track)} className="rounded-full bg-cyan-300 px-4 py-2 text-xs font-bold text-black">Play</button>
                {track.url && <a href={track.url} target="_blank" rel="noreferrer" aria-label={`Open ${track.name} on Audius`} className="px-2 text-xs text-white/50">Open</a>}
              </div>
            ))}
            {!results.length && <div className="rounded-2xl border border-dashed border-white/10 p-8 text-center text-sm text-white/40">Search Audius to see available tracks here.</div>}
          </section>

          <aside className="space-y-4">
            <section className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
              <h2 className="font-semibold">Save search as playlist</h2>
              <input value={playlistName} onChange={event => setPlaylistName(event.target.value)} placeholder="Playlist name" className="mt-3 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none" />
              <button onClick={() => void savePlaylist()} disabled={!results.length || !playlistName.trim()} className="mt-2 w-full rounded-xl bg-white px-3 py-2 text-sm font-semibold text-black disabled:opacity-40">Save playlist</button>
            </section>
            <section className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
              <h2 className="font-semibold">Audius playlists</h2>
              <div className="mt-3 space-y-2">
                {playlists.map(playlist => (
                  <button key={playlist.name} onClick={() => loadPlaylist(playlist)} className="flex w-full items-center justify-between rounded-xl bg-black/25 px-3 py-3 text-left text-sm hover:bg-white/10">
                    <span className="truncate">{playlist.name}</span>
                    <span className="ml-2 text-xs text-white/40">{playlist.tracks.length}</span>
                  </button>
                ))}
                {!playlists.length && <p className="text-xs text-white/40">Saved Audius playlists will appear here.</p>}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  )
}
