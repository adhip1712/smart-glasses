import { useEffect, useRef, useState } from 'react'
import { apiFetch, readJson } from '../services/api'
import { speakText } from '../services/speech'
import {
  beginNamedYouTubeSearch,
  findSavedPlaylist,
  isValidYouTubeVideoId,
  navigateNamedYouTubeWindow,
  openNamedYouTubeWindow,
  resolveYouTubePlayback,
  YOUTUBE_WINDOW_NAME,
  youtubePlaybackUrl,
  youtubeSearchUrl,
  clearPendingMusicCommand,
  consumePendingMusicCommand,
  type MusicCommandEventDetail,
} from '../services/voiceMusic'

type YouTubeTrack = {
  id: string
  name: string
  artist: string
  image?: string
  url?: string
  provider?: string
  durationSeconds?: number
  youtubePlaylistId?: string
  youtubePlaylistUrl?: string
}

const trackIdentity = (track: YouTubeTrack) =>
  (track.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + '|' +
  (track.artist || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

const dedupeTracks = (tracks: YouTubeTrack[]) => {
  const seenIds = new Set<string>()
  const seenTitles = new Set<string>()
  return tracks.filter(track => {
    if (!track?.id) return false
    const identity = trackIdentity(track)
    if (seenIds.has(track.id) || (identity !== '|' && seenTitles.has(identity))) return false
    seenIds.add(track.id)
    seenTitles.add(identity)
    return true
  })
}

const normalizedWords = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/ +/).filter(Boolean)

const bestFullSongMatch = (query: string, candidates: YouTubeTrack[]) => {
  // Treat the complete CSV value as the song title. Hyphens often separate
  // version labels (for example "MONTAGEM ELDER - ULTRA SLOWED"), not artists.
  // Match against the video title only: the uploader/channel/artist is irrelevant.
  const titleWords = normalizedWords(query)
    .filter(word => !['the', 'a', 'an', 'song', 'official', 'audio', 'track', 'by'].includes(word))
  if (!titleWords.length) return null
  const matching = candidates.filter(track => {
    const candidateWords = new Set(normalizedWords(track.name))
    return titleWords.every(word => candidateWords.has(word)) &&
      !(track.durationSeconds && track.durationSeconds <= 60) &&
      !(track.durationSeconds && track.durationSeconds > 900) &&
      !/(shorts|#shorts|1\s*hour|one\s*hour|60\s*min|extended\s*mix|\bloop\b)/i.test(track.name)
  })
  // Exact title wins; otherwise require every requested title word. Channel
  // and artist metadata never affect matching or ranking.
  const normalizedQuery = titleWords.join(' ')
  return matching.sort((a, b) => {
    const exactA = normalizedWords(a.name).join(' ') === normalizedQuery ? 1 : 0
    const exactB = normalizedWords(b.name).join(' ') === normalizedQuery ? 1 : 0
    if (exactA !== exactB) return exactB - exactA
    const durationRank = (seconds?: number) => !seconds ? 2 : seconds >= 90 && seconds <= 600 ? 0 : 1
    const rankDifference = durationRank(a.durationSeconds) - durationRank(b.durationSeconds)
    if (rankDifference) return rankDifference
    return Math.abs((a.durationSeconds || 240) - 240) - Math.abs((b.durationSeconds || 240) - 240)
  })[0] || null
}

type SavedPlaylist = { name: string; tracks: YouTubeTrack[]; youtubePlaylistId?: string; youtubePlaylistUrl?: string }
type StoredPlaylist = { name: string; tracks: any[]; youtubePlaylistId?: string; youtubePlaylistUrl?: string }
type Props = { onSpotify?: () => void }

export default function YouTubeMusic({ onSpotify }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<YouTubeTrack[]>([])
  const [current, setCurrent] = useState<YouTubeTrack | null>(null)
  const [message, setMessage] = useState('Search, build queues and manage playlists in Visionary Nexus.')
  const [blockedYoutubeUrl, setBlockedYoutubeUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [playlists, setPlaylists] = useState<SavedPlaylist[]>([])
  const [allSavedPlaylists, setAllSavedPlaylists] = useState<StoredPlaylist[]>([])
  const [playlistsLoaded, setPlaylistsLoaded] = useState(false)
  const [playlistName, setPlaylistName] = useState('')
  const [selectedPlaylistByTrack, setSelectedPlaylistByTrack] = useState<Record<string, string>>({})
  const [editingPlaylistName, setEditingPlaylistName] = useState('')
  const [playlistNameDraft, setPlaylistNameDraft] = useState('')
  const draggedTrackIdRef = useRef<string | null>(null)
  const [playerKey, setPlayerKey] = useState(0)
  const [fallbackMessage, setFallbackMessage] = useState('')
  const [fallbackUrl, setFallbackUrl] = useState('')
  const [activePlaylistName, setActivePlaylistName] = useState('')
  const [selectedTracks, setSelectedTracks] = useState<string[]>([])
  const [missingImportTracks, setMissingImportTracks] = useState<string[]>([])
  const [repeatPlaylist, setRepeatPlaylist] = useState(false)
  const [shuffleQueue, setShuffleQueue] = useState(false)
  const [youtubeAccount, setYoutubeAccount] = useState<{ configured: boolean; connected: boolean; channel?: string }>({ configured: false, connected: false })
  const queueRef = useRef<YouTubeTrack[]>([])
  const [queueItems, setQueueItems] = useState<YouTubeTrack[]>([])
  const replaceQueue = (tracks: YouTubeTrack[]) => {
    queueRef.current = tracks
    setQueueItems([...tracks])
  }
  const refreshQueue = () => setQueueItems([...queueRef.current])

  const historyRef = useRef<YouTubeTrack[]>([])
  const currentTrackRef = useRef<YouTubeTrack | null>(null)
  const handledCommandIdsRef = useRef(new Set<number>())
  const youtubePlayerRef = useRef<any>(null)
  const youtubePlayerReadyRef = useRef(false)
  const pendingVideoIdRef = useRef<string | null>(null)
  const restorePositionRef = useRef<number | null>(null)
  const pendingResumeRef = useRef(false)
  const activePlaylistNameRef = useRef('')
  activePlaylistNameRef.current = activePlaylistName

  const navigateResult = (url: string) => {
    const navigated = navigateNamedYouTubeWindow(url)
    if (navigated) {
      setBlockedYoutubeUrl('')
      return true
    }
    setBlockedYoutubeUrl(url)
    setMessage('Your browser blocked the YouTube tab. Select Open YouTube to continue.')
    return false
  }

  const announceVoicePlayback = (source: MusicCommandEventDetail['source'], title: string) => {
    if (source === 'voice') speakText(`Playing ${title}.`)
  }

  useEffect(() => {
    let cancelled = false
    const refreshYouTubeStatus = () => { void apiFetch('/api/music/youtube-oauth/status').then(response => readJson<any>(response)).then(data => { if (!cancelled && data) setYoutubeAccount({ configured: !!data.configured, connected: !!data.connected, channel: data.channel || '' }) }).catch(() => {}) }
    refreshYouTubeStatus()
    window.addEventListener('focus', refreshYouTubeStatus)
    void apiFetch('/api/music/playlists')
      .then(response => readJson<{ playlists?: SavedPlaylist[] }>(response))
      .then(data => {
        if (!cancelled && Array.isArray(data?.playlists)) {
          const restored = data.playlists.map(item => ({
            ...item,
            tracks: dedupeTracks((item.tracks || []).filter(track => track?.id && (!track.provider || track.provider.toLowerCase() === 'youtube')).map(track => ({ ...track, provider: 'youtube' }))),
            youtubePlaylistId: item.youtubePlaylistId || item.tracks?.find(track => track?.youtubePlaylistId)?.youtubePlaylistId,
            youtubePlaylistUrl: item.youtubePlaylistUrl || item.tracks?.find(track => track?.youtubePlaylistUrl)?.youtubePlaylistUrl,
          }))
          setAllSavedPlaylists(restored as StoredPlaylist[])
          // Keep empty playlists visible so songs can be added to them.
          setPlaylists(restored as SavedPlaylist[])
        }
        if (!cancelled) setPlaylistsLoaded(true)
      })
      .catch(() => { if (!cancelled) setPlaylistsLoaded(true) })
    return () => {
      cancelled = true
      window.removeEventListener('focus', refreshYouTubeStatus)
    }
  }, [])

  const connectYouTube = async () => {
    const tab = window.open('about:blank', '_blank')
    try {
      const response = await apiFetch('/api/music/youtube-oauth/start')
      const data = await readJson<any>(response)
      if (!response.ok || !data?.authorization_url) throw new Error(data?.detail || 'Could not start YouTube authorization.')
      if (!tab) throw new Error('Allow pop-ups for Visionary Nexus, then click Connect YouTube again.')
      tab.location.href = data.authorization_url
      setMessage('Finish Google authorization, then return to Visionary Nexus.')
    } catch (error) {
      try { if (tab && !tab.closed) tab.close() } catch {}
      setMessage(error instanceof Error ? error.message : 'YouTube connection failed.')
    }
  }

  // Keep the request on YouTube if its primary API quota is unavailable.
  const searchYouTubeAlternatives = async (term: string, autoplay = false, voiceCommand = false) => {
    setMessage('YouTube API quota exhausted. Trying Piped, then Invidious...')
    try {
      const response = await apiFetch('/api/music/youtube-alternative-search?q=' + encodeURIComponent(term) + '&limit=18')
      const data = await readJson<{ success?: boolean; tracks?: YouTubeTrack[]; source?: string; message?: string }>(response)
      const found = (data?.tracks || []).filter(track => track?.provider?.toLowerCase() === 'youtube' && isValidYouTubeVideoId(track.id))
      if (response.ok && data?.success && found.length) {
        setResults(found)
        setMessage(data.message || 'Found YouTube results through an alternative search source.')
        if (autoplay) {
          const safe = found.filter(track =>
            !(track.durationSeconds && track.durationSeconds > 900) &&
            !/(1\s*hour|one\s*hour|60\s*min|extended\s*mix|\bloop\b)/i.test(track.name)
          )
          const preferred = bestFullSongMatch(term, safe)
          if (!preferred) {
            setMessage('I found results, but none is a confident normal-length song match. Choose the correct result instead of starting a possible long mix.')
            return
          }
          const ordered = [preferred, ...safe.filter(track => track.id !== preferred.id)]
          if (playTrack(preferred, ordered) && voiceCommand) {
            announceVoicePlayback('voice', term)
          }
        }
        return
      }
    } catch (error) {
      console.warn('Alternative YouTube catalogue search failed:', error)
    }
    setResults([])
    setMessage('YouTube catalogue search is unavailable. Opening YouTube search directly...')
    const resolved = await resolveYouTubePlayback(term, [], true, async () => [])
    navigateResult(resolved.url)
  }

  const playTrack = (track: YouTubeTrack, sequence?: YouTubeTrack[], recordHistory = true) => {
    if (!track) return
    const previousTrack = currentTrackRef.current
    setCurrent(track)
    currentTrackRef.current = track
    setFallbackMessage('')
    if (sequence) setActivePlaylistName('')
    if (recordHistory && previousTrack?.id && previousTrack.id !== track.id) historyRef.current.push(previousTrack)
    if (sequence) {
      const index = sequence.findIndex(item => item.id === track.id)
      const nextQueue = index >= 0 ? sequence.slice(index + 1) : []
      replaceQueue(shuffleQueue ? [...nextQueue].sort(() => Math.random() - 0.5) : nextQueue)
    }

    if (!isValidYouTubeVideoId(track.id)) {
      setMessage('This playlist entry has no valid YouTube video ID. Search for the track again.')
      return false
    }
    pendingVideoIdRef.current = track.id
    if (youtubePlayerReadyRef.current && youtubePlayerRef.current) {
      youtubePlayerRef.current.loadVideoById(track.id)
      pendingVideoIdRef.current = null
    }
    setBlockedYoutubeUrl('')
    setMessage(`Playing ${track.name} — ${track.artist} in Visionary Nexus.`)
    return true
  }

  const search = async (term: string, autoplay = false, displayText = "", voiceCommand = false) => {
    const clean = term.trim()
    if (!clean) return

    // A typed playlist name should open the saved playlist, not be sent to
    // YouTube search where it can match a one-hour playlist/mix video.
    // Avoid racing the initial playlist restore: a name typed immediately
    // after opening Music must still resolve to the saved playlist.
    let availablePlaylists = allSavedPlaylists
    if (!playlistsLoaded) {
      try {
        const response = await apiFetch('/api/music/playlists')
        const data = await readJson<{ playlists?: StoredPlaylist[] }>(response)
        availablePlaylists = Array.isArray(data?.playlists) ? data.playlists : []
        availablePlaylists = availablePlaylists.map(item => ({
          ...item,
          tracks: dedupeTracks((item.tracks || [])
            .filter(track => track?.id && (!track.provider || track.provider.toLowerCase() === 'youtube'))
            .map(track => ({ ...track, provider: 'youtube' }))),
        }))
        setAllSavedPlaylists(availablePlaylists)
        setPlaylists(availablePlaylists as SavedPlaylist[])
      } catch {
        // Continue with the last known local state if the API is temporarily unavailable.
      } finally {
        setPlaylistsLoaded(true)
      }
    }
    const savedPlaylist = findSavedPlaylist(clean, availablePlaylists)
    if (savedPlaylist) {
      const tracks = (savedPlaylist.tracks || []).filter(track => track && (track.name || track.id)) as YouTubeTrack[]
      if (!tracks.length) {
        setMessage('The saved playlist "' + savedPlaylist.name + '" has no tracks.')
        return
      }
      setActivePlaylistName(savedPlaylist.name)
      historyRef.current = []
      replaceQueue(tracks.slice(1))
      const first = tracks[0]
      if (isValidYouTubeVideoId(first.id)) {
        playTrack(first)
        setMessage('Playing playlist "' + savedPlaylist.name + '".')
        if (voiceCommand) announceVoicePlayback('voice', savedPlaylist.name)
      } else {
        void search([first.name, first.artist].filter(Boolean).join(' - ') || first.name || savedPlaylist.name, true, displayText || clean, voiceCommand)
      }
      return
    }

    // Search and playback stay inside the embedded player. Opening a
    // separate YouTube tab here breaks queue control and automatic next-track.
    const tabOpened = true
    setBlockedYoutubeUrl('')
    setQuery(displayText.trim() || clean)
    setBusy(true)
    if (tabOpened) setMessage('Searching YouTube...')
    try {
      const response = await apiFetch(`/api/music/youtube-search?q=${encodeURIComponent(clean)}&limit=20`)
      const data = await readJson<{ success?: boolean; tracks?: YouTubeTrack[]; message?: string; detail?: string; corrected_query?: string }>(response)
      if (!response.ok) {
        if (response.status === 401) throw new Error('Your Visionary Nexus session has expired or is signed out. Sign in again, then retry YouTube search.')
        throw new Error(data?.detail || data?.message || `YouTube search failed (HTTP ${response.status}).`)
      }
      if (!data) throw new Error('The music server returned an unreadable response. Check that the backend is online.')
      const found = (data.tracks || []).filter(track => track?.provider?.toLowerCase() === 'youtube' && isValidYouTubeVideoId(track.id))
      setResults(found)
      const quotaExceeded = /quota|daily.*limit|per.day.*limit|not configured|add youtube_api_key/i.test(String(data?.message || data?.detail || ''))
      if (quotaExceeded) {
        setMessage('YouTube API unavailable. Trying Piped, then Invidious...')
        setFallbackUrl('')
        setFallbackMessage('')
        void searchYouTubeAlternatives(clean, autoplay, voiceCommand)
      } else if (!found.length) {
        if (autoplay) {
          setMessage(data?.message || 'No YouTube videos matched. Opening YouTube search results.')
          navigateResult(youtubeSearchUrl(clean))
        } else {
          setMessage(data?.message || 'No YouTube results found. Try another title or artist.')
        }
      } else {
        const corrected = data.corrected_query && data.corrected_query.toLowerCase() !== clean.toLowerCase()
          ? ` Search spelling corrected to "${data.corrected_query}".`
          : ''
        setMessage(`Found ${found.length} YouTube results.${corrected}`)
        if (autoplay) {
          const safe = found.filter(track =>
            !(track.durationSeconds && track.durationSeconds > 900) &&
            !/(1\s*hour|one\s*hour|60\s*min|extended\s*mix|\bloop\b)/i.test(track.name)
          )
          const preferred = bestFullSongMatch(clean, safe)
          if (!preferred) {
            setMessage('Search results are ready, but none is a confident normal-length song match. Select the right version from the results.')
            return
          }
          const ordered = [preferred, ...safe.filter(track => track.id !== preferred.id)]
          if (playTrack(preferred, ordered) && voiceCommand) {
            announceVoicePlayback('voice', clean)
          }
        }
      }
    } catch (error) {
      setResults([])
      const reason = error instanceof Error ? error.message : 'YouTube search failed.'
      if (/quota|daily.*limit|per.day.*limit/i.test(reason)) {
        setMessage('YouTube API unavailable. Trying Piped, then Invidious...')
        setFallbackUrl('')
        setFallbackMessage('')
        void searchYouTubeAlternatives(clean, autoplay, voiceCommand)
      } else {
        setMessage(reason)
        if (autoplay) navigateResult(youtubeSearchUrl(clean))
      }
    } finally {
      setBusy(false)
    }
  }

  const parsePlaylistCsv = (source: string): string[] => {
    const firstLine = source.split(/\r?\n/, 1)[0] || ''
    const delimiter = [',', '\t', ';'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0]
    const rows: string[][] = []
    let row: string[] = []
    let cell = ''
    let quoted = false
    for (let i = 0; i < source.length; i++) {
      const char = source[i]
      if (char === '"' && source[i + 1] === '"' && quoted) { cell += '"'; i++; continue }
      if (char === '"') { quoted = !quoted; continue }
      if (!quoted && char === delimiter) { row.push(cell.trim()); cell = ''; continue }
      if (!quoted && (char === '\n' || char === '\r')) {
        if (cell.trim() || row.length) rows.push([...row, cell.trim()])
        row = []; cell = ''
        if (char === '\r' && source[i + 1] === '\n') i++
        continue
      }
      cell += char
    }
    if (cell.trim() || row.length) rows.push([...row, cell.trim()])
    if (!rows.length) return []
    const normal = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '')
    const header = rows[0].map(normal)
    const titleIndex = header.findIndex(value => ['trackname', 'title', 'song', 'track'].includes(value))
    const artistIndex = header.findIndex(value => ['artistname(s)', 'artistnames', 'artist', 'artists'].includes(value))
    const hasHeader = titleIndex >= 0
    const titleCol = hasHeader ? titleIndex : 0
    const artistCol = hasHeader ? artistIndex : 1
    return rows.slice(hasHeader ? 1 : 0)
      .map(values => [values[titleCol] || '', artistCol >= 0 ? values[artistCol] || '' : ''].filter(Boolean).join(' - ').trim())
      .filter(Boolean)
  }

  const importPlaylistCsv = async (file: File) => {
    setMissingImportTracks([])
    setBusy(true)
    setMessage(`Importing ${file.name}; searching YouTube, then Piped/Invidious if the API quota is exhausted...`)
    try {
      const source = await file.text()
      const entries = parsePlaylistCsv(source)
      if (!entries.length) throw new Error('No song rows found. Use a CSV with Track Name and Artist columns, or title,artist rows.')
      const matched: YouTubeTrack[] = []
      const missing: string[] = []
      let usedFallbackSearch = false
      for (const entry of entries) {
        let candidates: YouTubeTrack[] = []
        let primaryMessage = ''
        try {
          const response = await apiFetch(`/api/music/youtube-search?q=${encodeURIComponent(entry)}&limit=20`)
          const data = await readJson<{ success?: boolean; tracks?: YouTubeTrack[]; message?: string; detail?: string }>(response)
          primaryMessage = String(data?.message || data?.detail || '')
          if (response.ok && data) candidates = (data.tracks || []).filter(track => track?.id && track?.provider?.toLowerCase() === 'youtube')
          else if (response.status === 401) throw new Error('Your Visionary Nexus session expired. Sign in again, then retry the CSV import.')
          else primaryMessage = primaryMessage || `YouTube search returned HTTP ${response.status}.`
        } catch (error) {
          if (error instanceof Error && /session expired/i.test(error.message)) throw error
          primaryMessage = error instanceof Error ? error.message : 'YouTube search failed.'
        }
        let selected = bestFullSongMatch(entry, candidates)
        // Retry alternative catalogues whenever the primary search misses.
        if (!selected) {
          try {
            const fallbackResponse = await apiFetch(`/api/music/youtube-alternative-search?q=${encodeURIComponent(entry)}&limit=20`)
            const fallbackData = await readJson<{ success?: boolean; tracks?: YouTubeTrack[]; message?: string }>(fallbackResponse)
            const fallbackCandidates = (fallbackData?.tracks || []).filter(track => track?.id && track?.provider?.toLowerCase() === 'youtube')
            const fallbackMatch = bestFullSongMatch(entry, fallbackCandidates)
            if (fallbackResponse.ok && fallbackData?.success && fallbackMatch) {
              candidates = fallbackCandidates
              selected = fallbackMatch
              usedFallbackSearch = true
            }
          } catch (error) {
            console.warn('Piped/Invidious fallback import search failed:', entry, error)
          }
        }
        // If the CSV has a phonetic/spelling error, ask the existing query
        // corrector once and retry. Never fall back to an unrelated long mix.
        if (!selected) {
          try {
            const correctionResponse = await apiFetch('/api/music/correct-query', {
              method: 'POST',
              body: JSON.stringify({ query: entry }),
            })
            const correction = await readJson<{ corrected_query?: string }>(correctionResponse)
            const correctedQuery = String(correction?.corrected_query || '').trim()
            if (correctionResponse.ok && correctedQuery && correctedQuery.toLowerCase() !== entry.toLowerCase()) {
              let retryCandidates: YouTubeTrack[] = []
              const retryResponse = await apiFetch(`/api/music/youtube-search?q=${encodeURIComponent(correctedQuery)}&limit=20`)
              const retryData = await readJson<{ tracks?: YouTubeTrack[]; message?: string }>(retryResponse)
              retryCandidates = (retryData?.tracks || []).filter(track => track?.id && track?.provider?.toLowerCase() === 'youtube')
              let retryMatch = bestFullSongMatch(correctedQuery, retryCandidates)
              if (!retryMatch) {
                const altResponse = await apiFetch(`/api/music/youtube-alternative-search?q=${encodeURIComponent(correctedQuery)}&limit=20`)
                const altData = await readJson<{ tracks?: YouTubeTrack[]; success?: boolean }>(altResponse)
                retryCandidates = (altData?.tracks || []).filter(track => track?.id && track?.provider?.toLowerCase() === 'youtube')
                retryMatch = bestFullSongMatch(correctedQuery, retryCandidates)
                if (altResponse.ok && altData?.success) usedFallbackSearch = true
              }
              if (retryMatch) selected = retryMatch
            }
          } catch (error) {
            console.warn('Could not correct imported YouTube track query:', entry, error)
          }
        }

        if (selected) matched.push(selected)
        else missing.push(entry)
      }
      setMissingImportTracks(missing)
      if (!matched.length) {
        const examples = missing.slice(0, 3).join('; ')
        throw new Error(`No CSV tracks matched a full YouTube song. Checked ${entries.length} tracks. First unmatched entries: ${examples || 'none'}.`)
      }
      const uniqueMatched = dedupeTracks(matched)
      const duplicateCount = matched.length - uniqueMatched.length
      const name = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Imported playlist'
      const existing = allSavedPlaylists.find(item => item.name.toLowerCase() === name.toLowerCase())
      let savedMatched = uniqueMatched
      let publishedMessage = 'Saved locally in Visionary Nexus.'
      // Piped and Invidious are catalogue/playback fallbacks, not playlist
      // hosting APIs. Only attempt YouTube publishing when its API search was
      // available and the user has connected an authorized YouTube account.
      if (!usedFallbackSearch && youtubeAccount.configured && youtubeAccount.connected) {
        try {
          const createResponse = await apiFetch('/api/music/youtube-oauth/playlists', {
            method: 'POST',
            body: JSON.stringify({ name, tracks: uniqueMatched }),
          })
          const created = await readJson<any>(createResponse)
          if (createResponse.ok && created?.success && created?.playlist_id && created?.playlist_url && created?.added_count) {
            // Keep every matched track in the local playlist even if YouTube
            // rejects some playlist insertions. Publishing count is reported separately.
            savedMatched = uniqueMatched.map(track => ({ ...track, youtubePlaylistId: created.playlist_id, youtubePlaylistUrl: created.playlist_url }))
            setFallbackUrl(created.playlist_url)
            setFallbackMessage('YouTube playlist created. Open it in YouTube using the link below if needed.')
            publishedMessage = `Also published ${created.added_count} tracks to YouTube.`
          } else {
            publishedMessage = 'Saved locally; YouTube publishing was unavailable.'
          }
        } catch {
          publishedMessage = 'Saved locally; YouTube publishing was unavailable.'
        }
      } else if (usedFallbackSearch) {
        publishedMessage = 'Saved locally using Piped/Invidious results. Those services do not support playlist uploads.'
      } else if (!youtubeAccount.connected) {
        publishedMessage = 'Saved locally. Connect YouTube later if you also want to publish it there.'
      }
      setActivePlaylistName(name)
      historyRef.current = []
      replaceQueue(savedMatched.slice(1))
      if (savedMatched[0]) playTrack(savedMatched[0], undefined, false)
      const next = existing
        ? allSavedPlaylists.map(item => item === existing ? { ...item, tracks: savedMatched } : item)
        : [...allSavedPlaylists, { name, tracks: savedMatched }]
      await persistPlaylists(next)
      setMessage(`Imported ${savedMatched.length} of ${entries.length} tracks. ${publishedMessage} ` +
        (missing.length ? `${missing.length} tracks had no confident full-song match.` : 'All matched tracks were saved in order.'))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'CSV playlist import failed.')
    } finally {
      setBusy(false)
    }
  }

  const persistPlaylists = async (next: StoredPlaylist[]) => {
    const response = await apiFetch('/api/music/playlists', {
      method: 'PUT',
      body: JSON.stringify({ playlists: next }),
    })
    const saved = await readJson<{ success?: boolean; message?: string; detail?: string }>(response)
    if (!response.ok || saved?.success !== true) {
      throw new Error(saved?.detail || saved?.message || 'Playlist database save failed.')
    }
    const normalized = next.map(item => ({
      ...item,
      tracks: dedupeTracks((item.tracks || [])
        .filter(track => track?.id && (!track.provider || track.provider.toLowerCase() === 'youtube'))
        .map(track => ({ ...track, provider: 'youtube' }))),
    }))
    setAllSavedPlaylists(normalized)
    setPlaylists(normalized as SavedPlaylist[])
  }

  const savePlaylist = async () => {
    const name = playlistName.trim()
    const chosenTracks = results.filter(track => selectedTracks.length ? selectedTracks.includes(track.id) : true)
    const tracks = dedupeTracks(chosenTracks)
    if (!name || !tracks.length) {
      setMessage('Enter a playlist name and select at least one search result.')
      return
    }
    const existing = allSavedPlaylists.find(item => item.name.toLowerCase() === name.toLowerCase())
    const next = existing
      ? allSavedPlaylists.map(item => item === existing
          ? { ...item, tracks: [...(item.tracks || []), ...tracks.filter(track => !(item.tracks || []).some(saved => saved.id === track.id))] }
          : item)
      : [...allSavedPlaylists, { name, tracks }]
    try {
      await persistPlaylists(next)
      setPlaylistName('')
      setSelectedTracks([])
      setMessage(existing ? `Added tracks to "${name}".` : `Created playlist "${name}".`)
    } catch { setMessage('Playlist could not be saved. Please retry.') }
  }

  const addTrackToPlaylist = async (track: YouTubeTrack, requestedName: string) => {
    const name = requestedName.trim()
    if (!name) {
      setMessage('Enter a playlist name in Playlist library, then press Add on the song.')
      return
    }
    const existing = allSavedPlaylists.find(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())
    if ((existing?.tracks || []).some(saved => saved.id === track.id || trackIdentity(saved) === trackIdentity(track))) {
      setMessage('"' + track.name + '" is already in "' + (existing?.name || name) + '".')
      return
    }
    const savedTrack = { ...track, provider: 'youtube' }
    const next = existing
      ? allSavedPlaylists.map(item => item === existing ? { ...item, tracks: [...(item.tracks || []), savedTrack] } : item)
      : [...allSavedPlaylists, { name, tracks: [savedTrack] }]
    try {
      await persistPlaylists(next)
      setPlaylistName('')
      setSelectedPlaylistByTrack(current => ({ ...current, [track.id]: '' }))
      setMessage('Added "' + track.name + '" to "' + name + '".')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save the song to that playlist.')
    }
  }
  const deletePlaylist = async (name: string) => {
    try {
      await persistPlaylists(allSavedPlaylists.filter(item => item.name !== name))
      if (activePlaylistName === name) setActivePlaylistName('')
      setMessage(`Deleted playlist "${name}".`)
    } catch { setMessage('Could not delete that playlist.') }
  }

  const removeTrackFromPlaylist = async (name: string, trackId: string) => {
    const next = allSavedPlaylists.map(item => item.name === name
      ? { ...item, tracks: (item.tracks || []).filter(track => track.id !== trackId) }
      : item)
    try { await persistPlaylists(next); setMessage('Removed track from playlist.') }
    catch { setMessage('Could not remove that track.') }
  }

  const startRenamePlaylist = (name: string) => {
    setEditingPlaylistName(name)
    setPlaylistNameDraft(name)
  }

  const renamePlaylist = async (oldName: string) => {
    const nextName = playlistNameDraft.trim()
    if (!nextName || nextName === oldName) {
      setEditingPlaylistName('')
      return
    }
    if (allSavedPlaylists.some(item => item.name.toLowerCase() === nextName.toLowerCase() && item.name !== oldName)) {
      setMessage('A playlist with that name already exists.')
      return
    }
    try {
      await persistPlaylists(allSavedPlaylists.map(item => item.name === oldName ? { ...item, name: nextName } : item))
      if (activePlaylistName === oldName) setActivePlaylistName(nextName)
      setEditingPlaylistName('')
      setMessage(`Renamed playlist to "${nextName}".`)
    } catch { setMessage('Could not rename that playlist.') }
  }
  const moveTrackInPlaylist = async (name: string, draggedTrackId: string, targetTrackId: string) => {
    const playlist = allSavedPlaylists.find(item => item.name === name)
    if (!playlist || draggedTrackId === targetTrackId) return
    const tracks = [...(playlist.tracks || [])]
    const fromIndex = tracks.findIndex(track => track.id === draggedTrackId)
    const toIndex = tracks.findIndex(track => track.id === targetTrackId)
    if (fromIndex < 0 || toIndex < 0) return
    const [draggedTrack] = tracks.splice(fromIndex, 1)
    tracks.splice(toIndex, 0, draggedTrack)
    try {
      await persistPlaylists(allSavedPlaylists.map(item => item.name === name ? { ...item, tracks } : item))
      setMessage('Playlist order updated.')
    } catch { setMessage('Could not reorder that playlist.') }
  }

  const moveTrackToPosition = async (name: string, trackId: string, requestedPosition: number) => {
    const playlist = allSavedPlaylists.find(item => item.name === name)
    if (!playlist) return
    const tracks = [...(playlist.tracks || [])]
    const fromIndex = tracks.findIndex(track => track.id === trackId)
    if (fromIndex < 0) return
    const targetIndex = Math.max(0, Math.min(tracks.length - 1, Math.floor(requestedPosition) - 1))
    if (targetIndex === fromIndex) return
    const [moving] = tracks.splice(fromIndex, 1)
    tracks.splice(targetIndex, 0, moving)
    try {
      await persistPlaylists(allSavedPlaylists.map(item => item.name === name ? { ...item, tracks } : item))
      setMessage('Moved "' + moving.name + '" to position ' + (targetIndex + 1) + ' in "' + name + '".')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not move that track.')
    }
  }
  const playPlaylist = (playlist: SavedPlaylist) => {
    if (!playlist.tracks.length) return
    setActivePlaylistName(playlist.name)
    historyRef.current = []
    const ordered = shuffleQueue ? [...playlist.tracks].sort(() => Math.random() - 0.5) : playlist.tracks
    replaceQueue(ordered.slice(1))
    playTrack(ordered[0])
  }

  const playNext = () => {
    const next = queueRef.current.shift()
    refreshQueue()
    if (next) { playTrack(next); return }
    const active = playlists.find(item => item.name === activePlaylistName)
    if (repeatPlaylist && active?.tracks.length) {
      replaceQueue(active.tracks.slice(1))
      playTrack(active.tracks[0])
    } else setMessage('Your queue is finished.')
  }

  const playPrevious = () => {
    const previous = historyRef.current.pop()
    if (!previous) {
      setMessage('There is no previous track in playback history.')
      return
    }
    const currentTrack = currentTrackRef.current
    // A Previous action must not add the track we are leaving to history.
    // Put it at the front of the queue so Next returns to it, rather than
    // skipping forward to the following queued song.
    if (currentTrack && currentTrack.id !== previous.id) {
      queueRef.current.unshift(currentTrack)
      refreshQueue()
    }
    playTrack(previous, undefined, false)
  }
  const playNextRef = useRef(playNext)
  playNextRef.current = playNext

  const togglePlayback = () => {
    const player = youtubePlayerRef.current
    if (!player || !youtubePlayerReadyRef.current) {
      setMessage(currentTrackRef.current ? 'The player is still loading. Try again in a moment.' : 'Choose a song or playlist first.')
      return
    }
    const state = player.getPlayerState?.()
    if (state === (window as any).YT?.PlayerState?.PLAYING) player.pauseVideo()
    else player.playVideo()
  }

  // Restore the last song and queue without autoplaying after a restart.
  // The saved position is cued into YouTube, then the user can press Resume.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem('visionary_music_playback_v1')
      if (!raw) return
      const saved = JSON.parse(raw) as { current?: YouTubeTrack; queue?: YouTubeTrack[]; position?: number; activePlaylistName?: string }
      if (!saved.current?.id || !isValidYouTubeVideoId(saved.current.id)) return
      const restoredTrack = { ...saved.current, provider: 'youtube' }
      currentTrackRef.current = restoredTrack
      setCurrent(restoredTrack)
      const restoredQueue = Array.isArray(saved.queue)
        ? saved.queue.filter(track => track?.id && isValidYouTubeVideoId(track.id)).map(track => ({ ...track, provider: 'youtube' }))
        : []
      replaceQueue(restoredQueue)
      const restoredPlaylist = typeof saved.activePlaylistName === 'string' ? saved.activePlaylistName : ''
      activePlaylistNameRef.current = restoredPlaylist
      setActivePlaylistName(restoredPlaylist)
      restorePositionRef.current = Number.isFinite(saved.position) ? Math.max(0, Number(saved.position)) : 0
      pendingVideoIdRef.current = restoredTrack.id
      setMessage('Restored ' + restoredTrack.name + '. Paused at your last position ? press Resume when ready.')
    } catch {
      window.localStorage.removeItem('visionary_music_playback_v1')
    }
  }, [])

  // Save frequently and synchronously when the page is closed or hidden. This
  // also covers switching away from the Music tab if the component unmounts.
  useEffect(() => {
    const savePlayback = () => {
      const track = currentTrackRef.current
      if (!track?.id) return
      const player = youtubePlayerRef.current
      let position = restorePositionRef.current ?? 0
      try {
        const currentTime = player?.getCurrentTime?.()
        if (Number.isFinite(currentTime)) position = Math.max(0, currentTime)
      } catch { /* Keep the last known saved position. */ }
      const snapshot = {
        current: track,
        queue: queueRef.current,
        position,
        activePlaylistName: activePlaylistNameRef.current,
        savedAt: Date.now(),
      }
      try { window.localStorage.setItem('visionary_music_playback_v1', JSON.stringify(snapshot)) } catch { /* Storage may be unavailable. */ }
    }
    const interval = window.setInterval(savePlayback, 1500)
    const onPageExit = () => {
      savePlayback()
      try { youtubePlayerRef.current?.pauseVideo?.() } catch { /* Player may already be closing. */ }
    }
    const onVisibility = () => { if (document.visibilityState === 'hidden') savePlayback() }
    window.addEventListener('pagehide', onPageExit)
    window.addEventListener('beforeunload', onPageExit)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      savePlayback()
      window.clearInterval(interval)
      window.removeEventListener('pagehide', onPageExit)
      window.removeEventListener('beforeunload', onPageExit)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  // Use the YouTube IFrame API inside Visionary Nexus. A separate YouTube tab
  // is cross-origin and cannot report ENDED events, so queue auto-skip cannot
  // work reliably there.
  useEffect(() => {
    let cancelled = false
    const createPlayer = () => {
      if (cancelled || !(window as any).YT?.Player || youtubePlayerRef.current) return
      const host = document.getElementById('visionary-youtube-music-player')
      if (!host) return
      // The IFrame API expects the container's element ID (not the
      // HTMLElement itself). Passing the element can produce error 2 on
      // some browser/API combinations.
      youtubePlayerRef.current = new (window as any).YT.Player(host.id, {
        width: '100%',
        height: '100%',
        playerVars: {
          playsinline: 1,
          rel: 0,
          origin: window.location.origin,
          enablejsapi: 1,
        },
        events: {
          onReady: () => {
            youtubePlayerReadyRef.current = true
            const iframe = youtubePlayerRef.current?.getIframe?.() as HTMLIFrameElement | undefined
            if (iframe) {
              iframe.style.width = '100%'
              iframe.style.height = '100%'
              iframe.style.aspectRatio = '16 / 9'
              iframe.style.border = '0'
            }
            const pending = pendingVideoIdRef.current
            if (pending) {
              const restorePosition = restorePositionRef.current
              if (restorePosition !== null) {
                youtubePlayerRef.current?.cueVideoById({ videoId: pending, startSeconds: restorePosition })
                restorePositionRef.current = null
                if (pendingResumeRef.current) {
                  pendingResumeRef.current = false
                  window.setTimeout(() => youtubePlayerRef.current?.playVideo?.(), 250)
                }
              } else {
                youtubePlayerRef.current?.loadVideoById(pending)
              }
              pendingVideoIdRef.current = null
            }
          },
          onStateChange: (event: any) => {
            if (event.data === (window as any).YT.PlayerState.ENDED) {
              setIsPlaying(false)
              playNextRef.current()
            } else if (event.data === (window as any).YT.PlayerState.PLAYING) {
              setIsPlaying(true)
            } else if (event.data === (window as any).YT.PlayerState.PAUSED || event.data === (window as any).YT.PlayerState.CUED) {
              setIsPlaying(false)
            }
          },
          onError: (event: any) => {
            setMessage(`YouTube could not play this video (error ${event.data}). Choose another result.`)
          },
        },
      })
    }

    if ((window as any).YT?.Player) {
      createPlayer()
    } else {
      const existing = document.querySelector<HTMLScriptElement>('script[src="https://www.youtube.com/iframe_api"]')
      if (!existing) {
        const script = document.createElement('script')
        script.src = 'https://www.youtube.com/iframe_api'
        script.async = true
        document.head.appendChild(script)
      }
      const previousReady = (window as any).onYouTubeIframeAPIReady
      ;(window as any).onYouTubeIframeAPIReady = () => {
        try { previousReady?.() } finally { createPlayer() }
      }
      const poll = window.setInterval(() => {
        if ((window as any).YT?.Player) {
          window.clearInterval(poll)
          createPlayer()
        }
      }, 100)
      return () => {
        cancelled = true
        window.clearInterval(poll)
      }
    }

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<MusicCommandEventDetail>).detail || {}
      if (typeof detail.commandId === 'number') {
        if (handledCommandIdsRef.current.has(detail.commandId)) return
        handledCommandIdsRef.current.add(detail.commandId)
        if (handledCommandIdsRef.current.size > 100) {
          const oldest = handledCommandIdsRef.current.values().next().value
          if (typeof oldest === 'number') handledCommandIdsRef.current.delete(oldest)
        }
        clearPendingMusicCommand(detail.commandId)
      }
      if (detail.activeTab && detail.activeTab !== 'music') return
      const action = String(detail.action || '').toLowerCase()
      const spoken = String(detail.text || '').trim()
      if (action === 'open') {
        setMessage('YouTube Music is ready. Say or type a song to search YouTube.')
        return
      }
      if (spoken && !['pause', 'stop', 'resume', 'next', 'previous'].includes(action)) setQuery(detail.query || spoken)
      if (action === 'pause' || (action !== 'stop' && /^pause( music)?$/i.test(spoken))) {
        setMessage("Use YouTube's playback controls; this page cannot control cross-origin playback.")
        return
      }
      if (action === 'stop' || /^stop( music)?$/i.test(spoken)) {
        setMessage("Use YouTube's playback controls; this page cannot control cross-origin playback.")
        return
      }
      if (action === 'resume' || /^(resume|continue)( music)?$/i.test(spoken)) {
        if (!currentTrackRef.current) {
          setMessage('There is no saved song to resume. Play a song first.')
          return
        }
        if (!youtubePlayerReadyRef.current || !youtubePlayerRef.current) {
          pendingResumeRef.current = true
          setMessage('Preparing your saved song. It will start as soon as the player is ready.')
          return
        }
        pendingResumeRef.current = false
        youtubePlayerRef.current.playVideo()
        setMessage('Resuming ' + currentTrackRef.current.name + '.')
        return
      }
      if (action === 'next' || /^(next|skip)( song| track)?$/i.test(spoken)) { playNext(); return }
      if (action === 'previous' || /^(previous|back)( song| track)?$/i.test(spoken)) { playPrevious(); return }
      const targetRaw = (detail.query || spoken.replace(/^(?:(?:please\s+)?(?:play|listen to|put on|start playing)|i want to listen to|can you play)\s+/i, '')).trim()
      if (!targetRaw) return
      const playlist = findSavedPlaylist(targetRaw, allSavedPlaylists)
      if (playlist) {
        const ordered = (playlist.tracks || []).filter(track => track && (track.name || track.id)) as YouTubeTrack[]
        if (!ordered.length) {
          setMessage(`The saved playlist "${playlist.name}" has no tracks.`)
          return
        }
        setActivePlaylistName(playlist.name)
        historyRef.current = []
        replaceQueue(ordered.slice(1))
        const first = ordered[0]
        if (isValidYouTubeVideoId(first.id)) {
          if (playTrack(first) && detail.source === 'voice') {
            announceVoicePlayback('voice', playlist.name)
          }
        } else {
          void search(
            [first.name, first.artist].filter(Boolean).join(' - ') || first.name || playlist.name,
            true,
            spoken,
            detail.source === 'voice',
          )
        }
        return
      }
      void search(targetRaw, true, spoken, detail.source === 'voice')
    }
    window.addEventListener('visionary:youtube-command', handler)
    const pending = consumePendingMusicCommand()
    if (pending) handler(new CustomEvent('visionary:youtube-command', { detail: pending }))
    return () => window.removeEventListener('visionary:youtube-command', handler)
  }, [allSavedPlaylists, activePlaylistName, repeatPlaylist, playlistsLoaded])



  return (
    <div className="vn-music-root mx-auto max-w-7xl space-y-6 p-4 text-white md:p-8">
      <header className="vn-music-header flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-xs font-bold tracking-[0.25em] text-red-300">PERSONAL AUDIO | MUSIC</div>
          <h1 className="mt-2 text-3xl font-bold">YouTube Music</h1>
          <p className="mt-1 text-sm text-white/55">YouTube is primary. Piped and Invidious are used when the YouTube API quota runs out; requests stay on YouTube.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void connectYouTube()} className="rounded-full border border-white/20 px-4 py-2 text-xs text-white/75">{youtubeAccount.connected ? "YouTube connected" : "Connect YouTube"}</button>
          {onSpotify && <button onClick={onSpotify} className="rounded-full border border-white/20 px-4 py-2 text-xs text-white/75">Spotify library</button>}
          <span className="rounded-full border border-red-300/30 px-3 py-2 text-xs text-red-200">PRIMARY</span>
        </div>
      </header>

      <form onSubmit={event => { event.preventDefault(); void search(query, true) }} className="vn-music-search flex flex-wrap gap-2 rounded-2xl border border-white/10 bg-white/[0.04] p-3">
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search songs, artists or genres..." className="min-w-0 flex-1 bg-transparent px-3 py-3 text-sm outline-none" />
        <button disabled={busy || !query.trim()} className="rounded-xl bg-red-500 px-6 py-3 text-sm font-semibold text-white disabled:opacity-40">{busy ? 'Searching...' : 'Search YouTube'}</button>
      </form>

      {message && <p className="text-sm text-white/65">{message}</p>}
      {missingImportTracks.length > 0 && <section className="rounded-xl border border-amber-300/25 bg-amber-300/[0.06] p-4" role="status">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-amber-100">{missingImportTracks.length} tracks not imported</h2>
          <button onClick={() => void navigator.clipboard?.writeText(missingImportTracks.join('\\n'))} className="rounded-lg border border-amber-200/25 px-3 py-1.5 text-xs text-amber-100">Copy missing titles</button>
        </div>
        <p className="mt-1 text-xs text-white/55">These titles were not confidently matched, so they were left out rather than replaced with unrelated or long versions.</p>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-white/80">
          {missingImportTracks.map((title, index) => <li key={`${index}-${title}`}>{title}</li>)}
        </ol>
      </section>}
      <section className="vn-music-player rounded-2xl border border-white/10 bg-white/[0.04] p-3 md:p-5">
        <div
          id="visionary-youtube-music-player"
          className="mx-auto aspect-video w-full max-w-5xl overflow-hidden rounded-xl bg-black"
          style={{ minHeight: '280px', maxHeight: '70vh' }}
        />
        {current && <p className="mx-auto mt-3 max-w-5xl truncate text-center text-sm text-white/65">Now playing: {current.name} — {current.artist}</p>}
        <div className="mt-4 flex items-center justify-center gap-3" aria-label="Music playback controls">
          <button type="button" onClick={playPrevious} disabled={!current} aria-label="Previous track" title="Previous" className="grid h-11 w-11 place-items-center rounded-full border border-white/20 text-lg text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-35">⏮</button>
          <button type="button" onClick={togglePlayback} disabled={!current} aria-label={isPlaying ? 'Pause' : 'Play'} title={isPlaying ? 'Pause' : 'Play'} className="grid h-12 w-12 place-items-center rounded-full bg-red-500 text-xl font-bold text-white transition hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-35">{isPlaying ? 'Ⅱ' : '▶'}</button>
          <button type="button" onClick={playNext} disabled={!current} aria-label="Next track" title="Next" className="grid h-11 w-11 place-items-center rounded-full border border-white/20 text-lg text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-35">⏭</button>
        </div>
      </section>
      {blockedYoutubeUrl && <a
        href={blockedYoutubeUrl}
        target={YOUTUBE_WINDOW_NAME}
        rel="noopener"
        onClick={event => {
          event.preventDefault()
          if (openNamedYouTubeWindow(blockedYoutubeUrl)) setBlockedYoutubeUrl('')
          else setMessage('Your browser blocked the YouTube tab again. Allow this site to open tabs, then retry.')
        }}
        className="inline-flex rounded-lg border border-red-300/30 px-3 py-2 text-sm text-red-100 underline"
      >Open YouTube</a>}
      {fallbackMessage && <div role="status" className="flex flex-wrap items-center gap-3 text-sm text-amber-200">
        <span>{fallbackMessage}</span>
        {fallbackUrl && <a href={fallbackUrl} className="underline">Open YouTube playlist</a>}
      </div>}


      <section className="vn-music-results grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {results.map(track => (
          <div key={track.id} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-3">
            {track.image ? <img src={track.image} alt="" className="h-14 w-14 rounded-xl object-cover" /> : <div className="grid h-14 w-14 place-items-center rounded-xl bg-white/10">♪</div>}
            <div className="min-w-0 flex-1">
              <button onClick={() => playTrack(track, results)} className="block w-full text-left">
                <span className="block truncate text-sm font-semibold">{track.name}</span>
                <span className="block truncate text-xs text-white/50">{track.artist}</span>
              </button>
              <label className="mt-2 flex items-center gap-2 text-[11px] text-white/55">
                <input type="checkbox" checked={selectedTracks.includes(track.id)} onChange={event => setSelectedTracks(current => event.target.checked ? [...current, track.id] : current.filter(id => id !== track.id))} />
                Select for playlist
              </label>
              {playlists.length > 0 && <select
                aria-label={'Choose playlist for ' + track.name}
                value={selectedPlaylistByTrack[track.id] || ''}
                onChange={event => setSelectedPlaylistByTrack(current => ({ ...current, [track.id]: event.target.value }))}
                className="mt-2 max-w-full rounded-lg border border-white/15 bg-[#101827] px-2 py-1 text-[11px] text-white"
              >
                <option value="">Choose a playlist...</option>
                {playlists.map(playlist => <option key={playlist.name} value={playlist.name}>{playlist.name}</option>)}
              </select>}
              <button
                type="button"
                disabled={!((selectedPlaylistByTrack[track.id] || playlistName).trim())}
                onClick={() => void addTrackToPlaylist(track, selectedPlaylistByTrack[track.id] || playlistName)}
                className="mt-2 ml-2 rounded-lg border border-white/30 bg-white px-3 py-1.5 text-[11px] font-semibold text-black hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-40"
              >Add to playlist</button>
            </div>
            <button onClick={() => playTrack(track, results)} className="rounded-lg bg-red-500 px-3 py-2 text-xs font-semibold">Play</button>
          </div>
        ))}
        {!results.length && <p className="text-sm text-white/35">Search for a track, artist or genre to see YouTube results.</p>}
      </section>

      <div className="grid gap-4 lg:grid-cols-[0.85fr_1.15fr]">
        <section className="vn-music-queue vn-music-collection rounded-2xl border border-white/10 bg-white/[0.035] p-5" aria-label="Playback queue">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div><p className="text-[10px] tracking-[0.22em] text-white/45">UP NEXT</p><h2 className="mt-1 text-lg font-semibold">Queue</h2></div>
            <span className="rounded-full border border-white/15 px-3 py-1 text-xs text-white/65">{queueItems.length} tracks</span>
          </div>
          {current && <div className="mb-3 rounded-xl border border-white/10 bg-black/30 p-3">
            <p className="text-[9px] tracking-[0.18em] text-white/40">NOW PLAYING</p>
            <p className="mt-1 truncate text-sm font-medium">{current.name}</p>
            <p className="truncate text-xs text-white/45">{current.artist}</p>
          </div>}
          <div className="space-y-1">
            {queueItems.map((track, index) => <div key={track.id} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-white/[0.055]">
              <span className="w-6 text-xs tabular-nums text-white/35">{String(index + 1).padStart(2, '0')}</span>
              {track.image ? <img src={track.image} alt="" className="h-10 w-10 rounded-lg object-cover" /> : <span className="grid h-10 w-10 place-items-center rounded-lg bg-white/10">⠿</span>}
              <button className="min-w-0 flex-1 text-left" onClick={() => { replaceQueue(queueItems.slice(index + 1)); playTrack(track) }}>
                <span className="block truncate text-xs font-medium text-white/85">{track.name}</span>
                <span className="block truncate text-[11px] text-white/40">{track.artist}</span>
              </button>
              <span className="text-[10px] text-white/30">PLAY</span>
            </div>)}
            {!queueItems.length && <p className="rounded-xl border border-dashed border-white/10 px-3 py-6 text-center text-xs text-white/35">Your queue is empty. Play a song or playlist to add upcoming tracks.</p>}
          </div>
        </section>
      <section className="vn-music-library rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="font-semibold">Playlist library</h2><p className="text-xs text-white/45">Import CSV, create playlists, add tracks, reorder, rename, shuffle, repeat and remove songs</p></div>
          <div className="flex flex-wrap gap-2">
            <input value={playlistName} onChange={event => setPlaylistName(event.target.value)} placeholder="Playlist name" className="w-40 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs outline-none" />
            <label className="cursor-pointer rounded-xl border border-white/15 px-3 py-2 text-xs">
              Import CSV
              <input type="file" accept=".csv,text/csv" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void importPlaylistCsv(file); event.currentTarget.value = '' }} />
            </label>
            <button onClick={() => void savePlaylist()} disabled={!results.length || !playlistName.trim()} className="rounded-xl border border-white/15 px-3 py-2 text-xs disabled:opacity-40">{selectedTracks.length ? `Add ${selectedTracks.length} selected` : 'Create from results'}</button>
            <button onClick={() => setShuffleQueue(value => !value)} aria-pressed={shuffleQueue} className={`rounded-xl border px-3 py-2 text-xs ${shuffleQueue ? 'border-cyan-300 text-cyan-200' : 'border-white/15'}`}>Shuffle {shuffleQueue ? 'On' : 'Off'}</button>
            <button onClick={() => setRepeatPlaylist(value => !value)} aria-pressed={repeatPlaylist} className={`rounded-xl border px-3 py-2 text-xs ${repeatPlaylist ? 'border-cyan-300 text-cyan-200' : 'border-white/15'}`}>Repeat {repeatPlaylist ? 'On' : 'Off'}</button>
          </div>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {playlists.map(playlist => <div key={playlist.name} className={`rounded-xl border p-3 ${activePlaylistName === playlist.name ? 'border-red-300/50 bg-red-500/5' : 'border-white/10 bg-black/10'}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button onClick={() => playPlaylist(playlist)} className="min-w-0 flex-1 text-left">
                <span className="block truncate text-sm font-semibold">{playlist.name}</span>
                <span className="text-xs text-white/45">{playlist.tracks.length} tracks - Play playlist</span>
              </button>
              <button
                type="button"
                onClick={() => playPlaylist(playlist)}
                disabled={!playlist.tracks.length}
                aria-label={`Play playlist ${playlist.name}`}
                className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-red-400 disabled:opacity-40"
               >Play</button>
              <button onClick={() => startRenamePlaylist(playlist.name)} className="rounded-lg border border-white/15 px-2 py-1 text-xs text-white/60">Rename</button>
              <button onClick={() => void deletePlaylist(playlist.name)} className="rounded-lg border border-white/15 px-2 py-1 text-xs text-white/60">Delete</button>
            </div>
            {editingPlaylistName === playlist.name && <div className="mb-3 flex gap-2">
              <input autoFocus value={playlistNameDraft} onChange={event => setPlaylistNameDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void renamePlaylist(playlist.name); if (event.key === 'Escape') setEditingPlaylistName('') }} aria-label="New playlist name" className="min-w-0 flex-1 rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-xs text-white outline-none focus:border-white/50" />
              <button onClick={() => void renamePlaylist(playlist.name)} className="rounded-lg border border-white/20 px-3 py-2 text-xs">Save</button>
              <button onClick={() => setEditingPlaylistName('')} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-white/50">Cancel</button>
            </div>}
            <div className="mt-3 space-y-2">
              {playlist.tracks.map((track, index) => <div
                key={track.id + '-' + index}
                draggable
                onDragStart={event => {
                  draggedTrackIdRef.current = track.id
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', track.id)
                  event.currentTarget.classList.add('opacity-40')
                }}
                onDragEnd={event => {
                  draggedTrackIdRef.current = null
                  event.currentTarget.classList.remove('opacity-40')
                }}
                onDragOver={event => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                }}
                onDrop={event => {
                  event.preventDefault()
                  const draggedTrackId = draggedTrackIdRef.current || event.dataTransfer.getData('text/plain')
                  if (draggedTrackId) void moveTrackInPlaylist(playlist.name, draggedTrackId, track.id)
                  draggedTrackIdRef.current = null
                }}
                className="flex items-center gap-2 rounded-lg px-1 py-1 text-xs transition-colors hover:bg-white/5 cursor-grab active:cursor-grabbing"
                title="Drag this row to reorder the song"
              >
                <span aria-hidden="true" className="select-none px-1 text-white/45">&#x283F;</span>
                <span className="w-5 shrink-0 text-[10px] tabular-nums text-white/35">{index + 1}</span>
                <button onClick={() => { setActivePlaylistName(playlist.name); replaceQueue(playlist.tracks.slice(index + 1)); playTrack(track) }} className="min-w-0 flex-1 truncate text-left text-white/75">{track.name} <span className="text-white/35">- {track.artist}</span></button>
                <div className="flex shrink-0 items-center gap-1 rounded-lg border border-white/35 bg-black px-2 py-1" style={{ minWidth: 104, minHeight: 38 }}>
                  <span className="whitespace-nowrap text-[10px] font-semibold text-white/80">POSITION</span>
                  <input type="text" inputMode="numeric" draggable={false} defaultValue={String(index + 1)}
                    aria-label={'Move ' + track.name + ' to position'} placeholder="#"
                    onKeyDown={event => {
                      if (event.key === 'Enter') {
                        const value = Number(event.currentTarget.value.trim())
                        if (Number.isInteger(value) && value >= 1 && value <= playlist.tracks.length) {
                          void moveTrackToPosition(playlist.name, track.id, value)
                          event.currentTarget.blur()
                        } else setMessage('Enter a position from 1 to ' + playlist.tracks.length + '.')
                      }
                    }}
                    style={{ display: 'block', visibility: 'visible', opacity: 1, width: 34, minWidth: 34, height: 28, minHeight: 28, padding: '2px 3px', color: '#fff', background: '#000', border: '1px solid rgba(255,255,255,.6)', borderRadius: 6, textAlign: 'center', fontSize: 12, fontWeight: 700 }}
                  />
                </div>
                <button onClick={() => void removeTrackFromPlaylist(playlist.name, track.id)} aria-label={'Remove ' + track.name + ' from ' + playlist.name} className="px-2 text-white/40 hover:text-red-300">Remove</button>
              </div>)}
            </div>
          </div>)}
          {!playlists.length && <p className="text-xs text-white/35">No saved YouTube playlists yet. Search for tracks and create your first playlist.</p>}
        </div>
      </section>
      </div>
      <p className="text-center text-[11px] text-white/30">CSV imports create a real playlist in your connected YouTube account, add matched videos in order, and open the playlist in a separate tab. Local playlists remain saved in your workspace.</p>
    </div>
  )
}



