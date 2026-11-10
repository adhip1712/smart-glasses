import { useEffect, useRef, useState } from 'react'
import { apiFetch, readJson } from '../services/api'
import { speakText } from '../services/speech'

type Track = {
  id: string
  name: string
  artist: string
  album?: string
  duration?: number
  image?: string
  audio: string
  url?: string
  provider?: string
  license?: string
}

type SavedPlaylist = { name: string; tracks: Track[] }

function formatDuration(ms?: number) {
  if (!ms) return '--:--'
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export default function JamendoMusic() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Track[]>([])
  const [current, setCurrent] = useState<Track | null>(null)
  const [playing, setPlaying] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('Search Jamendo’s free catalogue and play tracks inside Visionary Nexus.')
  const [playlists, setPlaylists] = useState<SavedPlaylist[]>([])
  const [playlistName, setPlaylistName] = useState('')
  const [queue, setQueue] = useState<Track[]>([])
  const [volume, setVolume] = useState(75)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const queueRef = useRef<Track[]>([])
  const resultsRef = useRef<Track[]>([])

  useEffect(() => { queueRef.current = queue }, [queue])
  useEffect(() => { resultsRef.current = results }, [results])

  useEffect(() => {
    let cancelled = false
    void apiFetch('/api/music/playlists')
      .then(response => readJson<{ playlists?: SavedPlaylist[] }>(response))
      .then(data => { if (!cancelled && Array.isArray(data?.playlists)) setPlaylists(data.playlists) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const audio = new Audio()
    audio.preload = 'auto'
    audio.volume = volume / 100
    audio.addEventListener('ended', () => {
      const next = queueRef.current[0]
      if (next) {
        queueRef.current = queueRef.current.slice(1)
        setQueue(queueRef.current)
        setCurrent(next)
        audio.src = next.audio
        void audio.play().then(() => setPlaying(true)).catch(() => {
          setPlaying(false)
          setMessage('Tap Play to continue playback; the browser blocked automatic audio start.')
        })
      } else {
        setPlaying(false)
        setMessage('Queue finished.')
      }
    })
    audio.addEventListener('error', () => {
      setPlaying(false)
      setMessage('This Jamendo track could not be streamed. Try another result.')
    })
    audioRef.current = audio
    return () => {
      audio.pause()
      audio.src = ''
      audioRef.current = null
    }
  }, [])

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume / 100
  }, [volume])

  const playTrack = async (track: Track, sequence?: Track[]) => {
    if (!track?.audio) {
      setMessage('This result does not have a playable full-track stream.')
      return
    }
    const audio = audioRef.current
    if (!audio) return
    setCurrent(track)
    if (sequence) {
      const index = sequence.findIndex(item => item.id === track.id)
      const nextQueue = index >= 0 ? sequence.slice(index + 1) : []
      queueRef.current = nextQueue
      setQueue(nextQueue)
    }
    audio.src = track.audio
    audio.currentTime = 0
    try {
      await audio.play()
      setPlaying(true)
      setMessage(`Playing ${track.name} by ${track.artist}.`)
    } catch {
      setPlaying(false)
      setMessage('Press Play once to allow audio playback in this browser.')
    }
  }

  const search = async (term: string, autoplay = false) => {
    const clean = term.trim()
    if (!clean) return
    setQuery(clean)
    setBusy(true)
    setMessage('Searching Jamendo…')
    try {
      const response = await apiFetch('/api/music/search', {
        method: 'POST',
        body: JSON.stringify({ query: clean }),
      })
      const data = await readJson<{ success?: boolean; tracks?: Track[]; notice?: string; message?: string }>(response)
      const found = (data?.tracks || []).filter(track => track.provider === 'jamendo' && Boolean(track.audio))
      setResults(found)
      if (!found.length) {
        setMessage(data?.message || 'No playable Jamendo tracks found. Try another title, artist or genre.')
      } else if (autoplay) {
        await playTrack(found[0], found)
      } else {
        setMessage(`Found ${found.length} playable Jamendo tracks.`)
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Jamendo search failed.')
    } finally {
      setBusy(false)
    }
  }

  const savePlaylist = async () => {
    const name = playlistName.trim()
    if (!name || !results.length) return
    const next = [...playlists.filter(item => item.name.toLowerCase() !== name.toLowerCase()), { name, tracks: results }]
    setPlaylists(next)
    setPlaylistName('')
    try {
      const response = await apiFetch('/api/music/playlists', {
        method: 'PUT',
        body: JSON.stringify({ playlists: next }),
      })
      if (!response.ok) throw new Error('Playlist database save failed.')
      setMessage(`Saved playlist “${name}”.`)
    } catch {
      setMessage('Playlist is saved in this session, but database sync failed.')
    }
  }

  const playPlaylist = (playlist: SavedPlaylist) => {
    if (!playlist.tracks.length) return
    void playTrack(playlist.tracks[0], playlist.tracks)
    speakText(`Playing your playlist ${playlist.name}.`)
  }

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail || {}
      const action = String(detail.action || '').toLowerCase()
      const spoken = String(detail.text || '').trim()
      const target = String(detail.query || spoken.replace(/^(please\s+)?(play|listen to|put on|start playing)\s+/i, '')).trim()
      if (action === 'pause' || /^(pause|stop)( music)?$/i.test(spoken)) {
        audioRef.current?.pause(); setPlaying(false); setMessage('Music paused.'); return
      }
      if (action === 'resume' || /^(resume|continue)( music)?$/i.test(spoken)) {
        void audioRef.current?.play().then(() => setPlaying(true)).catch(() => setMessage('Tap Play to resume audio.')); return
      }
      if (action === 'next' || /^(next|skip)( song| track)?$/i.test(spoken)) {
        const next = queueRef.current[0]
        if (next) void playTrack(next, queueRef.current)
        else setMessage('There is no next track in the queue.')
        return
      }
      if (!target || /^(music|something)$/i.test(target)) return
      const playlist = playlists.find(item => item.name.toLowerCase() === target.toLowerCase())
      if (playlist) { playPlaylist(playlist); return }
      void search(target, action !== 'search' && action !== 'open')
    }
    window.addEventListener('visionary:voice-command', handler)
    return () => window.removeEventListener('visionary:voice-command', handler)
  }, [playlists])

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 text-white md:p-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-xs font-bold tracking-[0.25em] text-emerald-300">VISIONARY NEXUS · MUSIC</div>
          <h1 className="mt-2 text-3xl font-bold">Free music</h1>
          <p className="mt-1 text-sm text-white/55">Jamendo catalogue · in-app search and playback</p>
        </div>
        <span className="rounded-full border border-emerald-300/30 px-3 py-2 text-xs text-emerald-200">FREE PROVIDER</span>
      </header>

      <form onSubmit={event => { event.preventDefault(); void search(query) }} className="flex flex-wrap gap-2 rounded-2xl border border-white/10 bg-white/[0.04] p-3">
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search songs, artists or genres…" className="min-w-0 flex-1 bg-transparent px-3 py-3 text-sm outline-none" />
        <button disabled={busy || !query.trim()} className="rounded-xl bg-emerald-300 px-6 py-3 text-sm font-semibold text-black disabled:opacity-40">{busy ? 'Searching…' : 'Search'}</button>
      </form>

      {message && <p className="text-sm text-white/65">{message}</p>}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {results.map(track => (
          <button key={track.id} onClick={() => void playTrack(track, results)} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-left transition hover:border-emerald-300/40">
            {track.image ? <img src={track.image} alt="" className="h-14 w-14 rounded-xl object-cover" /> : <div className="grid h-14 w-14 place-items-center rounded-xl bg-white/10">♪</div>}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{track.name}</span>
              <span className="block truncate text-xs text-white/50">{track.artist}</span>
              <span className="text-[11px] text-white/35">{formatDuration(track.duration)}</span>
            </span>
            <span className="text-emerald-200">Play</span>
          </button>
        ))}
      </section>

      {current && (
        <section className="rounded-2xl border border-emerald-300/20 bg-emerald-300/[0.06] p-5">
          <div className="flex flex-wrap items-center gap-4">
            {current.image && <img src={current.image} alt="" className="h-16 w-16 rounded-xl object-cover" />}
            <div className="min-w-0 flex-1">
              <div className="text-xs uppercase tracking-widest text-emerald-200/70">Now playing</div>
              <div className="truncate font-semibold">{current.name}</div>
              <div className="truncate text-sm text-white/50">{current.artist}</div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => { if (playing) { audioRef.current?.pause(); setPlaying(false) } else { void audioRef.current?.play().then(() => setPlaying(true)).catch(() => setMessage('Tap Play to resume.')) } }} className="rounded-xl border border-white/15 px-4 py-2 text-sm">{playing ? 'Pause' : 'Play'}</button>
              <button onClick={() => { const next = queueRef.current[0]; if (next) void playTrack(next, queueRef.current) }} className="rounded-xl border border-white/15 px-4 py-2 text-sm">Next</button>
            </div>
          </div>
          <label className="mt-4 flex items-center gap-3 text-xs text-white/50">Volume <input type="range" min="0" max="100" value={volume} onChange={event => setVolume(Number(event.target.value))} className="w-40" /></label>
          {current.license && <a href={current.license} target="_blank" rel="noreferrer" className="mt-3 inline-block text-xs text-emerald-200 underline">Track licence</a>}
        </section>
      )}

      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Your playlists</h2>
            <p className="text-xs text-white/45">Saved in Visionary Nexus</p>
          </div>
          <div className="flex gap-2">
            <input value={playlistName} onChange={event => setPlaylistName(event.target.value)} placeholder="Playlist name" className="w-36 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs outline-none" />
            <button onClick={() => void savePlaylist()} disabled={!results.length || !playlistName.trim()} className="rounded-xl border border-white/15 px-3 py-2 text-xs disabled:opacity-40">Save results</button>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {playlists.map(playlist => <button key={playlist.name} onClick={() => playPlaylist(playlist)} className="rounded-full border border-white/15 px-4 py-2 text-xs hover:border-emerald-300/40">{playlist.name} · {playlist.tracks.length}</button>)}
          {!playlists.length && <p className="text-xs text-white/35">No saved playlists yet.</p>}
        </div>
      </section>
      <p className="text-center text-[11px] text-white/30">Jamendo provides independent and Creative Commons catalogue music. Playback availability and reuse rights depend on each track’s licence.</p>
    </div>
  )
}
