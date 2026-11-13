export type MusicCommandAction = 'play' | 'search' | 'open' | 'pause' | 'stop' | 'resume' | 'next' | 'previous'

export interface MusicCommand {
  action: MusicCommandAction
  query: string
}

export interface YouTubeCandidate {
  id?: string
  name?: string
  artist?: string
}

const speechTokens = (value: string) =>
  Array.from(value.matchAll(/[\p{L}\p{N}]+/gu), match => ({
    value: match[0].toLocaleLowerCase(),
    end: (match.index || 0) + match[0].length,
  }))

export function normalizeWakeText(value: string) {
  return speechTokens(value).map(token => token.value).join(' ')
}

function editDistanceOne(a: string, b: string) {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    if (++edits > 1) return false
    if (a.length > b.length) i++
    else if (b.length > a.length) j++
    else {
      i++
      j++
    }
  }
  if (i < a.length || j < b.length) edits++
  return edits <= 1
}

export interface WakeUtteranceResult {
  matched: boolean
  command: string
  armed: boolean
}

export function consumeWakeUtterance(
  transcript: string,
  wakeWord: string,
  sensitivity: string,
  armed = false,
): WakeUtteranceResult {
  if (armed) return { matched: false, command: transcript.trim(), armed: false }

  const words = speechTokens(transcript)
  const phrase = speechTokens(wakeWord || 'Vision').map(token => token.value)
  if (!phrase.length) return { matched: false, command: '', armed: false }

  for (let index = 0; index <= words.length - phrase.length; index++) {
    const matches = phrase.every((part, offset) =>
      words[index + offset].value === part ||
      (sensitivity === 'high' && part.length >= 5 && editDistanceOne(words[index + offset].value, part)),
    )
    if (!matches) continue

    const afterPhrase = words[index + phrase.length - 1].end
    const command = transcript.slice(afterPhrase).replace(/^[\s,.;:!?—-]+/u, '').trim()
    return { matched: true, command, armed: !command }
  }
  return { matched: false, command: '', armed: false }
}

const cleanCommandQuery = (value: string) =>
  value.trim().replace(/\s+on\s+youtube\s*$/i, '').replace(/[.!?]+\s*$/u, '').trim()

