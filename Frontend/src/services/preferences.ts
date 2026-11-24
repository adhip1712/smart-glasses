export type PreferenceKind = 'category' | 'value'
export type UserPreferenceRow = { id?: string; category: string; value: string }
export type MusicPreferenceConfig = {
  service: string
  destination: 'internal' | 'website'
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j]
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      diagonal = above
    }
  }
  return row[b.length]
}

const aliases: Record<string, string> = {
  musi: 'Music',
  musc: 'Music',
  musick: 'Music',
  musicc: 'Music',
  soptif: 'Spotify',
  soptify: 'Spotify',
  spotfy: 'Spotify',
  spotiffy: 'Spotify',
  spotify: 'Spotify',
  yt: 'YouTube',
  ytb: 'YouTube',
  youtub: 'YouTube',
  'you tube': 'YouTube',
  'you-tube': 'YouTube',
  youtube: 'YouTube',
  ytmusic: 'YouTube Music',
  'youtube music': 'YouTube Music',
  applemusic: 'Apple Music',
  'apple music': 'Apple Music',
  soundcloud: 'SoundCloud',
  piped: 'Piped',
  invidious: 'Invidious',
}

export function normalizePreference(value: string, kind: PreferenceKind): string {
  const raw = value.trim().replace(/\s+/g, ' ')
  if (!raw) return ''
  const lower = raw.toLowerCase()
  if (aliases[lower]) return aliases[lower]

  const known = kind === 'category'
    ? ['Music', 'Player', 'Assistant', 'Voice', 'Navigation', 'Messaging']
    : ['Spotify', 'YouTube', 'YouTube Music', 'Apple Music', 'SoundCloud', 'Piped', 'Invidious']
  const candidate = known
    .map(item => ({
      item,
      distance: editDistance(
        lower.replace(/[\s-]/g, ''),
        item.toLowerCase().replace(/[\s-]/g, ''),
      ),
    }))
    .sort((a, b) => a.distance - b.distance)[0]

  if (candidate && candidate.distance <= (candidate.item.length >= 7 ? 2 : 1)) {
    return candidate.item
  }
  return raw
}

export function readMusicPreferenceConfig(): MusicPreferenceConfig {
  let rows: UserPreferenceRow[] = []
  let destination: 'internal' | 'website' = 'internal'
  try {
    const saved = JSON.parse(localStorage.getItem('visionary-preferences') || 'null')
    if (Array.isArray(saved?.rows)) rows = saved.rows
    destination = localStorage.getItem('visionary-player-destination') === 'website'
      ? 'website'
      : 'internal'
  } catch {
    // Use safe defaults when browser storage is unavailable.
  }

  const musicRow = rows.find(row =>
    normalizePreference(String(row?.category || ''), 'category') === 'Music',
  )
  const service = musicRow?.value
    ? normalizePreference(String(musicRow.value), 'value')
    : 'YouTube'

  return { service: service || 'YouTube', destination }
}

export function resolveMusicServiceFromCommand(
  text: string,
  preferredService: string,
): string {
  const normalized = text.toLowerCase()
  if (/\b(?:apple\s?music|applemusic)\b/.test(normalized)) return 'Apple Music'
  if (/\b(?:youtube\s?music|ytmusic)\b/.test(normalized)) return 'YouTube Music'
  if (/\b(?:soptif|soptify|spotfy|spotiffy|spotify)\b/.test(normalized)) return 'Spotify'
  if (/\b(?:yt|ytb|youtub|youtube|you[- ]tube)\b/.test(normalized)) return 'YouTube'
  return normalizePreference(preferredService, 'value') || 'YouTube'
}

/**
 * Persist the music service through the same browser preference store used by
 * Settings. The web client keeps this preference local to the current browser.
 */
export function saveMusicPreferenceConfig(service: string): boolean {
  const normalizedService = normalizePreference(service, "value")
  if (!normalizedService) return false
  try {
    const saved = JSON.parse(localStorage.getItem("visionary-preferences") || "null")
    const rows: UserPreferenceRow[] = Array.isArray(saved?.rows) ? saved.rows : []
    const musicRow = rows.find(row =>
      normalizePreference(String(row?.category || ""), "category") === "Music",
    )
    if (musicRow) musicRow.value = normalizedService
    else rows.push({ id: "music-default", category: "Music", value: normalizedService })
    localStorage.setItem("visionary-preferences", JSON.stringify({ rows }))
    window.dispatchEvent(new CustomEvent("visionary:preferences-updated"))
    return true
  } catch {
    return false
  }
}
