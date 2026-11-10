import { useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch, readJson } from '../services/api'
import { speakText } from '../services/speech'

declare global {
  interface Window {
    Spotify?: any
    onSpotifyWebPlaybackSDKReady?: () => void
  }
}

type SpotifyTrack = {
  id: string
  uri: string
  name: string
  artist: string
  album: string
  duration: number
  image: string
  url: string
  provider: 'spotify'
}

type SpotifyPlaylist = {
  id: string
  uri: string
  name: string
  image: string
  total: number
  owner: string
}

type LocalPlaylist = { name: string; tracks: any[] }

type SpotifyTokens = {
  access_token: string
  refresh_token?: string
  expires_at: number
}

const CLIENT_ID = (import.meta.env.VITE_SPOTIFY_CLIENT_ID as string | undefined || '').trim()
const TOKEN_KEY = 'visionary_spotify_tokens_v1'
const REDIRECT_URI = `${window.location.origin}/spotify/callback`
const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
  'user-read-recently-played',
].join(' ')

function readTokens(): SpotifyTokens | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY)
    const value = raw ? JSON.parse(raw) as SpotifyTokens : null
    return value?.access_token ? value : null
  } catch { return null }
}

function saveTokens(tokens: SpotifyTokens | null) {
  try {
    if (tokens) localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens))
    else localStorage.removeItem(TOKEN_KEY)
  } catch { /* browser storage may be disabled */ }
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  bytes.forEach(value => { binary += String.fromCharCode(value) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return base64Url(new Uint8Array(digest))
}

async function validAccessToken(forceRefresh = false): Promise<string> {
  let tokens = readTokens()
  if (!tokens) throw new Error('Connect your Spotify account first.')
  if (!forceRefresh && tokens.expires_at > Date.now() + 60000) return tokens.access_token
  if (!tokens.refresh_token) {
    saveTokens(null)
    throw new Error('Spotify session expired. Connect Spotify again.')
  }
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    }),
  })
  const refreshed = await response.json()
  if (!response.ok || !refreshed.access_token) {
    saveTokens(null)
    throw new Error('Spotify could not refresh your session. Please connect again.')
  }
  tokens = {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + Number(refreshed.expires_in || 3600) * 1000,
  }
  saveTokens(tokens)
  return tokens.access_token
}

async function spotifyRequest(path: string, init: RequestInit = {}): Promise<any> {
  const token = await validAccessToken()
  const headers = new Headers(init.headers || {})
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  let response = await fetch(`https://api.spotify.com/v1${path}`, { ...init, headers })
  if (response.status === 401) {
    const refreshedToken = await validAccessToken(true)
    headers.set('Authorization', `Bearer ${refreshedToken}`)
    response = await fetch(`https://api.spotify.com/v1${path}`, { ...init, headers })
  }
  if (response.status === 204) return null
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const reason = payload?.error?.message || `Spotify API returned ${response.status}`
    throw new Error(reason)
  }
  return payload
}

function mapTrack(item: any): SpotifyTrack | null {
  if (!item?.id || !item?.uri) return null
  return {
    id: String(item.id),
    uri: String(item.uri),
    name: String(item.name || 'Unknown track'),
    artist: (item.artists || []).map((artist: any) => artist.name).filter(Boolean).join(', ') || 'Unknown artist',
    album: String(item.album?.name || ''),
    duration: Number(item.duration_ms || 0),
    image: String(item.album?.images?.[0]?.url || ''),
    url: String(item.external_urls?.spotify || ''),
    provider: 'spotify',
  }
}

function loadSpotifySdk(): Promise<any> {
  if (window.Spotify?.Player) return Promise.resolve(window.Spotify)
  return new Promise((resolve, reject) => {
    const previous = window.onSpotifyWebPlaybackSDKReady
    const timer = window.setTimeout(() => reject(new Error('Spotify player SDK did not load. Check your connection.')), 15000)
    window.onSpotifyWebPlaybackSDKReady = () => {
      window.clearTimeout(timer)
      previous?.()
      if (window.Spotify?.Player) resolve(window.Spotify)
      else reject(new Error('Spotify player SDK loaded without a Player constructor.'))
    }
    if (!document.querySelector('script[src="https://sdk.scdn.co/spotify-player.js"]')) {
      const script = document.createElement('script')
      script.src = 'https://sdk.scdn.co/spotify-player.js'
      script.async = true
      script.onerror = () => {
        window.clearTimeout(timer)
        reject(new Error('Could not load Spotify playback SDK.'))
      }
      document.head.appendChild(script)
    }
  })
}