export function parseMusicCommand(input: string): MusicCommand | null {
  let text = input.trim()
  text = text.replace(/^(?:(?:hey|okay|ok)\s+)?vision(?:ary nexus)?[\s,:.!?-]*/i, '')
  if (!text) return null

  // A no-current-playback statement is also a request to start choosing music.
  // Keep this local so it does not fall through to ordinary AI chat.
  if (/^(?:there(?:'s| is)\s+)?no\s+(?:song|music)\s+(?:is\s+)?playing[.!?]*$/i.test(text) ||
      /^(?:nothing|no music|no song)\s+(?:is\s+)?playing[.!?]*$/i.test(text) ||
      /^(?:i have|there is)\s+no\s+(?:music|song)\s+playing[.!?]*$/i.test(text)) {
    return { action: 'open', query: '' }
  }

  if (/^(?:(?:i want to|i would like to|i'd like to|let me|can i|could i|i wanna)\s+)?(?:listen(?:\s+to)?|hear)(?:\s+(?:something|anything|some music|music|a song|some songs|a track))?[.!?]*$/i.test(text)) {
    return { action: 'open', query: '' }
  }

  const controls: Array<[RegExp, MusicCommandAction]> = [
    [/^(?:please\s+)?pause(?:\s+(?:the\s+)?(?:music|song|track|playback))?[.!?]*$/i, 'pause'],
    [/^(?:please\s+)?stop(?:\s+(?:the\s+)?(?:music|song|track|playback))?[.!?]*$/i, 'stop'],
    [/^(?:please\s+)?(?:resume|continue)(?:\s+(?:the\s+)?(?:music|song|track|playback))?[.!?]*$/i, 'resume'],
    [/^(?:please\s+)?(?:next|skip)(?:\s+(?:song|track))?[.!?]*$/i, 'next'],
    [/^(?:please\s+)?previous(?:\s+(?:song|track))?[.!?]*$/i, 'previous'],
  ]
  for (const [pattern, action] of controls) {
    if (pattern.test(text)) return { action, query: '' }
  }

  if (/^(?:please\s+)?open\s+(?:the\s+)?(?:youtube\s+)?music(?:\s+(?:tab|player))?[.!?]*$/i.test(text)) {
    return { action: 'open', query: '' }
  }

  const putOn = text.match(/^(?:please\s+)?put\s+(?:my\s+)?(.+?)\s+on[.!?]*$/i)
  if (putOn) return { action: 'play', query: cleanCommandQuery(putOn[1]) }

  const request = text.match(
    /^(?:(?:please|can you|could you|would you|will you|i want to|i would like to|i'd like to|let me)\s+)*(play|start playing|listen to|put on|search for|find(?: me)?)\s+(.+?)\s*[.!?]*$/i,
  )
  if (!request) return null

  const verb = request[1].toLowerCase()
  const query = cleanCommandQuery(request[2])
  if (!query) return null
  if (verb === 'search for' || verb.startsWith('find')) return { action: 'search', query }
  if (/^(?:it|that|this)(?:\s+again)?$/i.test(query)) {
    return { action: 'resume', query: '' }
  }
  return { action: 'play', query }
}

// Ignore whitespace and punctuation when comparing playlist names, but keep
// every letter and number. A playlist is selected only when the complete
// normalized query equals its name; extra words must remain a YouTube search.
const playlistKey = (value: string) =>
  value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

export function findSavedPlaylist<T extends { name: string }>(query: string, playlists: T[]): T | null {
  const key = playlistKey(query.replace(/^(?:my|the)\s+/i, '').replace(/\s+playlist$/i, ''))
  if (!key) return null
  return playlists.find(playlist => playlistKey(playlist.name) === key) || null
}

export function isValidYouTubeVideoId(id: string | undefined | null): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id)
}

export function youtubeSearchUrl(query: string) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
}

export function youtubePlaybackUrl(query: string, tracks: YouTubeCandidate[]) {
  const track = tracks.find(candidate => isValidYouTubeVideoId(candidate.id))
  return track
    ? `https://www.youtube.com/watch?v=${track.id}&autoplay=1`
    : youtubeSearchUrl(query)
}

export async function resolveYouTubePlayback<T extends YouTubeCandidate>(
  query: string,
  primaryTracks: T[],
  quotaExceeded: boolean,
  searchAlternatives: () => Promise<T[]>,
) {
  let tracks = primaryTracks.filter(track => isValidYouTubeVideoId(track.id))
  let source: 'youtube-api' | 'alternative' | 'youtube-search' = 'youtube-api'
  let alternativeError: unknown

  if (quotaExceeded) {
    source = 'alternative'
    try {
      tracks = (await searchAlternatives()).filter(track => isValidYouTubeVideoId(track.id))
    } catch (error) {
      alternativeError = error
      tracks = []
    }
  }

  const selected = tracks[0] || null
  if (!selected) source = 'youtube-search'
  return {
    tracks,
    selected,
    source,
    alternativeError,
    url: youtubePlaybackUrl(query, tracks),
  }
}
export interface MusicCommandEventDetail {
  commandId?: number
  activeTab?: string
  provider?: string
  source?: 'voice' | 'assistant'
  intent?: string
  action?: MusicCommandAction
  query?: string
  text?: string
}

let musicCommandSequence = 0
let pendingMusicCommand: MusicCommandEventDetail | null = null

/** Queue before dispatch so a command survives a React tab/provider transition. */
export function publishMusicCommand(detail: Omit<MusicCommandEventDetail, 'commandId'>) {
  const command: MusicCommandEventDetail = { ...detail, commandId: ++musicCommandSequence }
  pendingMusicCommand = command
  window.dispatchEvent(new CustomEvent('visionary:youtube-command', { detail: command }))
  return command
}

export function consumePendingMusicCommand() {
  const command = pendingMusicCommand
  pendingMusicCommand = null
  return command
}

export function clearPendingMusicCommand(commandId: number) {
  if (pendingMusicCommand?.commandId === commandId) pendingMusicCommand = null
}

export const YOUTUBE_WINDOW_NAME = 'visionary-nexus-youtube'

let youtubeWindowRef: Window | null = null
let lastYoutubeWindowUrl = ''
let lastYoutubeSearchKey = ''

function isYouTubeWindowOpen() {
  try {
    return Boolean(youtubeWindowRef && !youtubeWindowRef.closed)
  } catch {
    youtubeWindowRef = null
    return false
  }
}

export function openNamedYouTubeWindow(url: string) {
  if (isYouTubeWindowOpen()) {
    if (url !== lastYoutubeWindowUrl) {
      try {
        youtubeWindowRef!.location.href = url
        lastYoutubeWindowUrl = url
      } catch {
        youtubeWindowRef = null
        return false
      }
    }
    return true
  }

  try {
    youtubeWindowRef = window.open(url, YOUTUBE_WINDOW_NAME)
    if (!youtubeWindowRef) return false
    lastYoutubeWindowUrl = url
    return true
  } catch {
    youtubeWindowRef = null
    return false
  }
}

export function beginNamedYouTubeSearch(query: string) {
  const searchKey = query.toLocaleLowerCase().trim()
  if (searchKey && searchKey === lastYoutubeSearchKey && isYouTubeWindowOpen()) return true
  lastYoutubeSearchKey = searchKey
  return openNamedYouTubeWindow(youtubeSearchUrl(query))
}

export function navigateNamedYouTubeWindow(url: string) {
  if (!isYouTubeWindowOpen()) return false
  if (url === lastYoutubeWindowUrl) return true
  try {
    youtubeWindowRef!.location.href = url
    lastYoutubeWindowUrl = url
    return true
  } catch {
    youtubeWindowRef = null
    return false
  }
}
