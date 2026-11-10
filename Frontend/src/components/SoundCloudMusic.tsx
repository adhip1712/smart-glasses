import { useEffect, useRef, useState } from 'react'
import { apiFetch, readJson } from '../services/api'
import { speakText } from '../services/speech'
import AudiusMusic from './AudiusMusic'

type SoundCloudTrack = {
  id: string
  name: string
  artist: string
  image?: string
  url?: string
  stream_url: string
  duration?: number
  genre?: string
  provider: 'soundcloud'
  matched?: boolean
  match_score?: number
}

function formatTime(milliseconds = 0) {
  const seconds = Math.max(0, Math.floor((milliseconds || 0) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

type Props = { onSpotify?: () => void }

export default function SoundCloudMusic({ onSpotify }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SoundCloudTrack[]>([])
  const [current, setCurrent] = useState<SoundCloudTrack | null>(null)
  const [queue, setQueue] = useState<SoundCloudTrack[]>([])
  const [message, setMessage] = useState('SoundCloud is the primary catalogue. Audius is used only when no close match is found.')
  const [busy, setBusy] = useState(false)
  const [usingAudius, setUsingAudius] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const switchToAudius = (term: string, autoplay: boolean, reason: string) => {
    setUsingAudius(true)
    setMessage(reason)
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('visionary:voice-command', {
        detail: {
          activeTab: 'music',
          intent: 'music',
          action: autoplay ? 'play' : 'search',
          query: term,
          text: autoplay ? `play ${term}` : term,
        },
      }))
    }, 300)
  }

  const search = async (term = query, autoplay = false) => {
    const clean = term.trim()
    if (!clean) return
    setQuery(clean)
    setBusy(true)
    setMessage('Checking SoundCloud for a close, playable match…')
    try {
      const response = await apiFetch(`/api/music/soundcloud-search?q=${encodeURIComponent(clean)}&limit=24`)
      const data = await readJson<{
        success?: boolean
        configured?: boolean
        matched?: boolean
        tracks?: SoundCloudTrack[]
        message?: string
      }>(response)
      const found = (data?.tracks || []).filter(track =>
        track?.provider === 'soundcloud' && track.id && track.stream_url && track.matched
      )
      if (response.ok && data?.success && data?.matched && found.length) {
        setUsingAudius(false)
        setResults(found)
        setMessage(`SoundCloud match found for “${clean}”.`)
        if (autoplay) {
          setQueue(found.slice(1))
          setCurrent(found[0])
          speakText(`Playing ${found[0].name} by ${found[0].artist} on SoundCloud`)
        }
        return
      }
      setResults([])
      const reason = !data?.configured
        ? 'SoundCloud needs its developer credentials. Checking Audius for this song instead…'
        : 'No sufficiently close playable SoundCloud match. Checking Audius instead…'
      switchToAudius(clean, autoplay, reason)
    } catch {
      setResults([])
      switchToAudius(clean, autoplay, 'SoundCloud is temporarily unavailable. Checking Audius instead…')
    } finally {
      setBusy(false)
    }
  }

  const playTrack = (track: SoundCloudTrack, sequence = results) => {
    setCurrent(track)
    const index = sequence.findIndex(item => item.id === track.id)
    setQueue(index >= 0 ? sequence.slice(index + 1) : [])
    setMessage(`Now playing ${track.name} — ${track.artist} on SoundCloud.`)
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
    setMessage(`Now playing ${next.name} — ${next.artist} on SoundCloud.`)
  }

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string; activeTab?: string; action?: string; query?: string }>).detail
      if (detail?.activeTab !== 'music' || usingAudius) return
      const text = (detail.text || '').toLowerCase().replace(/[.!?,]+/g, ' ').replace(/\s+/g, ' ').trim()
      const action = (detail.action || '').toLowerCase()
      if (action === 'pause' || /^(pause|stop)( music)?$/.test(text)) {
        audioRef.current?.pause()
        setMessage('SoundCloud playback paused.')
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
      if (!target || /^(music|something|soundcloud)$/.test(target)) return
      void search(target, action !== 'search' && action !== 'open')
    }
    window.addEventListener('visionary:voice-command', handler)
    return () => window.removeEventListener('visionary:voice-command', handler)
  }, [queue, results, usingAudius])

  if (usingAudius) {
    return (
      <div className="min-h-screen bg-[#080808] text-white">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4 md:px-8">
          <p className="text-sm text-cyan-200">{message}</p>
          <button onClick={() => { setUsingAudius(false); setMessage('SoundCloud is the primary catalogue.') }} className="rounded-full border border-white/20 px-4 py-2 text-sm">← Back to SoundCloud</button>
        </div>
        <AudiusMusic />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#080808] p-4 text-white md:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-orange-300">Primary music catalogue</p>
            <h1 className="mt-2 text-3xl font-bold">SoundCloud</h1>
            <p className="mt-1 text-sm text-white/55">Search and play close matches. Audius is the automatic fallback.</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-orange-300/30 px-3 py-2 text-xs text-orange-200">PRIMARY</span>
            {onSpotify && <button onClick={onSpotify} className="rounded-full border border-white/20 px-4 py-2 text-sm">Spotify library</button>}
          </div>
        </header>

        <form className="flex flex-col gap-2 sm:flex-row" onSubmit={event => { event.preventDefault(); void search() }}>
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search a song and artist…" className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 outline-none focus:border-orange-300/60" />
          <button type="submit" disabled={busy || !query.trim()} className="rounded-2xl bg-orange-300 px-6 py-3 font-semibold text-black disabled:opacity-50">{busy ? 'Searching…' : 'Search SoundCloud'}</button>
        </form>

        <p className="text-sm text-white/60" role="status">{message}</p>

        {current && (
          <section className="rounded-3xl border border-orange-300/20 bg-white/[0.04] p-4 md:p-5">
            <div className="flex items-center gap-4">
              {current.image ? <img src={current.image} alt="" className="h-16 w-16 rounded-xl object-cover" /> : <div className="h-16 w-16 rounded-xl bg-white/10" />}
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{current.name}</p>
                <p className="truncate text-sm text-white/55">{current.artist}</p>
                {current.genre && <p className="mt-1 text-xs text-orange-200/70">{current.genre}</p>}
              </div>
              {current.url && <a href={current.url} target="_blank" rel="noreferrer" className="text-xs text-orange-200 underline">SoundCloud page</a>}
            </div>
            <audio ref={audioRef} key={current.id} src={current.stream_url} controls autoPlay onEnded={playNext} onError={() => setMessage('This SoundCloud stream failed. Search again or try another result.')} className="mt-4 w-full" />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-white/50">
              <span>{queue.length} tracks remaining</span>
              <button onClick={playNext} disabled={!queue.length} className="rounded-full border border-white/15 px-4 py-2 text-white disabled:opacity-40">Next track</button>
            </div>
          </section>
        )}

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Matching SoundCloud tracks</h2>
            <span className="text-xs text-white/40">{results.length} tracks</span>
          </div>
          {results.map(track => (
            <div key={track.id} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.035] p-3">
              {track.image ? <img src={track.image} alt="" className="h-12 w-12 rounded-lg object-cover" /> : <div className="h-12 w-12 rounded-lg bg-white/10" />}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{track.name}</p>
                <p className="truncate text-xs text-white/50">{track.artist} · {formatTime(track.duration)}</p>
              </div>
              <button onClick={() => playTrack(track)} className="rounded-full bg-orange-300 px-4 py-2 text-xs font-bold text-black">Play</button>
              {track.url && <a href={track.url} target="_blank" rel="noreferrer" aria-label={`Open ${track.name} on SoundCloud`} className="px-2 text-xs text-white/50">Open</a>}
            </div>
          ))}
          {!results.length && <div className="rounded-2xl border border-dashed border-white/10 p-8 text-center text-sm text-white/40">Search for a track to find playable SoundCloud matches. Audius will be checked automatically if there is no close match.</div>}
        </section>
        <p className="text-center text-[11px] text-white/35">Track creator: {current?.artist || 'SoundCloud creators'} · Source: <a href="https://soundcloud.com" target="_blank" rel="noreferrer" className="underline">SoundCloud</a></p>
      </div>
    </div>
  )
}