function formatTime(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function spotifySearchRelevance(query: string, tracks: SpotifyTrack[]): number {
  const ignored = new Set(['a', 'an', 'and', 'by', 'for', 'i', 'in', 'me', 'my', 'of', 'on', 'or', 'please', 'song', 'the', 'to', 'track', 'want'])
  const tokens = query.toLowerCase().match(/[a-z0-9]+/g)?.filter(token => !ignored.has(token)) || []
  if (!tokens.length) return 1
  return Math.max(0, ...tracks.map(track => {
    const text = `${track.name} ${track.artist} ${track.album}`.toLowerCase()
    return tokens.filter(token => text.includes(token)).length / tokens.length
  }))
}

export default function SpotifyMusic({ initialShowSoundCloud = false, onYouTube }: { initialShowSoundCloud?: boolean; onYouTube?: () => void }) {
  const [tokens, setTokenState] = useState<SpotifyTokens | null>(() => readTokens())
  const [profileName, setProfileName] = useState('')
  const [accountProduct, setAccountProduct] = useState<'premium' | 'free' | ''>('')
  const [showSoundCloud, setShowSoundCloud] = useState(initialShowSoundCloud)
  const [playlists, setPlaylists] = useState<SpotifyPlaylist[]>([])
  const [localPlaylists, setLocalPlaylists] = useState<LocalPlaylist[]>([])
  const [results, setResults] = useState<SpotifyTrack[]>([])
  const [query, setQuery] = useState('')
  const [playlistName, setPlaylistName] = useState('')
  const [current, setCurrent] = useState<SpotifyTrack | null>(null)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(70)
  const [deviceReady, setDeviceReady] = useState(false)
  const [spotifyPlaybackBlocked, setSpotifyPlaybackBlocked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [activeLibraryTab, setActiveLibraryTab] = useState<'spotify' | 'saved'>('spotify')
  const playerRef = useRef<any>(null)
  const deviceIdRef = useRef<string | null>(null)
  const searchResultsRef = useRef<SpotifyTrack[]>([])
  const tokenReady = Boolean(tokens?.access_token)

  const redirectIsLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname)
  const configured = Boolean(CLIENT_ID)

  const persistLocalPlaylists = (next: LocalPlaylist[]) => {
    setLocalPlaylists(next)
    void (async () => {
      try {
        const existingResponse = await apiFetch('/api/music/playlists')
        const existingData = await readJson<{ playlists?: any[] }>(existingResponse)
        const externalPlaylists = (existingData?.playlists || []).filter(item =>
          Array.isArray(item?.tracks) && item.tracks.some((track: any) => track?.provider === 'audius' || track?.provider === 'youtube')
        )
        const merged = [
          ...externalPlaylists,
          ...next.filter(item => !externalPlaylists.some(saved => saved.name.toLowerCase() === item.name.toLowerCase())),
        ]
        const response = await apiFetch('/api/music/playlists', {
          method: 'PUT',
          body: JSON.stringify({ playlists: merged }),
        })
        if (!response.ok) throw new Error('Playlist database save failed.')
      } catch {
        setMessage('Playlist saved in this session, but database sync failed.')
      }
    })()
  }

  useEffect(() => {
    searchResultsRef.current = results
  }, [results])

  useEffect(() => {
    const pathIsCallback = window.location.pathname === '/spotify/callback'
    if (!pathIsCallback) return
    let cancelled = false
    const finishAuthorization = async () => {
      const params = new URLSearchParams(window.location.search)
      const code = params.get('code')
      const returnedState = params.get('state')
      const expectedState = sessionStorage.getItem('vn_spotify_oauth_state')
      const verifier = sessionStorage.getItem('vn_spotify_pkce_verifier')
      if (params.get('error')) throw new Error(`Spotify authorization failed: ${params.get('error')}`)
      if (!code || !returnedState || returnedState !== expectedState || !verifier) {
        throw new Error('Spotify sign-in could not be verified. Start Connect Spotify again.')
      }
      const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
        }),
      })
      const payload = await response.json()
      if (!response.ok || !payload.access_token) throw new Error(payload?.error_description || 'Spotify token exchange failed.')
      const nextTokens: SpotifyTokens = {
        access_token: payload.access_token,
        refresh_token: payload.refresh_token,
        expires_at: Date.now() + Number(payload.expires_in || 3600) * 1000,
      }
      if (!cancelled) {
        saveTokens(nextTokens)
        setTokenState(nextTokens)
        setMessage('Spotify connected successfully.')
        window.history.replaceState({}, document.title, '/')
      }
      sessionStorage.removeItem('vn_spotify_oauth_state')
      sessionStorage.removeItem('vn_spotify_pkce_verifier')
    }
    void finishAuthorization().catch(error => {
      if (!cancelled) {
        setMessage(error instanceof Error ? error.message : 'Spotify sign-in failed.')
        window.history.replaceState({}, document.title, '/')
      }
    })
    return () => { cancelled = true }
  }, [])

  const connectSpotify = async () => {
    if (!CLIENT_ID) {
      setMessage('Add VITE_SPOTIFY_CLIENT_ID to Frontend/.env.local, then restart the Vite frontend.')
      return
    }
    if (!redirectIsLocal && window.location.protocol !== 'https:') {
      setMessage('For local Spotify sign-in, open Visionary Nexus on this PC at http://127.0.0.1:8443.')
      return
    }
    try {
      const verifier = base64Url(crypto.getRandomValues(new Uint8Array(64)))
      const challenge = await sha256(verifier)
      const state = base64Url(crypto.getRandomValues(new Uint8Array(24)))
      sessionStorage.setItem('vn_spotify_pkce_verifier', verifier)
      sessionStorage.setItem('vn_spotify_oauth_state', state)
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        state,
        scope: SCOPES,
      })
      window.location.assign(`https://accounts.spotify.com/authorize?${params.toString()}`)
    } catch {
      setMessage('Your browser could not start secure Spotify sign-in.')
    }
  }

  useEffect(() => {
    let cancelled = false
    const hydrate = async () => {
      try {
        const response = await apiFetch('/api/music/playlists')
        const data = await readJson<{ playlists?: LocalPlaylist[] }>(response)
        if (!cancelled && Array.isArray(data?.playlists)) {
          setLocalPlaylists(data.playlists.filter(item => !item.tracks.some((track: any) => track?.provider === 'youtube' || track?.provider === 'audius')))
        }
      } catch { /* saved playlists remain available after backend reconnect */ }
    }
    void hydrate()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!tokenReady) {
      setAccountProduct('')
      return
    }
    let cancelled = false
    const loadAccount = async () => {
      try {
        // Spotify's /me profile includes the account product when user-read-private is granted.
        // Never initialize the Web Playback SDK until Spotify confirms product === "premium".
        const profile = await spotifyRequest('/me')
        if (cancelled) return
        const product = String(profile?.product || '').toLowerCase()
        setProfileName(profile?.display_name || profile?.id || 'Spotify account')
        setAccountProduct(product === 'premium' ? 'premium' : 'free')
        if (product !== 'premium') {
          setPlaylists([])
          setMessage('This Spotify account is not Premium. Free YouTube playback is active instead.')
          return
        }
        const library = await spotifyRequest('/me/playlists?limit=50')
        if (cancelled) return
        const mapped = (library?.items || []).map((item: any) => ({
          id: String(item.id),
          uri: String(item.uri),
          name: String(item.name || 'Untitled playlist'),
          image: String(item.images?.[0]?.url || ''),
          total: Number(item.items?.total ?? item.tracks?.total ?? 0),
          owner: String(item.owner?.display_name || item.owner?.id || ''),
        }))
        setPlaylists(mapped)
      } catch (error) {
        if (!cancelled) {
          setAccountProduct('free')
          setMessage(error instanceof Error ? error.message : 'Could not verify Spotify Premium. Using YouTube instead.')
        }
      }
    }
    void loadAccount()
    return () => { cancelled = true }
  }, [tokenReady])

  useEffect(() => {
    if (!tokenReady || accountProduct !== 'premium' || spotifyPlaybackBlocked) return
    let cancelled = false
    let player: any = null
    const setup = async () => {
      try {
        const Spotify = await loadSpotifySdk()
        if (cancelled) return
        player = new Spotify.Player({
          name: 'Visionary Nexus',
          getOAuthToken: async (callback: (token: string) => void) => {
            try { callback(await validAccessToken()) } catch { setMessage('Spotify session expired. Reconnect your account.') }
          },
          volume: volume / 100,
        })
        player.addListener('ready', ({ device_id }: { device_id: string }) => {
          if (cancelled) return
          deviceIdRef.current = device_id
          setDeviceReady(true)
          setMessage('Spotify player ready. Select a song or playlist to play.')
          void player?.getCurrentState?.().then((state: any) => {
            if (!state || cancelled) return
            const active = state.track_window?.current_track
            if (active) setCurrent(mapTrack(active))
            setPlaying(!state.paused)
            setPosition(Number(state.position || 0))
            setDuration(Number(state.duration || 0))
          }).catch(() => {})
        })
        player.addListener('not_ready', () => {
          deviceIdRef.current = null
          setDeviceReady(false)
        })
        player.addListener('initialization_error', ({ message: detail }: any) => setMessage(`Spotify player initialization: ${detail}`))
        player.addListener('authentication_error', ({ message: detail }: any) => setMessage(`Spotify authentication: ${detail}`))
        player.addListener('account_error', ({ message: detail }: any) => {
          setSpotifyPlaybackBlocked(true)
          setMessage(`Spotify in-app playback requires Premium. Audius is available as an alternative. ${detail || ''}`.trim())
        })
        player.addListener('playback_error', ({ message: detail }: any) => setMessage(`Spotify playback: ${detail}`))
        player.addListener('player_state_changed', (state: any) => {
          if (!state || cancelled) return
          const track = state.track_window?.current_track
          if (track) setCurrent(mapTrack({
            ...track,
            album: { name: track.album?.name || '', images: track.album?.images || [] },
          }))
          setPlaying(!state.paused)
          setPosition(Number(state.position || 0))
          setDuration(Number(state.duration || 0))
        })
        playerRef.current = player
        await player.connect()
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : 'Could not initialize Spotify playback.')
      }
    }
    void setup()
    return () => {
      cancelled = true
      deviceIdRef.current = null
      setDeviceReady(false)
      if (player) void player.disconnect()
      if (playerRef.current === player) playerRef.current = null
    }
  }, [tokenReady, accountProduct, spotifyPlaybackBlocked])

  useEffect(() => {
    playerRef.current?.setVolume?.(volume / 100)
  }, [volume])

  const playUri = async (uri: string, context = false) => {
    if (!deviceIdRef.current) throw new Error('Spotify player is still connecting. Wait for Player ready, then try again.')
    await playerRef.current?.activateElement?.()
    await spotifyRequest(`/me/player/play?device_id=${encodeURIComponent(deviceIdRef.current)}`, {
      method: 'PUT',
      body: JSON.stringify(context ? { context_uri: uri } : { uris: [uri] }),
    })
    setPlaying(true)
    setSpotifyPlaybackBlocked(false)
    setMessage('')
  }

  const playTrack = async (track: SpotifyTrack) => {
    try {
      setCurrent(track)
      await playUri(track.uri)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Spotify could not start this track.')
    }
  }

  const playSpotifyPlaylist = async (playlist: SpotifyPlaylist) => {
    try {
      setPlaylistName(playlist.name)
      await playUri(playlist.uri, true)
      speakText(`Playing your Spotify playlist ${playlist.name}.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not play this Spotify playlist.')
    }
  }

  const searchSpotify = async (term: string, autoplay = false) => {
    const clean = term.trim()
    if (!clean) return
    const playlistKey = (value: string) => value.toLocaleLowerCase().replace(/\b(?:my|the)\b/g, ' ').replace(/\bplaylist\b/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
    const requestedPlaylist = playlistKey(clean)
    const exactSpotifyPlaylist = playlists.find(item => playlistKey(item.name) === requestedPlaylist)
    const partialSpotifyPlaylists = playlists.filter(item => {
      const name = playlistKey(item.name)
      return name && requestedPlaylist && (name.includes(requestedPlaylist) || requestedPlaylist.includes(name))
    })
    const spotifyPlaylist = exactSpotifyPlaylist || (partialSpotifyPlaylists.length === 1 ? partialSpotifyPlaylists[0] : null)
    if (spotifyPlaylist) {
      setQuery(clean)
      await playSpotifyPlaylist(spotifyPlaylist)
      setMessage('Opening playlist: ' + spotifyPlaylist.name)
      return
    }
    const exactLocalPlaylist = localPlaylists.find(item => playlistKey(item.name) === requestedPlaylist)
    const partialLocalPlaylists = localPlaylists.filter(item => {
      const name = playlistKey(item.name)
      return name && requestedPlaylist && (name.includes(requestedPlaylist) || requestedPlaylist.includes(name))
    })
    const localPlaylist = exactLocalPlaylist || (partialLocalPlaylists.length === 1 ? partialLocalPlaylists[0] : null)
    if (localPlaylist) {
      setQuery(clean)
      await playLocalPlaylist(localPlaylist)
      return
    }
    setBusy(true)
    setQuery(clean)
    setMessage('Searching Spotify…')
    try {
      let payload = await spotifyRequest(`/search?type=track&limit=10&q=${encodeURIComponent(clean)}`)
      let mapped = (payload?.tracks?.items || []).map(mapTrack).filter(Boolean) as SpotifyTrack[]
      let corrected = clean
      const originalRelevance = spotifySearchRelevance(clean, mapped)
      if (!mapped.length || originalRelevance < 0.5) {
        try {
          const correction = await apiFetch('/api/music/correct-query', {
            method: 'POST',
            body: JSON.stringify({ query: clean }),
          })
          const normalized = await readJson<{ corrected_query?: string }>(correction)
          const candidate = normalized?.corrected_query?.trim()
          if (candidate && candidate.toLowerCase() !== clean.toLowerCase()) {
            payload = await spotifyRequest(`/search?type=track&limit=10&q=${encodeURIComponent(candidate)}`)
            const correctedTracks = (payload?.tracks?.items || []).map(mapTrack).filter(Boolean) as SpotifyTrack[]
            if (correctedTracks.length && spotifySearchRelevance(candidate, correctedTracks) > originalRelevance) {
              mapped = correctedTracks
              corrected = candidate
            }
          }
        } catch { /* AI correction is optional; keep the original Spotify results */ }
      }
      setResults(mapped)
      if (corrected !== clean) setMessage(`Search spelling corrected to “${corrected}”.`)
      else setMessage(mapped.length ? `Found ${mapped.length} Spotify tracks.` : 'No Spotify matches found. Try the artist name or a shorter title.')
      if (autoplay && mapped.length) await playTrack(mapped[0])
    } catch (error) {
      setResults([])
      setMessage(error instanceof Error ? error.message : 'Spotify search failed.')
    } finally {
      setBusy(false)
    }
  }

  const loadPlaylistItems = async (playlist: SpotifyPlaylist): Promise<SpotifyTrack[]> => {
    const payload = await spotifyRequest(`/playlists/${encodeURIComponent(playlist.id)}/items?limit=50`)
    return (payload?.items || []).map((entry: any) => mapTrack(entry?.item)).filter(Boolean) as SpotifyTrack[]
  }

  const addToQueue = async (track: SpotifyTrack) => {
    try {
      await spotifyRequest(`/me/player/queue?uri=${encodeURIComponent(track.uri)}`, { method: 'POST' })
      setMessage(`Added ${track.name} to the Spotify queue.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not add track to Spotify queue.')
    }
  }

  const saveSearchAsPlaylist = () => {
    const name = playlistName.trim()
    if (!name || !results.length) {
      setMessage('Enter a playlist name and search for tracks first.')
      return
    }
    const next = [...localPlaylists.filter(item => item.name.toLowerCase() !== name.toLowerCase()), { name, tracks: results }]
    persistLocalPlaylists(next)
    setMessage(`Saved ${results.length} Spotify tracks to “${name}” in Visionary Nexus.`)
  }

  const playLocalPlaylist = async (playlist: LocalPlaylist) => {
    if (!playlist.tracks.length) return setMessage(`“${playlist.name}” is empty.`)
    setBusy(true)
    try {
      const resolved: SpotifyTrack[] = []
      for (const saved of playlist.tracks.slice(0, 30)) {
        const mapped = mapTrack(saved)
        if (mapped) {
          resolved.push(mapped)
          continue
        }
        const term = [saved?.name, saved?.artist].filter(Boolean).join(' ')
        if (!term) continue
        const payload = await spotifyRequest(`/search?type=track&limit=5&q=${encodeURIComponent(term)}`)
        const found = (payload?.tracks?.items || []).map(mapTrack).filter(Boolean) as SpotifyTrack[]
        if (found[0]) resolved.push(found[0])
      }
      if (!resolved.length) throw new Error('No saved songs could be matched to Spotify.')
      await playTrack(resolved[0])
      for (const track of resolved.slice(1)) await addToQueue(track)
      setMessage(`Playing “${playlist.name}” from Spotify. ${resolved.length} tracks loaded.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not play this saved playlist.')
    } finally { setBusy(false) }
  }

  const control = async (action: 'pause' | 'resume' | 'next' | 'previous') => {
    try {
      if (action === 'pause') await playerRef.current?.pause()
      if (action === 'resume') await playerRef.current?.resume()
      if (action === 'next') await playerRef.current?.nextTrack()
      if (action === 'previous') await playerRef.current?.previousTrack()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Spotify ${action} failed.`)
    }
  }

  useEffect(() => {
    if (!tokenReady || accountProduct !== 'premium' || spotifyPlaybackBlocked) return
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string; activeTab?: string; action?: string; query?: string }>).detail
      if (detail?.activeTab !== 'music' || showSoundCloud) return
      const action = (detail.action || '').toLowerCase()
      const text = (detail.text || '').toLowerCase().replace(/[.!?,]+/g, ' ').replace(/\s+/g, ' ').trim()
      if (action === 'pause' || /^(pause|stop)( music)?$/.test(text)) { void control('pause'); speakText('Pausing Spotify.'); return }
      if (action === 'resume' || /^(resume|continue)( music)?$/.test(text)) { void control('resume'); speakText('Resuming Spotify.'); return }
      if (action === 'next' || /^(next|skip)( song| track)?$/.test(text)) { void control('next'); speakText('Skipping to the next track.'); return }
      if (action === 'previous' || /^(previous|back)( song| track)?$/.test(text)) { void control('previous'); speakText('Playing the previous track.'); return }
      const target = (detail.query || '').trim() || text.replace(/^(please )?(play|listen to|put on|start playing|i want to listen to)\s+/, '').replace(/\b(my|the|playlist|music|song)\b/g, '').trim()
      if (!target || /^(music|something|spotify)$/.test(target)) {
        setMessage('Music is ready. Say a song or one of your playlist names.')
        return
      }
      const playlist = playlists.find(item => item.name.toLowerCase() === target.toLowerCase()) ||
        playlists.find(item => item.name.toLowerCase().includes(target.toLowerCase()) || target.toLowerCase().includes(item.name.toLowerCase()))
      if (playlist) { void playSpotifyPlaylist(playlist); return }
      const saved = localPlaylists.find(item => item.name.toLowerCase() === target.toLowerCase() || item.name.toLowerCase().includes(target.toLowerCase()))
      if (saved) { void playLocalPlaylist(saved); return }

      // Keep typed and spoken requests on Spotify. Do not hand an unmatched
      // Spotify query to SoundCloud, where long-form mixes can outrank the song.
      void searchSpotify(target, action !== 'search' && action !== 'open')
    }
    window.addEventListener('visionary:voice-command', handler)
    return () => window.removeEventListener('visionary:voice-command', handler)
  }, [playlists, localPlaylists, tokens, current, tokenReady, accountProduct, spotifyPlaybackBlocked, showSoundCloud])

  const sortedPlaylists = useMemo(() => [...playlists].sort((a, b) => a.name.localeCompare(b.name)), [playlists])

  if (window.location.pathname === '/spotify/callback') {
    return <div className="min-h-screen bg-[#080808] text-white grid place-items-center"><div className="text-center"><div className="text-2xl font-semibold">Connecting Spotify…</div><p className="mt-2 text-sm text-white/60">Finishing secure account authorization.</p></div></div>
  }

  if (!configured || !tokenReady || accountProduct !== 'premium' || spotifyPlaybackBlocked) {
    return (
      <div className="min-h-screen bg-[#080808] p-6 text-white">
        <div className="mx-auto mt-16 max-w-lg rounded-2xl border border-white/10 bg-[#151515] p-6">
          <h2 className="text-xl font-semibold">Spotify Premium (optional)</h2>
          <p className="mt-2 text-sm text-white/65">
            {!configured
              ? 'Spotify is not configured. YouTube remains the primary music player.'
              : !tokenReady
                ? 'Connect a Spotify account to check Premium access. YouTube remains available.'
                : accountProduct === 'free'
                  ? 'This Spotify account does not have Premium. Spotify playback is unavailable; YouTube remains your music player.'
                  : 'Spotify playback is unavailable for this session. YouTube remains your music player.'}
          </p>
          {configured && <button onClick={() => void connectSpotify()} className="mt-4 rounded-full bg-[#1ed760] px-4 py-2 text-sm font-bold text-black">Connect Spotify</button>}
          <button onClick={onYouTube} className="ml-2 mt-4 rounded-full border border-white/20 px-4 py-2 text-sm">Back to YouTube Music</button>
          {message && <p className="mt-3 text-xs text-amber-200">{message}</p>}
        </div>
      </div>
    )
  }

  return (
    <div className="page-stack vn-figma-music vn-spotify-page p-4 md:p-8">
      <div className="mx-auto max-w-7xl space-y-6 music-layout vn-spotify-content">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="text-xs font-bold tracking-[0.25em] text-[#1ed760]">VISIONARY NEXUS · MUSIC</div>
            <h1 className="mt-2 text-3xl font-bold">Music</h1>
            <p className="mt-1 text-sm text-white/50">Connected as {profileName || 'Spotify account'}</p>
          </div>
          <div className="flex items-center gap-3">
            <span className={`rounded-full border px-3 py-2 text-xs ${deviceReady ? 'border-[#1ed760]/40 text-[#1ed760]' : 'border-amber-400/30 text-amber-200'}`}>{deviceReady ? 'PLAYER READY' : 'CONNECTING PLAYER'}</span>
            <button onClick={() => { saveTokens(null); setTokenState(null); setPlaylists([]); setCurrent(null); setSpotifyPlaybackBlocked(false); setMessage('Spotify disconnected.') }} className="rounded-full border border-white/15 px-4 py-2 text-xs text-white/70">Disconnect</button>
          </div>
        </header>

        {message && <div className="rounded-xl border border-white/10 bg-[#151515] px-4 py-3 text-sm text-white/75">{message}</div>}
        <div className="space-y-2">
          <form onSubmit={event => { event.preventDefault(); void searchSpotify(query) }} className="flex gap-2 rounded-full bg-[#242424] p-2">
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="What do you want to play?" className="min-w-0 flex-1 bg-transparent px-4 text-sm outline-none placeholder:text-white/40" />
            <button disabled={busy || !query.trim()} className="rounded-full bg-[#1ed760] px-6 py-3 text-sm font-bold text-black disabled:opacity-40">{busy ? 'Searching…' : 'Search Spotify'}</button>
          </form>
        </div>

        <section className="grid gap-5 lg:grid-cols-[1.3fr_0.7fr]">
          <div className="music-player panel rounded-3xl bg-gradient-to-br from-[#202020] to-[#111] p-6">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-white/45">Now playing</div>
            <div className="mt-5 flex flex-col gap-5 sm:flex-row sm:items-center">
              {current?.image ? <img src={current.image} alt="" className="h-36 w-36 rounded-2xl object-cover shadow-2xl" /> : <div className="grid h-36 w-36 place-items-center rounded-2xl bg-[#252525] text-5xl">â™«</div>}
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-2xl font-bold">{current?.name || 'Nothing playing yet'}</h2>
                <p className="mt-1 truncate text-sm text-white/55">{current?.artist || 'Choose a song or playlist to begin'}</p>
                {current?.album && <p className="mt-1 truncate text-xs text-white/35">{current.album}</p>}
              </div>
            </div>
            <div className="mt-6 flex items-center justify-center gap-5">
              <button disabled={!deviceReady} onClick={() => void control('previous')} aria-label="Previous track" className="text-2xl text-white/70 disabled:opacity-30">|â—€</button>
              <button disabled={!deviceReady} onClick={() => void control(playing ? 'pause' : 'resume')} aria-label={playing ? 'Pause' : 'Play'} className="grid h-14 w-14 place-items-center rounded-full bg-[#1ed760] text-2xl text-black disabled:opacity-30">{playing ? 'Ⅱ' : '▶'}</button>
              <button disabled={!deviceReady} onClick={() => void control('next')} aria-label="Next track" className="text-2xl text-white/70 disabled:opacity-30">▶|</button>
            </div>
            <div className="mt-5 flex items-center gap-3 text-[11px] tabular-nums text-white/45">
              <span>{formatTime(position)}</span>
              <input aria-label="Playback position" type="range" min={0} max={Math.max(duration, 1)} value={Math.min(position, duration || 0)} onChange={event => void playerRef.current?.seek(Number(event.target.value))} className="flex-1 accent-[#1ed760]" />
              <span>{formatTime(duration)}</span>
            </div>
            <div className="mt-4 flex items-center gap-3 text-xs text-white/45">
              <span>Volume</span>
              <input aria-label="Volume" type="range" min={0} max={100} value={volume} onChange={event => setVolume(Number(event.target.value))} className="flex-1 accent-[#1ed760]" />
              <span className="w-8 text-right">{volume}%</span>
            </div>
          </div>

          <div className="music-library panel rounded-3xl bg-[#121212] p-6">
            <div className="flex gap-2 rounded-full bg-black/40 p-1">
              <button onClick={() => setActiveLibraryTab('spotify')} className={`flex-1 rounded-full px-3 py-2 text-xs ${activeLibraryTab === 'spotify' ? 'bg-[#2a2a2a] text-white' : 'text-white/45'}`}>Spotify library</button>
              <button onClick={() => setActiveLibraryTab('saved')} className={`flex-1 rounded-full px-3 py-2 text-xs ${activeLibraryTab === 'saved' ? 'bg-[#2a2a2a] text-white' : 'text-white/45'}`}>Saved here</button>
            </div>
            {activeLibraryTab === 'spotify' ? (
              <div className="mt-4 max-h-[340px] space-y-2 overflow-y-auto">
                {sortedPlaylists.map(playlist => (
                  <button key={playlist.id} onClick={() => void playSpotifyPlaylist(playlist)} className="flex w-full items-center gap-3 rounded-xl p-2 text-left hover:bg-white/5">
                    {playlist.image ? <img src={playlist.image} alt="" className="h-12 w-12 rounded-lg object-cover" /> : <div className="grid h-12 w-12 place-items-center rounded-lg bg-[#252525]">â™«</div>}
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm">{playlist.name}</span><span className="block text-xs text-white/40">{playlist.total || 'Playlist'} tracks</span></span>
                    <span className="text-[#1ed760]">▶</span>
                  </button>
                ))}
                {!playlists.length && <p className="py-6 text-sm text-white/40">No playlists returned by Spotify yet.</p>}
              </div>
            ) : (
              <div className="mt-4 max-h-[340px] space-y-2 overflow-y-auto">
                {localPlaylists.map(playlist => (
                  <div key={playlist.name} className="flex items-center gap-2 rounded-xl p-2 hover:bg-white/5">
                    <button onClick={() => void playLocalPlaylist(playlist)} className="min-w-0 flex-1 text-left"><span className="block truncate text-sm">{playlist.name}</span><span className="text-xs text-white/40">{playlist.tracks.length} saved tracks</span></button>
                    <button onClick={() => persistLocalPlaylists(localPlaylists.filter(item => item.name !== playlist.name))} className="px-2 text-xs text-white/35 hover:text-red-300">Remove</button>
                  </div>
                ))}
                {!localPlaylists.length && <p className="py-6 text-sm text-white/40">Save a search result collection here to build a local playlist.</p>}
              </div>
            )}
            <div className="mt-4 border-t border-white/10 pt-4">
              <input value={playlistName} onChange={event => setPlaylistName(event.target.value)} placeholder="Name this local playlist" className="w-full rounded-lg bg-black/40 px-3 py-2 text-sm outline-none" />
              <button onClick={saveSearchAsPlaylist} disabled={!results.length} className="mt-2 w-full rounded-full border border-[#1ed760]/40 px-3 py-2 text-xs text-[#1ed760] disabled:opacity-30">Save search results as playlist</button>
            </div>
          </div>
        </section>

        <section className="search-results panel rounded-3xl bg-[#121212] p-5 md:p-6">
          <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Search results</h2><span className="text-xs text-white/40">{results.length} tracks</span></div>
          {results.length ? <div className="space-y-1">{results.map(track => (
            <div key={track.id} className="flex items-center gap-3 rounded-xl p-2 hover:bg-white/5">
              {track.image ? <img src={track.image} alt="" className="h-12 w-12 rounded-lg object-cover" /> : <div className="h-12 w-12 rounded-lg bg-[#252525]" />}
              <button onClick={() => void playTrack(track)} className="min-w-0 flex-1 text-left"><span className="block truncate text-sm">{track.name}</span><span className="block truncate text-xs text-white/45">{track.artist} · {track.album}</span></button>
              <span className="hidden text-xs text-white/35 sm:block">{formatTime(track.duration)}</span>
              <button onClick={() => void addToQueue(track)} className="rounded-full border border-white/10 px-3 py-2 text-xs text-white/60">Queue</button>
              <button onClick={() => void playTrack(track)} className="rounded-full bg-[#1ed760] px-3 py-2 text-xs font-bold text-black">Play</button>
            </div>
          ))}</div> : <p className="py-8 text-center text-sm text-white/35">Search for a track, artist or album to get started.</p>}
        </section>
        <p className="text-center text-[11px] text-white/25">Playback is provided by Spotify. A Spotify Premium account is required for the in-app Web Playback SDK.</p>
      </div>
    </div>
  )
}
