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

const normalizedWords = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/ +/).filter(Boolean)

const bestFullSongMatch = (query: string, candidates: YouTubeTrack[]) => {
  const titleQuery = query.toLowerCase().split(' by ')[0].split(' - ')[0].trim()
  const words = normalizedWords(titleQuery).filter(word => !['the', 'a', 'an', 'song', 'official', 'audio'].includes(word))
  if (!words.length) return null
  const matching = candidates.filter(track => {
    const titleWords = new Set(normalizedWords(track.name))
    const requestedTitle = words.join(' ')
    const candidateTitle = normalizedWords(track.name).join(' ')
    // The artist may appear before the song title in YouTube's title.
    // Require the complete requested title phrase, but do not require it
    // to be the first words in the video title.
    return words.every(word => titleWords.has(word)) &&
      candidateTitle.includes(requestedTitle) &&
      !(track.durationSeconds && track.durationSeconds <= 60) &&
      !/(shorts|#shorts)/i.test(track.name)
  })
  return matching.sort((a, b) => (b.durationSeconds || 0) - (a.durationSeconds || 0))[0] || null
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
  const [playlists, setPlaylists] = useState<SavedPlaylist[]>([])
  const [allSavedPlaylists, setAllSavedPlaylists] = useState<StoredPlaylist[]>([])
  const [playlistName, setPlaylistName] = useState('')
  const [playerKey, setPlayerKey] = useState(0)
  const [fallbackMessage, setFallbackMessage] = useState('')
  const [fallbackUrl, setFallbackUrl] = useState('')
  const [activePlaylistName, setActivePlaylistName] = useState('')
  const [selectedTracks, setSelectedTracks] = useState<string[]>([])
  const [repeatPlaylist, setRepeatPlaylist] = useState(false)
  const [shuffleQueue, setShuffleQueue] = useState(false)
  const [youtubeAccount, setYoutubeAccount] = useState<{ configured: boolean; connected: boolean; channel?: string }>({ configured: false, connected: false })
  const queueRef = useRef<YouTubeTrack[]>([])
  const historyRef = useRef<YouTubeTrack[]>([])
  const handledCommandIdsRef = useRef(new Set<number>())

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
            youtubePlaylistId: item.youtubePlaylistId || item.tracks?.find(track => track?.youtubePlaylistId)?.youtubePlaylistId,
            youtubePlaylistUrl: item.youtubePlaylistUrl || item.tracks?.find(track => track?.youtubePlaylistUrl)?.youtubePlaylistUrl,
          }))
          setAllSavedPlaylists(restored as StoredPlaylist[])
          const youtubeLists = restored
            .map(item => ({ ...item, tracks: (item.tracks || []).filter(track => track?.provider === 'youtube' && track?.id) }))
            .filter(item => item.tracks.length)
          setPlaylists(youtubeLists)
        }
      })
      .catch(() => {})
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
          const preferred = bestFullSongMatch(term, found)
          const ordered = preferred ? [preferred, ...found.filter(track => track.id !== preferred.id)] : found
          const resolved = await resolveYouTubePlayback(term, ordered, false, async () => [])
          if (resolved.selected) {
            if (playTrack(resolved.selected, found) && voiceCommand) {
              announceVoicePlayback('voice', term)
            }
          } else navigateResult(resolved.url)
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

  const playTrack = (track: YouTubeTrack, sequence?: YouTubeTrack[]) => {
    if (!track) return
    setCurrent(track)
    setFallbackMessage('')
    if (sequence) setActivePlaylistName('')
    if (current?.id && current.id !== track.id) historyRef.current.push(current)
    if (sequence) {
      const index = sequence.findIndex(item => item.id === track.id)
      const nextQueue = index >= 0 ? sequence.slice(index + 1) : []
      queueRef.current = shuffleQueue ? [...nextQueue].sort(() => Math.random() - 0.5) : nextQueue
    }

    const query = [track.name, track.artist].filter(Boolean).join(' - ') || track.name
    const url = youtubePlaybackUrl(query, [track])
    const opened = openNamedYouTubeWindow(url)
    if (opened) {
      setBlockedYoutubeUrl('')
      setMessage("YouTube opened. If playback does not start, use YouTube's Play control; ads are handled by YouTube.")
    }
    else {
      setBlockedYoutubeUrl(url)
      setMessage('Your browser blocked the YouTube tab. Select Open YouTube to continue.')
    }
    return opened
  }

  const search = async (term: string, autoplay = false, displayText = "", voiceCommand = false) => {
    const clean = term.trim()
    if (!clean) return
    const tabOpened = !autoplay || beginNamedYouTubeSearch(clean)
    if (!tabOpened) {
      setBlockedYoutubeUrl(youtubeSearchUrl(clean))
      setMessage('Your browser blocked the YouTube tab. Select Open YouTube to continue.')
    } else if (autoplay) {
      setBlockedYoutubeUrl('')
    }
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
      const quotaExceeded = /quota|daily.*limit|per.day.*limit/i.test(String(data?.message || data?.detail || ''))
      if (quotaExceeded) {
        setMessage('YouTube quota exhausted. Trying Piped, then Invidious...')
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
          const preferred = bestFullSongMatch(clean, found)
          const ordered = preferred ? [preferred, ...found.filter(track => track.id !== preferred.id)] : found
          const resolved = await resolveYouTubePlayback(clean, ordered, false, async () => [])
          if (resolved.selected) {
            if (playTrack(resolved.selected, found) && voiceCommand) {
              announceVoicePlayback('voice', clean)
            }
          } else navigateResult(resolved.url)
        }
      }
    } catch (error) {
      setResults([])
      const reason = error instanceof Error ? error.message : 'YouTube search failed.'
      if (/quota|daily.*limit|per.day.*limit/i.test(reason)) {
        setMessage('YouTube quota exhausted. Trying Piped, then Invidious...')
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
    if (!youtubeAccount.configured) {
      setMessage('YouTube playlist publishing is not configured yet. Add YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET and YOUTUBE_REDIRECT_URI to the project-root .env file, restart the backend, then connect YouTube.')
      return
    }
    if (!youtubeAccount.connected) {
      setMessage('Connect your YouTube account first. Click Connect YouTube, complete Google authorization, return here, then import the CSV.')
      return
    }
    setBusy(true)
    setMessage(`Importing ${file.name} and matching tracks on YouTube...`)
    try {
      const source = await file.text()
      const entries = parsePlaylistCsv(source)
      if (!entries.length) throw new Error('No song rows found. Use a CSV with Track Name and Artist columns, or title,artist rows.')
      const matched: YouTubeTrack[] = []
      const missing: string[] = []
      for (const entry of entries) {
        const response = await apiFetch(`/api/music/youtube-search?q=${encodeURIComponent(entry)}&limit=20`)
        const data = await readJson<{ success?: boolean; tracks?: YouTubeTrack[]; message?: string; detail?: string }>(response)
        if (!response.ok) {
          if (response.status === 401) throw new Error('Your Visionary Nexus session expired. Sign in again, then retry the CSV import.')
          throw new Error(data?.detail || data?.message || `YouTube search failed for "${entry}" (HTTP ${response.status}).`)
        }
        if (!data) throw new Error(`The music server returned an unreadable response while searching for "${entry}".`)
        if (data.success === false && data.message) {
          if (/no embeddable youtube videos were found/i.test(data.message)) {
            missing.push(entry)
            continue
          }
          throw new Error(`YouTube search could not process "${entry}": ${data.message}`)
        }
        const candidates = (data?.tracks || []).filter(track => track?.id && track?.provider?.toLowerCase() === 'youtube')
        const selected = bestFullSongMatch(entry, candidates)
        if (selected) matched.push(selected)
        else missing.push(entry)
      }
      if (!matched.length) {
        const examples = missing.slice(0, 3).join('; ')
        throw new Error(`No CSV tracks matched a full YouTube song. Checked ${entries.length} tracks. First unmatched entries: ${examples || 'none'}.`)
      }
      const name = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Imported playlist'
      const existing = allSavedPlaylists.find(item => item.name.toLowerCase() === name.toLowerCase())
      if (!youtubeAccount.connected) throw new Error('Connect your YouTube account first using the Connect YouTube button. Google authorization is required to create playlists in your account.')
      const createResponse = await apiFetch('/api/music/youtube-oauth/playlists', {
        method: 'POST',
        body: JSON.stringify({ name, tracks: matched }),
      })
      const created = await readJson<any>(createResponse)
      if (!createResponse.ok || !created?.success || !created?.playlist_id || !created?.playlist_url || !created?.added_count) throw new Error(created?.detail || 'YouTube could not create a playlist with any videos. Check your Google account permissions and try again.')
      const addedIds = new Set<string>(created.added_video_ids || matched.map(track => track.id))
      const savedMatched = matched.filter(track => addedIds.has(track.id)).map(track => ({ ...track, youtubePlaylistId: created.playlist_id, youtubePlaylistUrl: created.playlist_url }))
      setActivePlaylistName(name)
      queueRef.current = []
      setCurrent(savedMatched[0] || matched[0])
      setFallbackUrl(created.playlist_url)
      setFallbackMessage('YouTube playlist created. Open it in YouTube using the link below if needed.')
      // This is only a local shortcut/reference to the YouTube playlist.
      // Mirror the exact contents of the newly created YouTube playlist.
      const next = existing
        ? allSavedPlaylists.map(item => item === existing ? { ...item, tracks: savedMatched, youtubePlaylistId: created.playlist_id, youtubePlaylistUrl: created.playlist_url } : item)
        : [...allSavedPlaylists, { name, tracks: savedMatched, youtubePlaylistId: created.playlist_id, youtubePlaylistUrl: created.playlist_url }]
      let shortcutSaved = true
      try { await persistPlaylists(next) } catch { shortcutSaved = false }
      setMessage('Created and opened the playlist in your YouTube account with ' + created.added_count + ' videos. ' +
        (created.failed_count ? created.failed_count + ' videos could not be added. ' : '') +
        (missing.length ? missing.length + ' CSV tracks had no confident full-song match. ' : '') +
        (shortcutSaved ? 'Visionary Nexus saved a shortcut to that YouTube playlist.' : 'The YouTube playlist is safe, but Visionary Nexus could not save its shortcut.'))
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
    if (!response.ok) throw new Error('Playlist database save failed.')
    setAllSavedPlaylists(next)
    setPlaylists(next
      .map(item => ({ ...item, tracks: (item.tracks || []).filter(track => track?.provider === 'youtube' && track?.id) }))
      .filter(item => item.tracks.length) as SavedPlaylist[])
  }

  const savePlaylist = async () => {
    const name = playlistName.trim()
    const tracks = results.filter(track => selectedTracks.length ? selectedTracks.includes(track.id) : true)
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

  const addTrackToPlaylist = async (track: YouTubeTrack, name: string) => {
    const existing = allSavedPlaylists.find(item => item.name === name)
    if (!existing) return
    if ((existing.tracks || []).some(saved => saved.id === track.id)) {
      setMessage(`"${track.name}" is already in "${name}".`)
      return
    }
    const next = allSavedPlaylists.map(item => item === existing ? { ...item, tracks: [...(item.tracks || []), track] } : item)
    try { await persistPlaylists(next); setMessage(`Added "${track.name}" to "${name}".`) }
    catch { setMessage('Could not update that playlist.') }
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

  const renamePlaylist = async (oldName: string) => {
    const proposed = window.prompt('Rename playlist', oldName)
    const nextName = proposed?.trim()
    if (!nextName || nextName === oldName) return
    if (allSavedPlaylists.some(item => item.name.toLowerCase() === nextName.toLowerCase())) {
      setMessage('A playlist with that name already exists.')
      return
    }
    try {
      await persistPlaylists(allSavedPlaylists.map(item => item.name === oldName ? { ...item, name: nextName } : item))
      if (activePlaylistName === oldName) setActivePlaylistName(nextName)
      setMessage(`Renamed playlist to "${nextName}".`)
    } catch { setMessage('Could not rename that playlist.') }
  }

  const moveTrackInPlaylist = async (name: string, index: number, direction: -1 | 1) => {
    const playlist = allSavedPlaylists.find(item => item.name === name)
    if (!playlist) return
    const tracks = [...(playlist.tracks || [])]
    const target = index + direction
    if (target < 0 || target >= tracks.length) return
    ;[tracks[index], tracks[target]] = [tracks[target], tracks[index]]
    try {
      await persistPlaylists(allSavedPlaylists.map(item => item.name === name ? { ...item, tracks } : item))
      setMessage('Playlist order updated.')
    } catch { setMessage('Could not reorder that playlist.') }
  }

  const playPlaylist = (playlist: SavedPlaylist) => {
    if (!playlist.tracks.length) return
    setActivePlaylistName(playlist.name)
    historyRef.current = []
    const ordered = shuffleQueue ? [...playlist.tracks].sort(() => Math.random() - 0.5) : playlist.tracks
    queueRef.current = ordered.slice(1)
    playTrack(ordered[0])
  }

  const playNext = () => {
    const next = queueRef.current.shift()
    if (next) { playTrack(next); return }
    const active = playlists.find(item => item.name === activePlaylistName)
    if (repeatPlaylist && active?.tracks.length) {
      queueRef.current = active.tracks.slice(1)
      playTrack(active.tracks[0])
    } else setMessage('Your queue is finished.')
  }

  const playPrevious = () => {
    const previous = historyRef.current.pop()
    if (previous) playTrack(previous)
    else setMessage('There is no previous track in playback history.')
  }
  const playNextRef = useRef(playNext)
  playNextRef.current = playNext

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
        setMessage("Use YouTube's playback controls; this page cannot control cross-origin playback.")
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
        queueRef.current = ordered.slice(1)
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
  }, [allSavedPlaylists, activePlaylistName, repeatPlaylist])



  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 text-white md:p-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-xs font-bold tracking-[0.25em] text-red-300">VISIONARY NEXUS | MUSIC</div>
          <h1 className="mt-2 text-3xl font-bold">YouTube Music</h1>
          <p className="mt-1 text-sm text-white/55">YouTube is primary. Piped and Invidious are used when the YouTube API quota runs out; requests stay on YouTube.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void connectYouTube()} className="rounded-full border border-white/20 px-4 py-2 text-xs text-white/75">{youtubeAccount.connected ? "YouTube connected" : "Connect YouTube"}</button>
          {onSpotify && <button onClick={onSpotify} className="rounded-full border border-white/20 px-4 py-2 text-xs text-white/75">Spotify library</button>}
          <span className="rounded-full border border-red-300/30 px-3 py-2 text-xs text-red-200">PRIMARY</span>
        </div>
      </header>

      <form onSubmit={event => { event.preventDefault(); void search(query, true) }} className="flex flex-wrap gap-2 rounded-2xl border border-white/10 bg-white/[0.04] p-3">
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search songs, artists or genres..." className="min-w-0 flex-1 bg-transparent px-3 py-3 text-sm outline-none" />
        <button disabled={busy || !query.trim()} className="rounded-xl bg-red-500 px-6 py-3 text-sm font-semibold text-white disabled:opacity-40">{busy ? 'Searching...' : 'Search YouTube'}</button>
      </form>

      {message && <p className="text-sm text-white/65">{message}</p>}
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


      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
              {playlists.length > 0 && <select aria-label={`Add ${track.name} to playlist`} defaultValue="" onChange={event => { if (event.target.value) void addTrackToPlaylist(track, event.target.value); event.target.value = '' }} className="mt-2 max-w-full rounded-lg border border-white/15 bg-[#101827] px-2 py-1 text-[11px] text-white">
                <option value="">Add to playlist...</option>
                {playlists.map(playlist => <option key={playlist.name} value={playlist.name}>{playlist.name}</option>)}
              </select>}
            </div>
            <button onClick={() => playTrack(track, results)} className="rounded-lg bg-red-500 px-3 py-2 text-xs font-semibold">Play</button>
          </div>
        ))}
        {!results.length && <p className="text-sm text-white/35">Search for a track, artist or genre to see YouTube results.</p>}
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="font-semibold">Your YouTube playlists</h2><p className="text-xs text-white/45">Import CSV, create playlists, add tracks, reorder, rename, shuffle, repeat and remove songs</p></div>
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
              <button onClick={() => void renamePlaylist(playlist.name)} className="rounded-lg border border-white/15 px-2 py-1 text-xs text-white/60">Rename</button>
              <button onClick={() => void deletePlaylist(playlist.name)} className="rounded-lg border border-white/15 px-2 py-1 text-xs text-white/60">Delete</button>
            </div>
            <div className="mt-3 space-y-2">
              {playlist.tracks.map(track => <div key={track.id} className="flex items-center gap-2 text-xs">
                <button onClick={() => { setActivePlaylistName(playlist.name); queueRef.current = playlist.tracks.slice(playlist.tracks.findIndex(item => item.id === track.id) + 1); playTrack(track) }} className="min-w-0 flex-1 truncate text-left text-white/75">{track.name} <span className="text-white/35">- {track.artist}</span></button>
                <button onClick={() => void moveTrackInPlaylist(playlist.name, playlist.tracks.findIndex(item => item.id === track.id), -1)} aria-label={`Move ${track.name} up`} className="px-1 text-white/40 hover:text-white">Up</button>
                <button onClick={() => void moveTrackInPlaylist(playlist.name, playlist.tracks.findIndex(item => item.id === track.id), 1)} aria-label={`Move ${track.name} down`} className="px-1 text-white/40 hover:text-white">Down</button>
                <button onClick={() => void removeTrackFromPlaylist(playlist.name, track.id)} aria-label={`Remove ${track.name} from ${playlist.name}`} className="px-2 text-white/40 hover:text-red-300">Remove</button>
              </div>)}
            </div>
          </div>)}
          {!playlists.length && <p className="text-xs text-white/35">No saved YouTube playlists yet. Search for tracks and create your first playlist.</p>}
        </div>
      </section>
      <p className="text-center text-[11px] text-white/30">CSV imports create a real playlist in your connected YouTube account, add matched videos in order, and open the playlist in a separate tab. Local playlists remain saved in Visionary Nexus.</p>
    </div>
  )
}
