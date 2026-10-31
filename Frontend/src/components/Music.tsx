import { useEffect, useRef, useState } from 'react'
import { apiFetch, readJson } from '../services/api'
import { speakText } from '../services/speech'

declare global {
  interface Window {
    YT?: any
    onYouTubeIframeAPIReady?: () => void
  }
}

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
  provider?: string
  videoId?: string
}

interface SavedPlaylist {
  name: string
  tracks: Track[]
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
  message: 'Checking music provider...',
}

function formatDuration(ms?: number): string {
  if (!ms) return ''
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function normalizedTrackText(value?: string): string {
  return (value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')
}

function wantsUltraSlowed(title: string): boolean {
  return /\bultra[ -]?slowed\b/i.test(title || '')
}

function isUnwantedYouTubeVariant(track: Track, requireUltraSlowed = false): boolean {
  const title = track.name || ''
  const isLong = (Number(track.duration) || 0) > 900000
  const isHourLoopOrExtended = /\b(?:\d+\s*(?:hours?|hrs?|hr)|one[ -]?hour|1[ -]?hour|extended[ -]?mix|looped?)\b/i.test(title)
  const isUltra = wantsUltraSlowed(title)
  const isOtherSlowed = /\b(?:super[ -]?slowed|slowed(?:\s*(?:\+|and|with)?\s*reverb)?)\b/i.test(title) && !isUltra
  const isOtherAltered = /\b(?:reverb|mash[ -]?up|remix|nightcore|sped[ -]?up|speed[ -]?up|cover version)\b/i.test(title)
  return isLong || isHourLoopOrExtended || (requireUltraSlowed ? !isUltra || isOtherSlowed : isUltra || isOtherSlowed || isOtherAltered)
}

function cleanYouTubeTrackTitle(title: string): string {
  return title
    .replace(/\s*[-–—]?\s*[([{]?\s*(?:ultra[ -]?slowed|super[ -]?slowed|slowed(?:\s*(?:\+|and|with)?\s*reverb)?|reverb|mash[ -]?up|remix|nightcore|sped[ -]?up|speed[ -]?up|cover version|\d+\s*(?:hours?|hrs?|hr)|1\s*hour|extended\s*mix|looped?)(?:\s*(?:\+|&|and)\s*(?:reverb|mash[ -]?up|remix|nightcore|sped[ -]?up|speed[ -]?up))?\s*[)\]}]?/ig, ' ')
    .replace(/\s+/g, ' ').trim()
}

function sameImportedTrack(a: Track, b: Track): boolean {
  const aTitle = normalizedTrackText(a.name)
  const bTitle = normalizedTrackText(b.name)
  const aArtist = normalizedTrackText(a.artist)
  const bArtist = normalizedTrackText(b.artist)
  return aTitle === bTitle && (!aArtist || !bArtist || aArtist === bArtist)
}

function choosePlaylistMatch(candidates: Track[], requestedTitle: string, requestedArtist: string): Track | undefined {
  const title = normalizedTrackText(requestedTitle)
  const artist = normalizedTrackText(requestedArtist)
  if (!title) return undefined
  const exactTitle = candidates.filter(track => normalizedTrackText(track.name) === title)
  if (exactTitle.length) {
    return exactTitle.find(track => !artist || normalizedTrackText(track.artist) === artist) || exactTitle[0]
  }
  // Do not silently substitute sequels, remixes, or slowed versions for the
  // requested original. Import only an exact normalized title match.
  return undefined
}

let youtubeApiPromise: Promise<any> | null = null
function loadYouTubeApi(): Promise<any> {
  if (window.YT?.Player) return Promise.resolve(window.YT)
  if (!youtubeApiPromise) {
    youtubeApiPromise = new Promise(resolve => {
      const previousReady = window.onYouTubeIframeAPIReady
      window.onYouTubeIframeAPIReady = () => {
        previousReady?.()
        resolve(window.YT)
      }
      if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
        const script = document.createElement('script')
        script.src = 'https://www.youtube.com/iframe_api'
        script.async = true
        document.head.appendChild(script)
      }
    })
  }
  return youtubeApiPromise
}

export default function Music() {
  const [config, setConfig] = useState<ProviderConfig>(emptyConfig)
  const [query, setQuery] = useState('')
  const [tracks, setTracks] = useState<Track[]>([])
  const [queue, setQueue] = useState<Track[]>([])
  const [current, setCurrent] = useState<Track | null>(null)
  const [playlistName, setPlaylistName] = useState('')
  const [editingPlaylistName, setEditingPlaylistName] = useState<string | null>(null)
  const [renamingPlaylistName, setRenamingPlaylistName] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [selectedPlaylistName, setSelectedPlaylistName] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem('visionary-nexus-music-selected-playlist')
    } catch {
      return null
    }
  })
  // Hydrate saved playlists synchronously on first render so an early voice
  // command can never see an empty list and accidentally fall back to YouTube.
  const [playlists, setPlaylists] = useState<SavedPlaylist[]>(() => {
    try {
      const saved = window.localStorage.getItem('visionary-nexus-music-playlists')
      const parsed: unknown = saved ? JSON.parse(saved) : []
      return Array.isArray(parsed)
        ? parsed.filter((item): item is SavedPlaylist =>
            Boolean(item) && typeof item.name === 'string' && Array.isArray(item.tracks)
          )
        : []
    } catch {
      return []
    }
  })
  const playlistsHydratedRef = useRef(false)
  const [playing, setPlaying] = useState(false)
  const [volume, setVolume] = useState(70)
  const [busy, setBusy] = useState(false)
  const [importBusy, setImportBusy] = useState(false)
  const [importStatus, setImportStatus] = useState('')
  const [draggingQueueIndex, setDraggingQueueIndex] = useState<number | null>(null)
  const [draggingPlaylistTrackIndex, setDraggingPlaylistTrackIndex] = useState<number | null>(null)
  const [message, setMessage] = useState('')
  const [position, setPosition] = useState(0)
  const [audioDuration, setAudioDuration] = useState(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const queueRef = useRef<Track[]>([])
  const playTrackRef = useRef<((track: Track) => Promise<void>) | null>(null)
  const advanceQueueRef = useRef<() => void>(() => {})
  const activeSequenceRef = useRef<Track[]>([])
  const activeIndexRef = useRef(-1)
  const activeTrackIdRef = useRef<string | null>(null)
  const shouldContinuePlaybackRef = useRef(false)
  const youtubePlayerRef = useRef<any>(null)
  const youtubeContainerRef = useRef<HTMLDivElement | null>(null)
  const failedYouTubeIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    queueRef.current = queue
  }, [queue])

  useEffect(() => {
    if (selectedPlaylistName && !playlists.some(item => item.name === selectedPlaylistName)) {
      setSelectedPlaylistName(null)
      try { window.localStorage.removeItem('visionary-nexus-music-selected-playlist') } catch { /* storage unavailable */ }
    }
  }, [playlists, selectedPlaylistName])

  const rememberSelectedPlaylist = (name: string | null) => {
    setSelectedPlaylistName(name)
    try {
      if (name) window.localStorage.setItem('visionary-nexus-music-selected-playlist', name)
      else window.localStorage.removeItem('visionary-nexus-music-selected-playlist')
    } catch {
      // Playlist contents remain saved even if selected-playlist memory is unavailable.
    }
  }

  const persistPlaylists = (next: SavedPlaylist[]) => {
    setPlaylists(next)
    try {
      window.localStorage.setItem('visionary-nexus-music-playlists', JSON.stringify(next))
    } catch {
      setMessage('Could not save playlists in this browser. Check browser storage settings.')
    }
    // The database is the durable source of truth; localStorage remains a
    // fast offline cache and migration fallback.
    if (playlistsHydratedRef.current) {
      void apiFetch('/api/music/playlists', {
        method: 'PUT',
        body: JSON.stringify({ playlists: next }),
      }).then(async response => {
        const result = await readJson<{ success?: boolean; message?: string }>(response)
        if (!response.ok || result?.success === false) {
          setMessage(result?.message || 'Playlist database save failed. Your browser cache is still available.')
        }
      }).catch(() => {
        setMessage('Playlist database is unavailable. The browser cache is still saved on this device.')
      })
    }
  }

  const loadConfig = async () => {
    const response = await apiFetch('/api/music/config')
    const data = await readJson<ProviderConfig>(response)
    if (data) setConfig(data)
  }

  useEffect(() => {
    void loadConfig()
    void (async () => {
      try {
        const response = await apiFetch('/api/music/playlists')
        const data = await readJson<{ success?: boolean; playlists?: SavedPlaylist[] }>(response)
        if (!response.ok || !data?.success || !Array.isArray(data.playlists)) return
        const remote = data.playlists.filter(item =>
          Boolean(item) && typeof item.name === 'string' && Array.isArray(item.tracks)
        )
        if (remote.length) {
          setPlaylists(remote)
          try { window.localStorage.setItem('visionary-nexus-music-playlists', JSON.stringify(remote)) } catch { /* optional cache */ }
        } else {
          // One-time migration: preserve existing browser playlists when the
          // newly added database table has no records yet.
          let cached: SavedPlaylist[] = []
          try {
            const raw = window.localStorage.getItem('visionary-nexus-music-playlists')
            const parsed: unknown = raw ? JSON.parse(raw) : []
            if (Array.isArray(parsed)) cached = parsed.filter(item =>
              Boolean(item) && typeof item.name === 'string' && Array.isArray(item.tracks)
            )
          } catch { /* malformed cache is ignored without deleting database data */ }
          if (cached.length) {
            setPlaylists(cached)
            const migrated = await apiFetch('/api/music/playlists', {
              method: 'PUT',
              body: JSON.stringify({ playlists: cached }),
            })
            if (!migrated.ok) setMessage('Existing playlists remain in browser storage; database migration did not complete.')
          }
        }
      } catch {
        // Keep the local cache available when the backend is offline.
      } finally {
        playlistsHydratedRef.current = true
      }
    })()
    return () => {
      audioRef.current?.pause()
      audioRef.current = null
    }
  }, [])

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume / 100
    youtubePlayerRef.current?.setVolume?.(volume)
  }, [volume])

  // Chrome may suspend background-tab work. If a track's transition was
  // interrupted, resume the intended track when the page becomes active again.
  // This never overrides an explicit user pause.
  useEffect(() => {
    const recoverPlayback = () => {
      const audio = audioRef.current
      const track = current
      if (!shouldContinuePlaybackRef.current || !audio || !track?.audio ||
          (track.provider || '').toLowerCase() === 'youtube' || !audio.paused || document.hidden) return
      if (activeTrackIdRef.current !== track.id) return
      void audio.play().then(() => {
        setPlaying(true)
        setMessage('')
      }).catch(() => {
        setPlaying(false)
        setMessage('Playback needs a tap to resume because Chrome blocked background playback.')
      })
    }
    document.addEventListener('visibilitychange', recoverPlayback)
    window.addEventListener('pageshow', recoverPlayback)
    return () => {
      document.removeEventListener('visibilitychange', recoverPlayback)
      window.removeEventListener('pageshow', recoverPlayback)
    }
  }, [current])

  const playTrack = async (track: Track) => {
    // CSV rows that did not match during import are metadata only, not playable
    // media. Resolve them against YouTube at playback time using the same title.
    const providerName = (track.provider || '').toLowerCase()
    if (providerName === 'unmatched' || (!track.videoId && !track.audio)) {
      const originalTitle = (track.name || '').trim()
      const requireUltraSlowed = wantsUltraSlowed(originalTitle)
      const requestedTitle = cleanYouTubeTrackTitle(originalTitle).trim()
      const searchTerm = [requestedTitle, requireUltraSlowed ? 'ultra slowed' : '', track.artist && !/not matched in current music catalog/i.test(track.artist) ? track.artist : ''].filter(Boolean).join(' ')
      if (!requestedTitle) {
        setPlaying(false)
        setMessage('This CSV row has no song title to search for.')
        return
      }
      setMessage(`Finding a playable YouTube upload for “${requestedTitle}”…`)
      try {
        const response = await apiFetch('/api/music/search', {
          method: 'POST',
          body: JSON.stringify({ query: searchTerm || requestedTitle }),
        })
        const data = await readJson<{ tracks?: Track[] }>(response)
        const wanted = normalizedTrackText(requestedTitle)
        const alternatives = (data?.tracks || []).filter(candidate => {
          if (candidate.provider?.toLowerCase() !== 'youtube' || !candidate.videoId || failedYouTubeIdsRef.current.has(candidate.videoId) || isUnwantedYouTubeVariant(candidate, requireUltraSlowed)) return false
          const candidateTitle = normalizedTrackText(cleanYouTubeTrackTitle(candidate.name || ''))
          return candidateTitle === wanted || candidateTitle.startsWith(`${wanted} `) || wanted.startsWith(`${candidateTitle} `)
        })
        if (alternatives.length) {
          const resolved = alternatives[0]
          setMessage(`Found another upload: ${resolved.name} (${resolved.artist || 'YouTube'})`)
          await playTrack({ ...resolved, id: track.id })
          return
        }
        setPlaying(false)
        setMessage(`No playable standard-length YouTube upload found for “${requestedTitle}”. The CSV entry is still saved; try searching the title manually.`)
      } catch {
        setPlaying(false)
        setMessage(`Could not search YouTube for “${requestedTitle}”. Check the connection and try again.`)
      }
      return
    }

    const isYouTubeTrack = providerName === 'youtube' && Boolean(track.videoId)
    // Do not let an old search query accidentally whitelist an altered upload
    // when a saved playlist is played later.
    const requestedVariant = /\b(?:slowed|ultra|super|remix|nightcore|reverb|mash[ -]?up|sped[ -]?up|speed[ -]?up|extended|hour|loop)\b/i.test(track.name || '')
    if (
      isYouTubeTrack &&
      !requestedVariant &&
      isUnwantedYouTubeVariant(track) &&
      track.videoId &&
      !failedYouTubeIdsRef.current.has(track.videoId)
    ) {
      // Saved playlists may contain an older 1-hour/slowed upload. Replace it
      // with a normal-length version before playback, not only after player errors.
      failedYouTubeIdsRef.current.add(track.videoId)
      try {
        const cleanTitle = cleanYouTubeTrackTitle(track.name)
        const response = await apiFetch('/api/music/search', {
          method: 'POST',
          body: JSON.stringify({ query: cleanTitle || track.name }),
        })
        const data = await readJson<{ tracks?: Track[] }>(response)
        const alternative = (data?.tracks || []).find(candidate =>
          candidate.provider?.toLowerCase() === 'youtube' &&
          Boolean(candidate.videoId) &&
          !failedYouTubeIdsRef.current.has(candidate.videoId!) &&
          !isUnwantedYouTubeVariant(candidate)
        )
        if (alternative) {
          setMessage('Replacing the altered upload with a standard version: ' + alternative.name)
          await playTrack(alternative)
          return
        }
      } catch {
        // Keep the saved track playable if alternate search is unavailable.
      }
    }

    shouldContinuePlaybackRef.current = true
    activeTrackIdRef.current = track.id
    setCurrent(track)
    setPosition(0)
    setAudioDuration(0)
    setMessage('')
    if ((track.provider || '').toLowerCase() === 'youtube' && track.videoId) {
      audioRef.current?.pause()
      if (audioRef.current) audioRef.current.src = ''
      setPlaying(true)
      setMessage('Starting playback...')
      return
    }
    if (track.audio) {
      if (!audioRef.current) {
        audioRef.current = new Audio()
        audioRef.current.addEventListener('ended', () => advanceQueueRef.current())
        audioRef.current.addEventListener('timeupdate', () => setPosition(audioRef.current?.currentTime || 0))
        audioRef.current.addEventListener('loadedmetadata', () => setAudioDuration(audioRef.current?.duration || 0))
      }
      audioRef.current.src = track.audio
      audioRef.current.currentTime = 0
      audioRef.current.volume = volume / 100
      try {
        await audioRef.current.play()
        setPlaying(true)
      } catch (error) {
        setPlaying(false)
        if (document.hidden) {
          const audio = audioRef.current
          let retryInFlight = false
          const cleanupRetry = () => {
            document.removeEventListener('visibilitychange', retryPlayback)
            audio?.removeEventListener('canplay', retryPlayback)
            audio?.removeEventListener('playing', cleanupRetry)
          }
          const retryPlayback = () => {
            // Keep retry listeners installed until playback actually starts.
            // Chrome can reject the first play() call for a newly loaded source
            // while this tab is backgrounded; removing listeners on that first
            // rejection meant the track never retried when the user returned.
            if (!audio || activeTrackIdRef.current !== track.id ||
                !shouldContinuePlaybackRef.current) {
              cleanupRetry()
              return
            }
            if (document.hidden && audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return
            if (retryInFlight || !audio.paused) return
            retryInFlight = true
            void audio.play().then(() => {
              setPlaying(true)
              setMessage('')
              cleanupRetry()
            }).catch(() => {
              // Leave listeners active; canplay or returning to this tab retries.
            }).finally(() => {
              retryInFlight = false
            })
          }
          audio?.addEventListener('canplay', retryPlayback)
          audio?.addEventListener('playing', cleanupRetry, { once: true })
          document.addEventListener('visibilitychange', retryPlayback)
          setMessage('Waiting for the next track to load in the background.')
          // Handle the case where the source became ready before listeners attached.
          retryPlayback()
        } else {
          setMessage('Full-track playback failed: ' + (error instanceof Error ? error.message : 'unknown error'))
        }
      }
    } else {
      setPlaying(false)
      setMessage('This result has no full-track audio stream, so it cannot be played here.')
    }
  }

  playTrackRef.current = playTrack
  advanceQueueRef.current = () => {
    const sequence = activeSequenceRef.current
    if (sequence.length && activeIndexRef.current >= 0 && activeIndexRef.current < sequence.length - 1) {
      startSequenceTrack(sequence, activeIndexRef.current + 1)
      return
    }
    // Do not stop at the end of an Apple/iTunes preview: queued tracks and
    // playlist sequences must advance automatically, including in background tabs.
    const [nextTrack, ...remaining] = queueRef.current
    if (!nextTrack) {
      setPlaying(false)
      setMessage('Queue finished. Add more tracks to keep listening.')
      return
    }
    queueRef.current = remaining
    setQueue(remaining)
    activeSequenceRef.current = [nextTrack, ...remaining]
    activeIndexRef.current = 0
    void playTrackRef.current?.(nextTrack)
  }

  useEffect(() => {
    if ((current?.provider || '').toLowerCase() !== 'youtube' || !current?.videoId) {
      return
    }
    let cancelled = false
    let player: any = null
    void loadYouTubeApi().then(YT => {
      const container = youtubeContainerRef.current
      if (cancelled || !container) return
      // YouTube replaces the element passed to YT.Player with an iframe. Create
      // a fresh child for each track so React's ref never points at a destroyed iframe.
      const playerHost = document.createElement('div')
      playerHost.style.width = '100%'
      playerHost.style.height = '100%'
      container.replaceChildren(playerHost)
      player = new YT.Player(playerHost, {
        width: '100%',
        height: '100%',
        videoId: current.videoId,
        playerVars: {
          autoplay: 1,
          controls: 1,
          playsinline: 1,
          rel: 0,
          origin: window.location.origin,
        },
        events: {
          onReady: (event: any) => {
            event.target.setVolume(volume)
            event.target.playVideo?.()
            setPlaying(true)
            setMessage('')
          },
          onAutoplayBlocked: () => {
            setPlaying(false)
            setMessage('Your browser blocked automatic playback. Press Play in the YouTube player once; playlist navigation will then work normally.')
          },
          onStateChange: (event: any) => {
            if (event.data === YT.PlayerState.ENDED) advanceQueueRef.current()
            if (event.data === YT.PlayerState.PLAYING) setPlaying(true)
            if (event.data === YT.PlayerState.PAUSED) setPlaying(false)
          },
          onError: (event: any) => {
            setPlaying(false)
            const code = event?.data
            if (current.videoId) failedYouTubeIdsRef.current.add(current.videoId)
            setMessage(`This YouTube upload is unavailable (error ${code ?? 'unknown'}). Searching for another channel's upload…`)

            // Retry the same song against alternate uploads before advancing the playlist.
            void (async () => {
              try {
                const cleanTitle = current.name
                  .replace(/\s*[([{ -]*(?:ultra[ -]?slowed|super[ -]?slowed|slowed(?:\s*(?:\+|and|with)?\s*reverb)?|\d+\s*(?:hours?|hrs?|hr)|1\s*hour|extended\s*mix|looped?)[)\]} -]*\s*/ig, ' ')
                  .replace(/\s+/g, ' ').trim()
                const requireUltraSlowed = wantsUltraSlowed(current.name)
                const searchQuery = [cleanTitle || current.name, requireUltraSlowed ? 'ultra slowed' : ''].filter(Boolean).join(' ')
                const response = await apiFetch('/api/music/search', {
                  method: 'POST', body: JSON.stringify({ query: searchQuery }),
                })
                const data = await readJson<{ tracks?: Track[] }>(response)
                const wantedTitle = normalizedTrackText(cleanYouTubeTrackTitle(cleanTitle || current.name))
                const alternatives = (data?.tracks || []).filter(track => {
                  if (track.provider?.toLowerCase() !== 'youtube' || !track.videoId || failedYouTubeIdsRef.current.has(track.videoId)) return false
                  if (isUnwantedYouTubeVariant(track, requireUltraSlowed)) return false
                  // Only retry uploads of the same song; do not jump to a different search result.
                  const candidateTitle = normalizedTrackText(cleanYouTubeTrackTitle(track.name || ''))
                  return candidateTitle === wantedTitle || candidateTitle.startsWith(`${wantedTitle} `) || wantedTitle.startsWith(`${candidateTitle} `)
                })
                if (activeTrackIdRef.current !== current.id) return
                if (alternatives.length) {
                  const [alternative, ...rest] = alternatives
                  activeSequenceRef.current = alternatives
                  activeIndexRef.current = 0
                  queueRef.current = rest
                  setQueue(rest)
                  setMessage(`Trying another upload: ${alternative.name} (${alternative.artist || 'YouTube'})`)
                  await playTrackRef.current?.(alternative)
                  return
                }
              } catch {
                // Continue with the existing queue if alternate search fails.
              }
              if (activeTrackIdRef.current === current.id) {
                setMessage('No alternate upload found; moving to the next queued track.')
                advanceQueueRef.current()
              }
            })()
          },
        },
      })
      youtubePlayerRef.current = player
    }).catch(() => {
      if (!cancelled) setMessage('Could not load the YouTube player. Check your internet connection and try again.')
    })
    return () => {
      cancelled = true
      if (player && typeof player.destroy === 'function') player.destroy()
      if (youtubePlayerRef.current === player) youtubePlayerRef.current = null
      youtubeContainerRef.current?.replaceChildren()
    }
  }, [current?.provider, current?.videoId])

  const searchTracksByTerm = async (term: string, autoplay = false) => {
    const searchTerm = term.trim()
    if (!searchTerm) return
    setQuery(searchTerm)
    setBusy(true)
    setMessage('')
    try {
      const response = await apiFetch('/api/music/search', {
        method: 'POST',
        body: JSON.stringify({ query: searchTerm }),
      })
      const data = await readJson<{ success?: boolean; tracks?: Track[]; message?: string; notice?: string; source?: string }>(response)
      const found = data?.tracks || []
      setTracks(found)
      if (autoplay && found.length) {
        const firstPlayableIndex = found.findIndex(track => Boolean(track.videoId || track.audio))
        if (firstPlayableIndex >= 0) {
          const playable = found.slice(firstPlayableIndex)
          activeSequenceRef.current = playable
          activeIndexRef.current = 0
          queueRef.current = playable.slice(1)
          setQueue(playable.slice(1))
          await playTrack(found[firstPlayableIndex])
          setMessage(`No saved playlist matched "${searchTerm}". Playing a music search result.`)
        } else {
          setMessage(`Found results for "${searchTerm}", but none can be played by the current provider.`)
        }
      } else {
        setMessage(
          data?.notice ||
          data?.message ||
          (found.length ? `Found ${found.length} track(s) from ${data?.source || 'music provider'}.` : 'No matches found. Try a shorter title or artist name.')
        )
      }
      if (autoplay && !found.length) setMessage(`No saved playlist named "${searchTerm}" and no music search results were found.`)
    } catch (error) {
      setMessage(`Music search failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    } finally {
      setBusy(false)
    }
  }

  const searchTracks = async (event: React.FormEvent) => {
    event.preventDefault()
    await searchTracksByTerm(query)
  }

  const startSequenceTrack = (sequence: Track[], index: number) => {
    if (index < 0 || index >= sequence.length) return
    activeSequenceRef.current = sequence
    activeIndexRef.current = index
    const remaining = sequence.slice(index + 1)
    queueRef.current = remaining
    setQueue(remaining)
    void playTrack(sequence[index])
  }

  const control = async (action: 'pause' | 'resume' | 'next' | 'previous') => {
    if (current?.provider?.toLowerCase() === 'youtube' && current.videoId && (action === 'pause' || action === 'resume')) {
      if (action === 'pause') youtubePlayerRef.current?.pauseVideo?.()
      else youtubePlayerRef.current?.playVideo?.()
      setMessage('Use the YouTube player controls to seek and adjust volume.')
      return
    }
    if (action === 'pause') {
      shouldContinuePlaybackRef.current = false
      audioRef.current?.pause()
      setPlaying(false)
    }
    if (action === 'resume') {
      shouldContinuePlaybackRef.current = true
      void audioRef.current?.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
    }
    if (action === 'next') {
      const sequence = activeSequenceRef.current
      if (sequence.length && activeIndexRef.current < sequence.length - 1) {
        startSequenceTrack(sequence, activeIndexRef.current + 1)
        return
      }
      if (queueRef.current.length > 0) {
        const [nextTrack, ...rest] = queueRef.current
        queueRef.current = rest
        setQueue(rest)
        activeSequenceRef.current = [nextTrack, ...rest]
        activeIndexRef.current = 0
        void playTrack(nextTrack)
        return
      }
      setPlaying(false)
      setMessage('You are at the end of this playlist.')
      return
    }
    if (action === 'previous') {
      if (position > 3 && audioRef.current) {
        audioRef.current.currentTime = 0
        setPosition(0)
        return
      }
      const sequence = activeSequenceRef.current
      if (sequence.length && activeIndexRef.current > 0) {
        startSequenceTrack(sequence, activeIndexRef.current - 1)
        return
      }
      if (current) {
        void playTrack(current)
        setMessage('Restarting the first song.')
        return
      }
    }
    const response = await apiFetch(`/api/music/${action}`, { method: 'POST', body: JSON.stringify({}) })
    const data = await readJson<{ success?: boolean; message?: string }>(response)
    if (data?.message) setMessage(data.message)
  }

  const addToQueue = (track: Track) => {
    setQueue(previous => {
      if (previous.some(item => item.id === track.id)) return previous
      const updated = [...previous, track]
      queueRef.current = updated
      return updated
    })
  }

  const savePlaylist = () => {
    const name = playlistName.trim()
    if (!name) {
      setMessage('Enter a playlist name first.')
      return
    }
    // Playing a saved playlist changes the playback queue, not the saved playlist.
    // Only replace a playlist when explicitly editing it; otherwise save the full
    // active sequence (including the currently playing track), not just its tail.
    const activeSequence = activeSequenceRef.current
    const currentSequenceIndex = current
      ? activeSequence.findIndex(track => track.id === current.id)
      : -1
    const sequenceMatchesQueue = currentSequenceIndex >= 0 &&
      queueRef.current.length === activeSequence.length - currentSequenceIndex - 1 &&
      queueRef.current.every((track, index) => track.id === activeSequence[currentSequenceIndex + index + 1]?.id)
    const items = editingPlaylistName
      ? queue
      : sequenceMatchesQueue
        ? activeSequence
        : current
          ? [current, ...queue.filter(track => track.id !== current.id)]
          : queue
    if (!items.length) {
      setMessage('Add songs to the queue before saving a playlist.')
      return
    }
    const next = [...playlists.filter(item => item.name.toLowerCase() !== name.toLowerCase()), { name, tracks: [...items] }]
    persistPlaylists(next)
    rememberSelectedPlaylist(name)
    setEditingPlaylistName(null)
    setMessage(`Saved playlist "${name}" with ${items.length} track(s).`)
  }

  const renamePlaylist = (oldName: string) => {
    setRenamingPlaylistName(oldName)
    setRenameDraft(oldName)
    setMessage('Enter the new playlist name and choose Save name.')
  }

  const commitPlaylistRename = (oldName: string) => {
    const newName = renameDraft.trim()
    if (!newName) {
      setMessage('Playlist name cannot be empty.')
      return
    }
    if (playlists.some(item => item.name.toLowerCase() === newName.toLowerCase() && item.name !== oldName)) {
      setMessage('A playlist with that name already exists.')
      return
    }
    if (newName !== oldName) {
      persistPlaylists(playlists.map(item => item.name === oldName ? { ...item, name: newName } : item))
      if (selectedPlaylistName === oldName) rememberSelectedPlaylist(newName)
      if (editingPlaylistName === oldName) setEditingPlaylistName(newName)
      if (playlistName === oldName) setPlaylistName(newName)
      setMessage(`Renamed playlist "${oldName}" to "${newName}".`)
    }
    setRenamingPlaylistName(null)
    setRenameDraft('')
  }

  const playPlaylistByName = (name: string) => {
    const playlist = playlists.find(item => item.name.toLowerCase() === name.toLowerCase())
    if (!playlist || !playlist.tracks.length) {
      setMessage('Playlist ' + name + ' is empty or was not found.')
      return
    }
    setPlaylistName(playlist.name)
    rememberSelectedPlaylist(playlist.name)
    setEditingPlaylistName(null)
    // Keep the saved playlist untouched, but resolve obvious altered YouTube
    // uploads (reverb/mashup/remix/slowed/long loops) to their standard title
    // when playback starts. This prevents an old imported variant from winning.
    const playbackTracks = playlist.tracks.map(track => {
      if ((track.provider || '').toLowerCase() !== 'youtube' || !isUnwantedYouTubeVariant(track)) return track
      const cleanTitle = cleanYouTubeTrackTitle(track.name)
      if (!cleanTitle) return track
      return { ...track, name: cleanTitle, provider: 'unmatched', videoId: undefined, audio: undefined }
    })
    startSequenceTrack(playbackTracks, 0)
    setMessage('Playing playlist ' + playlist.name + '.')
  }

  const playPlaylist = () => {
    const name = playlistName.trim()
    if (!name) {
      setMessage('Choose a playlist below or enter its name first.')
      return
    }
    playPlaylistByName(name)
  }

  const playSavedTrack = (playlist: SavedPlaylist, index: number) => {
    rememberSelectedPlaylist(playlist.name)
    setPlaylistName(playlist.name)
    const playbackTracks = playlist.tracks.map(track => {
      if ((track.provider || '').toLowerCase() !== 'youtube' || !isUnwantedYouTubeVariant(track)) return track
      const cleanTitle = cleanYouTubeTrackTitle(track.name)
      if (!cleanTitle) return track
      return { ...track, name: cleanTitle, provider: 'unmatched', videoId: undefined, audio: undefined }
    })
    startSequenceTrack(playbackTracks, index)
    setMessage('Playing ' + (playbackTracks[index]?.name || 'track') + ' from ' + playlist.name + '.')
  }

  const removeSavedTrack = (playlistName: string, trackIndex: number) => {
    const playlist = playlists.find(item => item.name === playlistName)
    if (!playlist) return
    const updatedTracks = playlist.tracks.filter((_, index) => index !== trackIndex)
    persistPlaylists(playlists.map(item => item.name === playlistName ? { ...item, tracks: updatedTracks } : item))
    if (editingPlaylistName === playlistName) {
      queueRef.current = updatedTracks
      setQueue(updatedTracks)
    }
    if (selectedPlaylistName === playlistName) {
      const activeTrack = activeSequenceRef.current[activeIndexRef.current]
      const removedTrack = playlist.tracks[trackIndex]
      const nextSequence = activeSequenceRef.current.filter((track, index) => !(index === trackIndex && track.id === removedTrack?.id))
      activeSequenceRef.current = nextSequence
      const retainedIndex = activeTrack ? nextSequence.findIndex(track => track.id === activeTrack.id) : -1
      activeIndexRef.current = retainedIndex >= 0 ? retainedIndex : Math.min(trackIndex, nextSequence.length - 1)
      const remaining = nextSequence.slice(activeIndexRef.current + 1)
      queueRef.current = remaining
      setQueue(remaining)
    }
    setMessage('Removed song from ' + playlistName + '.')
  }

  const moveQueueItem = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= queueRef.current.length) return
    reorderQueueItem(index, target)
  }

  const reorderSavedPlaylistTrack = (playlistName: string, fromIndex: number, toIndex: number) => {
    const playlist = playlists.find(item => item.name === playlistName)
    if (!playlist || fromIndex < 0 || toIndex < 0 || fromIndex >= playlist.tracks.length || toIndex >= playlist.tracks.length || fromIndex === toIndex) return
    const reorderedTracks = [...playlist.tracks]
    const [movedTrack] = reorderedTracks.splice(fromIndex, 1)
    reorderedTracks.splice(toIndex, 0, movedTrack)
    const next = playlists.map(item => item.name === playlistName ? { ...item, tracks: reorderedTracks } : item)
    persistPlaylists(next)
    if (editingPlaylistName === playlistName) {
      queueRef.current = [...reorderedTracks]
      setQueue([...reorderedTracks])
    }
    if (selectedPlaylistName === playlistName) {
      activeSequenceRef.current = [...reorderedTracks]
      const currentIndex = current ? reorderedTracks.findIndex(track => track.id === current.id) : -1
      activeIndexRef.current = currentIndex
      const remaining = currentIndex >= 0 ? reorderedTracks.slice(currentIndex + 1) : [...reorderedTracks]
      queueRef.current = remaining
      setQueue(remaining)
    }
    setMessage(`Saved the new song order for "${playlistName}".`)
  }

  const reorderQueueItem = (fromIndex: number, toIndex: number) => {
    const existing = queueRef.current
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= existing.length || toIndex >= existing.length || fromIndex === toIndex) return
    const reordered = [...existing]
    const [moved] = reordered.splice(fromIndex, 1)
    reordered.splice(toIndex, 0, moved)
    queueRef.current = reordered
    setQueue(reordered)
    if (editingPlaylistName) {
      persistPlaylists(playlists.map(item => item.name === editingPlaylistName ? { ...item, tracks: reordered } : item))
    } else if (activeSequenceRef.current.length && activeIndexRef.current >= 0) {
      const prefix = activeSequenceRef.current.slice(0, activeIndexRef.current + 1)
      activeSequenceRef.current = [...prefix, ...reordered]
    }
  }

  const importPlaylistFile = async (file: File) => {
    setImportBusy(true)
    setImportStatus('Reading playlist file...')
    try {
      const content = await file.text()
      const rows: string[][] = []
      let row: string[] = []
      let cell = ''
      let quoted = false
      for (let index = 0; index < content.length; index += 1) {
        const char = content[index]
        if (char === '"' && quoted && content[index + 1] === '"') {
          cell += '"'
          index += 1
        } else if (char === '"') {
          quoted = !quoted
        } else if ((char === ',' || char === '\t' || char === ';') && !quoted) {
          row.push(cell.trim())
          cell = ''
        } else if ((char === '\n' || char === '\r') && !quoted) {
          if (cell || row.length) {
            row.push(cell.trim())
            rows.push(row)
          }
          row = []
          cell = ''
        } else {
          cell += char
        }
      }
      if (cell || row.length) {
        row.push(cell.trim())
        rows.push(row)
      }
      if (!rows.length) throw new Error('The selected file is empty.')

      const header = rows[0].map(value => value.toLowerCase().replace(/[^a-z0-9]/g, ''))
      const titleIndex = header.findIndex(value => ['track', 'trackname', 'title', 'song', 'songtitle', 'name'].includes(value))
      const artistIndex = header.findIndex(value => ['artist', 'artistname', 'artistnames', 'performer'].includes(value))
      const hasHeader = titleIndex >= 0
      const firstDataRow = hasHeader ? 1 : 0
      const resolvedTitleIndex = hasHeader ? titleIndex : 0
      const resolvedArtistIndex = hasHeader && artistIndex >= 0 ? artistIndex : 1
      const candidates = rows.slice(firstDataRow).map(values => ({
        title: (values[resolvedTitleIndex] || '').trim(),
        artist: (values[resolvedArtistIndex] || '').trim(),
      })).filter(item => item.title && item.title.toLowerCase() !== 'track name')

      if (!candidates.length) {
        throw new Error('No track titles were found. Use a CSV with Track/Title and optional Artist columns.')
      }

      const imported: Track[] = []
      let unmatched = 0
      for (let index = 0; index < candidates.length; index += 1) {
        const item = candidates[index]
        setImportStatus(`Matching track ${index + 1} of ${candidates.length}: ${item.title}`)
        try {
          const response = await apiFetch('/api/music/search', {
            method: 'POST',
            body: JSON.stringify({ query: [item.title, item.artist].filter(Boolean).join(' ') }),
          })
          const data = await readJson<{ tracks?: Track[] }>(response)
          const matched = choosePlaylistMatch(data?.tracks || [], item.title, item.artist)
          if (matched) {
            // Preserve every source row, including intentional duplicate tracks.
            imported.push({ ...matched, id: `import-${index}-${matched.id}` })
          } else {
            // Keep unmatched songs in the playlist instead of silently dropping
            // them. They remain visible and can be searched/resolved later.
            unmatched += 1
            imported.push({
              id: `import-unmatched-${Date.now()}-${index}`,
              name: item.title,
              artist: item.artist || 'Not matched in current music catalog',
              provider: 'unmatched',
            })
          }
        } catch {
          unmatched += 1
          imported.push({
            id: `import-unmatched-${Date.now()}-${index}`,
            name: item.title,
            artist: item.artist || 'Not matched in current music catalog',
            provider: 'unmatched',
          })
        }
      }
      if (!imported.length) throw new Error('No track titles were found in the selected file.')
      const suggestedName = file.name.replace(/\.(csv|txt)$/i, '').replace(/[_-]+/g, ' ').trim() || 'Imported playlist'
      const existing = playlists.find(item => item.name.toLowerCase() === suggestedName.toLowerCase())
      const name = existing
        ? (window.confirm(`A playlist named "${suggestedName}" already exists. Replace it with the imported tracks?`)
            ? suggestedName
            : `${suggestedName} (imported ${new Date().toLocaleDateString()})`)
        : suggestedName
      const next = [...playlists.filter(item => item.name.toLowerCase() !== name.toLowerCase()), { name, tracks: imported }]
      persistPlaylists(next)
      rememberSelectedPlaylist(name)
      setPlaylistName(name)
      setImportStatus(`Imported ${imported.length} of ${candidates.length} tracks into "${name}". ${unmatched ? `${unmatched} track(s) could not be matched.` : 'All tracks matched.'}`)
    } catch (error) {
      setImportStatus(error instanceof Error ? error.message : 'Playlist import failed.')
    } finally {
      setImportBusy(false)
    }
  }

  useEffect(() => {
    const handleVoiceCommand = (event: Event) => {
      const detail = (event as CustomEvent<{
        text?: string
        activeTab?: string
        intent?: string
        action?: string
        query?: string
      }>).detail
      if (detail?.activeTab !== 'music') return

      const text = (detail.text || '').toLowerCase().replace(/[.!?,]+/g, ' ').replace(/\s+/g, ' ').trim()
      const controlCommand = text.replace(/\s+(song|music)$/, '')
      const action = (detail.action || '').toLowerCase()

      // The AI already classified the meaning. Execute its structured action/query
      // instead of trying to re-parse the full sentence with brittle phrase rules.
      if (action === 'pause' || /^(pause|stop)( music)?$/.test(controlCommand)) { speakText('Pausing music.'); void control('pause'); return }
      if (action === 'resume' || /^(resume|continue)( music)?$/.test(controlCommand)) {
        if (current) { speakText('Resuming music.'); void control('resume'); return }
        if (selectedPlaylistName) { speakText(`Resuming your ${selectedPlaylistName} playlist.`); playPlaylistByName(selectedPlaylistName); return }
        setMessage('Nothing is playing yet. Say which song or playlist you want.')
        speakText('Nothing is playing yet. Tell me which song or playlist you want.')
        return
      }
      if (action === 'next' || /^(next|skip|play next)( song)?$/.test(controlCommand)) { speakText('Skipping to the next track.'); void control('next'); return }
      if (action === 'previous' || /^(previous|prev|back|last|play previous)( song)?$/.test(controlCommand)) { speakText('Playing the previous track.'); void control('previous'); return }

      const removeMatch = text.match(/^(?:remove|delete)\s+(.+?)\s+from\s+(?:the\s+)?playlist(?:\s+(.+))?$/)
      if (removeMatch) {
        const songName = removeMatch[1].trim()
        const targetPlaylist = removeMatch[2]
          ? playlists.find(item => item.name.toLowerCase() === removeMatch[2].trim())
          : playlists.find(item => item.name === selectedPlaylistName)
        const playlist = targetPlaylist || playlists.find(item => item.tracks.some(track => track.name.toLowerCase().includes(songName)))
        if (!playlist) { setMessage('I could not find that playlist. Open Music to see your saved playlists.'); speakText('I could not find that playlist.'); return }
        const index = playlist.tracks.findIndex(track => track.name.toLowerCase().includes(songName))
        if (index < 0) { setMessage(`I could not find "${songName}" in ${playlist.name}.`); speakText(`I could not find ${songName} in ${playlist.name}.`); return }
        removeSavedTrack(playlist.name, index)
        return
      }

      const rawTarget = detail.query?.trim() || ''
      if (action === 'open' && !rawTarget) {
        setMessage('Music is ready. Choose a saved playlist or search for a song when you want playback to start.')
        speakText('Music is ready. Tell me a song or playlist to play.')
        return
      }
      const target = rawTarget || (() => {
        const match = text.match(/^(?:play|put on|listen to|start playing|i want to listen to|i would like to listen to|can you play|could you play)\s+(.+)$/)
        return match?.[1]?.trim() || ''
      })()
      const normalizedTarget = target
        .toLowerCase()
        .replace(/^(?:i want to listen to|i would like to listen to|i want|please play|play|put on|listen to|start playing|some|the|a|my)\s+/, '')
        .replace(/\b(?:the|playlist)\b/g, '')
        .replace(/\s+(?:music|song|track)$/, '')
        .replace(/\s+/g, ' ')
        .trim()

      // A pronoun-only request such as "play it again" means resume the current
      // track; never send it to AI or search YouTube for the word "it".
      if (!normalizedTarget || /^(it|that|this|that again|it again|music|song|something)$/.test(normalizedTarget)) {
        if (current) { speakText('Resuming music.'); void control('resume'); return }
        if (selectedPlaylistName) { speakText(`Playing your ${selectedPlaylistName} playlist.`); playPlaylistByName(selectedPlaylistName); return }
        setMessage('Nothing is playing yet. Say the song or playlist name you want.')
        speakText('Nothing is playing yet. Tell me the song or playlist name you want.')
        return
      }

      // Saved playlist names take priority over external search. Exact match first.
      const playlist = playlists.find(item => item.name.trim().toLowerCase() === normalizedTarget) ||
        playlists.find(item => item.name.trim().toLowerCase().includes(normalizedTarget)) ||
        playlists.find(item => normalizedTarget.includes(item.name.trim().toLowerCase()))
      if (playlist) {
        if (!playlist.tracks.length) {
          setMessage(`Your "${playlist.name}" playlist is empty.`)
          speakText(`Your ${playlist.name} playlist is empty.`)
          return
        }
        speakText(`Playing your ${playlist.name} playlist.`)
        playPlaylistByName(playlist.name)
        return
      }

      // If the requested song is already in any saved playlist, play that saved
      // track from its playlist sequence instead of creating a transient result.
      const containingPlaylist = playlists.find(item =>
        item.tracks.some(track => track.name.toLowerCase() === normalizedTarget ||
          track.name.toLowerCase().includes(normalizedTarget))
      )
      if (containingPlaylist) {
        const index = containingPlaylist.tracks.findIndex(track =>
          track.name.toLowerCase() === normalizedTarget || track.name.toLowerCase().includes(normalizedTarget)
        )
        speakText(`Playing ${containingPlaylist.tracks[index]?.name || normalizedTarget}.`)
        playSavedTrack(containingPlaylist, index)
        return
      }

      speakText(action === 'search' || action === 'open' ? `Searching for ${normalizedTarget}.` : `Searching for ${normalizedTarget} and starting playback.`)
      void searchTracksByTerm(normalizedTarget, action !== 'search' && action !== 'open')
    }

    window.addEventListener('visionary:voice-command', handleVoiceCommand)
    return () => window.removeEventListener('visionary:voice-command', handleVoiceCommand)
  }, [playlists, selectedPlaylistName, current, position])

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-widest text-white">MUSIC</h1>
          <div className="font-mono text-xs text-white/30 tracking-widest mt-0.5 uppercase">
            Full-track playback | Audius | Navidrome | YouTube
          </div>
        </div>
        <div className="glass rounded-full px-4 py-2 flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${config.configured ? 'bg-green-400' : 'bg-amber-400'}`} />
          <span className="font-mono text-[10px] uppercase tracking-widest text-white/60">
            {config.provider} | {config.configured ? 'configured' : 'not configured'}
          </span>
        </div>
      </div>

      {!config.configured && (
        <div className="font-mono text-xs px-4 py-3 border border-amber-400/30 text-amber-200 bg-amber-500/10">
          {config.message}
        </div>
      )}

      {message && (
        <div className="font-mono text-xs px-4 py-3 border border-green-400/30 text-green-100 bg-green-500/10">{message}</div>
      )}

      <form onSubmit={event => void searchTracks(event)} className="flex gap-3">
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search for a song or artist..."
          className="flex-1 bg-black/30 border border-white/15 px-4 py-3 text-white text-sm"
        />
        <button
          type="submit"
          disabled={busy || !query.trim()}
          className="px-5 py-3 rounded-xl font-display text-[11px] tracking-widest border border-green-400/40 text-green-200 disabled:opacity-40"
        >
          {busy ? 'SEARCHING' : 'SEARCH'}
        </button>
      </form>

      {/* Now playing */}
      <div className="glass rounded-2xl p-5">
        <div className="font-display text-xs tracking-widest text-white/50 uppercase mb-4">Now Playing</div>
        <div className="mb-5 space-y-3">
          <label htmlFor="playlist-name" className="block font-mono text-[10px] tracking-widest text-white/40 uppercase">Playlist name</label>
          <div className="flex flex-col sm:flex-row gap-2">
            <input id="playlist-name" value={playlistName} onChange={event => setPlaylistName(event.target.value)} list="saved-playlist-names" placeholder="Type a playlist name to play it..." className="flex-1 min-w-0 bg-black/30 border border-white/15 px-4 py-3 text-white text-sm rounded-lg" />
            <datalist id="saved-playlist-names">{playlists.map(playlist => <option key={playlist.name} value={playlist.name} />)}</datalist>
            <button type="button" onClick={playPlaylist} className="px-4 py-3 rounded-lg border border-green-400/40 text-green-200 text-xs">PLAY PLAYLIST</button>
            <button type="button" onClick={savePlaylist} className="px-4 py-3 rounded-lg border border-white/15 text-white/70 text-xs">SAVE QUEUE</button>
          </div>
          <p className="font-mono text-[10px] text-white/35">Save the current queue, or load an existing playlist below to edit it. While editing, queue more search results, reorder tracks, then save with the same name.</p>
          {editingPlaylistName && <div className="flex items-center justify-between gap-3 rounded-lg border border-green-400/30 bg-green-400/5 px-3 py-2"><span className="font-mono text-[10px] text-green-200">EDITING: {editingPlaylistName}</span><button type="button" onClick={() => { setEditingPlaylistName(null); setPlaylistName('') }} className="text-[10px] text-white/60">CANCEL EDIT</button></div>}
        </div>
        {current ? (
          <div className="space-y-4">
          <div className="flex items-center gap-4">
            {current.image && <img src={current.image} alt="" className="w-16 h-16 rounded-lg object-cover border border-white/10" />}
            <div className="flex-1 min-w-0">
              <div className="text-sm text-white font-medium truncate">{current.name}</div>
              <div className="text-xs text-white/60 truncate">{current.artist || 'Unknown artist'}{current.album ? `  - ${current.album}` : ''}</div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => void control('previous')} className="px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-xs">Previous</button>
              {!(current.provider?.toLowerCase() === 'youtube' && current.videoId) && <button onClick={() => void control(playing ? 'pause' : 'resume')} className="px-3 py-2 rounded-lg border border-green-400/40 bg-green-400/10 text-xs text-green-200">
                {playing ? 'Pause' : 'Resume'}
              </button>}
              <button onClick={() => void control('next')} className="px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-xs">Next</button>
            </div>
          </div>
          {current.provider?.toLowerCase() === 'youtube' && current.videoId ? (
            <div ref={youtubeContainerRef} className="w-full overflow-hidden rounded-xl border border-white/10 bg-black aspect-video" />
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between font-mono text-[10px] text-white/40"><span>{formatDuration(position * 1000)}</span><span>{formatDuration(audioDuration * 1000)}</span></div>
              <input aria-label="Seek song position" type="range" min={0} max={Math.max(audioDuration, 0)} step={1} value={Math.min(position, audioDuration || 0)} disabled={!audioDuration} onChange={event => { const next = Number(event.target.value); if (audioRef.current) { audioRef.current.currentTime = next; setPosition(next) } }} className="w-full disabled:opacity-40" style={{ accentColor: '#1ed760' }} />
            </div>
          )}
          </div>
        ) : (
          <p className="font-mono text-xs text-white/40">Nothing is playing yet. Search for a track to start.</p>
        )}
        <div className="mt-4 flex items-center gap-3">
          <span className="font-mono text-[10px] text-white/40 uppercase tracking-widest w-16">Volume</span>
          <input type="range" min={0} max={100} value={volume} onChange={event => setVolume(Number(event.target.value))} className="flex-1" style={{ accentColor: '#1ed760' }} />
          <span className="font-mono text-xs text-green-400 w-10 text-right">{volume}%</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Search results */}
        <div className="glass rounded-2xl p-5">
          <div className="font-display text-xs tracking-widest text-white/50 uppercase mb-4">Search Results ({tracks.length})</div>
          {tracks.length === 0 ? (
            <p className="font-mono text-xs text-white/40">No results yet. Try "Bohemian Rhapsody" or any artist.</p>
          ) : (
            <div className="space-y-2">
              {tracks.map(track => (
                <div key={track.id} className="flex items-center gap-3 p-2 rounded-xl hover:bg-white/5 transition-all">
                  <button onClick={() => void playTrack(track)} className="w-9 h-9 rounded-lg bg-green-400/10 border border-green-400/30 text-green-300 text-xs flex-shrink-0">▶</button>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-white truncate">{track.name}</div>
                    <div className="text-[10px] text-white/50 truncate">{track.artist}{track.genre ? `  - ${track.genre}` : ''}</div>
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
                <div
                  key={`${track.id}-${index}`}
                  draggable
                  onDragStart={event => { setDraggingQueueIndex(index); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(index)) }}
                  onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }}
                  onDrop={event => { event.preventDefault(); const sourceIndex = Number(event.dataTransfer.getData('text/plain')); if (Number.isInteger(sourceIndex)) reorderQueueItem(sourceIndex, index); setDraggingQueueIndex(null) }}
                  onDragEnd={() => setDraggingQueueIndex(null)}
                  className={`flex items-center gap-3 p-2 rounded-xl border border-transparent hover:bg-white/5 transition-all cursor-grab active:cursor-grabbing ${draggingQueueIndex === index ? 'opacity-40 border-green-400/40' : ''}`}
                  title="Drag to reorder"
                >
                  <span aria-label="Drag to reorder" className="text-white/35 select-none">⠿</span>
                  <span className="font-mono text-[10px] text-white/30 w-5">{index + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-white truncate">{track.name}</div>
                    <div className="text-[10px] text-white/50 truncate">{track.artist}</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button aria-label={`Move ${track.name} up`} title="Move up" disabled={index === 0} onClick={() => moveQueueItem(index, -1)} className="px-2 py-1 rounded border border-white/10 text-[10px] text-white/60 disabled:opacity-20">↑</button>
                    <button aria-label={`Move ${track.name} down`} title="Move down" disabled={index === queue.length - 1} onClick={() => moveQueueItem(index, 1)} className="px-2 py-1 rounded border border-white/10 text-[10px] text-white/60 disabled:opacity-20">↓</button>
                    <button onClick={() => setQueue(previous => {
                      const updated = previous.filter((_, i) => i !== index)
                      queueRef.current = updated
                      return updated
                    })} className="px-2 py-1 rounded border border-white/10 text-[10px] text-white/60">Remove</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="glass rounded-2xl p-5 space-y-3">
        <div>
          <div className="font-display text-xs tracking-widest text-white/70 uppercase">Import from another music service</div>
          <p className="mt-2 text-xs text-white/45">Use TuneMyMusic to transfer or export your playlist, then import a CSV/TXT track list here. Visionary Nexus matches each track against the currently configured catalog.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <a href="https://www.tunemymusic.com/" target="_blank" rel="noreferrer" className="rounded-lg border border-green-400/35 px-3 py-2 text-xs text-green-200 hover:bg-green-400/10">Open TuneMyMusic</a>
          <label className={`rounded-lg border border-white/15 px-3 py-2 text-xs text-white/80 cursor-pointer ${importBusy ? 'opacity-40 pointer-events-none' : 'hover:bg-white/5'}`}>
            {importBusy ? 'IMPORTING...' : 'IMPORT CSV / TXT'}
            <input type="file" accept=".csv,.txt,text/csv,text/plain" className="hidden" disabled={importBusy} onChange={event => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file) void importPlaylistFile(file)
            }} />
          </label>
        </div>
        {importStatus && <p role="status" className="text-xs text-green-100/80">{importStatus}</p>}
      </div>

      <div className="glass rounded-2xl p-5">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div>
            <div className="font-display text-xs tracking-widest text-white/70 uppercase">Your playlists</div>
            <div className="text-xs text-white/40 mt-1">Choose a playlist to see every song, play any track, or remove a song.</div>
          </div>
          <span className="rounded-full bg-white/5 px-3 py-1 text-xs text-white/50">{playlists.length} playlists</span>
        </div>
        {playlists.length === 0 ? (
          <p className="font-mono text-xs text-white/40">No saved playlists yet. Queue a few songs, enter a name above, and press Save Queue.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-4">
            {playlists.map(playlist => (
              <article key={playlist.name} className="group min-w-0 rounded-xl border border-white/5 bg-[#181818] p-3 transition-colors hover:bg-[#242424]">
                <button type="button" onClick={() => rememberSelectedPlaylist(playlist.name)} className="block w-full text-left">
                  {playlist.tracks[0]?.image ? (
                    <img src={playlist.tracks[0].image} alt="" className="aspect-square w-full rounded-lg object-cover shadow-lg" />
                  ) : (
                    <div className="aspect-square w-full rounded-lg bg-gradient-to-br from-emerald-500/70 via-green-900 to-black flex items-center justify-center text-4xl text-white/80">♫</div>
                  )}
                  <span className="mt-3 block truncate font-semibold text-white">{playlist.name}</span>
                  <span className="mt-1 block text-sm text-white/45">{playlist.tracks.length} {playlist.tracks.length === 1 ? 'song' : 'songs'}</span>
                </button>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => playPlaylistByName(playlist.name)} aria-label={`Play ${playlist.name}`} className="flex h-10 w-10 items-center justify-center rounded-full bg-[#1ed760] text-lg font-bold text-black shadow-lg transition-transform hover:scale-105">▶</button>
                  <button type="button" onClick={() => { setPlaylistName(playlist.name); setEditingPlaylistName(playlist.name); queueRef.current = [...playlist.tracks]; setQueue([...playlist.tracks]); setMessage(`Editing "${playlist.name}". Add songs from Search Results, reorder the queue, then save.`) }} className="rounded-lg px-2 py-2 text-xs text-white/55 hover:bg-white/10 hover:text-white">Edit</button>
                  <button type="button" onClick={() => renamePlaylist(playlist.name)} aria-label={`Rename ${playlist.name}`} className="rounded-lg px-2 py-2 text-xs text-white/55 hover:bg-white/10 hover:text-white">Rename</button>
                  <button type="button" onClick={() => { if (window.confirm(`Delete "${playlist.name}"?`)) { persistPlaylists(playlists.filter(item => item.name !== playlist.name)); if (editingPlaylistName === playlist.name) setEditingPlaylistName(null); if (renamingPlaylistName === playlist.name) setRenamingPlaylistName(null); setMessage(`Deleted playlist "${playlist.name}".`) } }} aria-label={`Delete ${playlist.name}`} className="ml-auto rounded-lg px-2 py-2 text-xs text-white/35 hover:bg-red-500/10 hover:text-red-300">Delete</button>
                </div>
                {renamingPlaylistName === playlist.name && (
                  <form className="mt-3 flex flex-col gap-2" onSubmit={event => { event.preventDefault(); commitPlaylistRename(playlist.name) }}>
                    <label className="text-xs text-white/60" htmlFor={`rename-playlist-${playlist.name}`}>New playlist name</label>
                    <input id={`rename-playlist-${playlist.name}`} autoFocus value={renameDraft} onChange={event => setRenameDraft(event.target.value)} className="w-full min-w-0 rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white" maxLength={80} />
                    <div className="flex gap-2">
                      <button type="submit" className="rounded-lg bg-green-400/15 px-3 py-2 text-xs text-green-200">Save name</button>
                      <button type="button" onClick={() => { setRenamingPlaylistName(null); setRenameDraft('') }} className="rounded-lg px-3 py-2 text-xs text-white/60 hover:bg-white/10">Cancel</button>
                    </div>
                  </form>
                )}
              </article>
            ))}
          </div>
        )}
      </div>

      {selectedPlaylistName && playlists.some(item => item.name === selectedPlaylistName) && (() => {
        const playlist = playlists.find(item => item.name === selectedPlaylistName)!
        return (
          <section className="glass rounded-2xl p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-white">{playlist.name}</h2>
                <p className="text-xs text-white/45">{playlist.tracks.length} songs | Click any song to play it</p>
              </div>
              <button type="button" onClick={() => { setPlaylistName(playlist.name); setEditingPlaylistName(playlist.name); queueRef.current = [...playlist.tracks]; setQueue([...playlist.tracks]); setMessage('Editing ' + playlist.name + '. Add songs from Search Results, then save.') }} className="rounded-lg border border-green-400/30 px-3 py-2 text-xs text-green-200">Edit playlist</button>
            </div>
            {playlist.tracks.length === 0 ? (
              <p className="rounded-xl bg-white/5 p-4 text-sm text-white/45">This playlist is empty. Edit it and add songs from Search Results.</p>
            ) : playlist.tracks.map((track, index) => (
              <div
                key={String(track.id) + '-' + index}
                draggable={editingPlaylistName === playlist.name}
                onDragStart={event => { if (editingPlaylistName !== playlist.name) { event.preventDefault(); return }; setDraggingPlaylistTrackIndex(index); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(index)) }}
                onDragOver={event => { if (editingPlaylistName === playlist.name) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }}
                onDrop={event => { if (editingPlaylistName !== playlist.name) return; event.preventDefault(); const from = Number(event.dataTransfer.getData('text/plain')); if (Number.isInteger(from)) reorderSavedPlaylistTrack(playlist.name, from, index); setDraggingPlaylistTrackIndex(null) }}
                onDragEnd={() => setDraggingPlaylistTrackIndex(null)}
                className={`flex items-center gap-3 rounded-xl p-3 hover:bg-white/5 ${editingPlaylistName === playlist.name ? 'cursor-grab active:cursor-grabbing' : ''} ${draggingPlaylistTrackIndex === index ? 'opacity-40 border border-green-400/40' : ''}`}
                title={editingPlaylistName === playlist.name ? 'Drag to reorder playlist tracks' : undefined}
              >
                {editingPlaylistName === playlist.name && <span className="select-none text-white/35" aria-label="Drag to reorder">⠿</span>}
                <span className="w-6 text-xs text-white/35">{index + 1}</span>
                {track.image && <img src={track.image} alt="" className="h-11 w-11 rounded-lg object-cover" />}
                <button type="button" onClick={() => playSavedTrack(playlist, index)} className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-sm text-white">{track.name}</span>
                  <span className="block truncate text-xs text-white/50">{track.artist || 'Unknown artist'}</span>
                </button>
                <span className="hidden text-xs text-white/35 sm:inline">{formatDuration(track.duration)}</span>
                {editingPlaylistName === playlist.name && <div className="flex items-center gap-1"><button type="button" aria-label={`Move ${track.name} up in playlist`} title="Move up" disabled={index === 0} onClick={() => reorderSavedPlaylistTrack(playlist.name, index, index - 1)} className="rounded border border-white/10 px-2 py-1 text-xs text-white/60 disabled:opacity-20">↑</button><button type="button" aria-label={`Move ${track.name} down in playlist`} title="Move down" disabled={index === playlist.tracks.length - 1} onClick={() => reorderSavedPlaylistTrack(playlist.name, index, index + 1)} className="rounded border border-white/10 px-2 py-1 text-xs text-white/60 disabled:opacity-20">↓</button></div>}
                <button type="button" title={'Play ' + track.name} aria-label={'Play ' + track.name} onClick={() => playSavedTrack(playlist, index)} className="rounded-lg border border-green-400/30 px-3 py-2 text-xs text-green-200">▶</button>
                <button type="button" title={'Remove ' + track.name + ' from ' + playlist.name} aria-label={'Remove ' + track.name + ' from ' + playlist.name} onClick={() => removeSavedTrack(playlist.name, index)} className="rounded-lg border border-red-400/20 px-3 py-2 text-xs text-red-200 hover:bg-red-400/10">Remove</button>
              </div>
            ))}
          </section>
        )
      })()}
    </div>
  )
}
