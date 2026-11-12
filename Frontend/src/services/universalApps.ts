export type AppId = 'calendar' | 'gmail' | 'youtube' | 'maps' | 'whatsapp' | 'spotify' | 'outlook' | 'drive' | 'github'

export interface AppEntry {
  id: AppId
  name: string
  description: string
  url: string
  capability: 'launch' | 'launch-and-existing-controls'
}

export const APP_DIRECTORY: AppEntry[] = [
  { id: 'calendar', name: 'Google Calendar', description: 'Open calendar and events', url: 'https://calendar.google.com', capability: 'launch' },
  { id: 'gmail', name: 'Gmail', description: 'Open your inbox', url: 'https://www.gmail.com', capability: 'launch' },
  { id: 'youtube', name: 'YouTube', description: 'Open videos and playlists', url: 'https://www.youtube.com', capability: 'launch-and-existing-controls' },
  { id: 'maps', name: 'Google Maps', description: 'Open maps and places', url: 'https://maps.google.com', capability: 'launch-and-existing-controls' },
  { id: 'whatsapp', name: 'WhatsApp', description: 'Open your chats', url: 'https://web.whatsapp.com', capability: 'launch-and-existing-controls' },
  { id: 'spotify', name: 'Spotify', description: 'Open Spotify', url: 'https://open.spotify.com', capability: 'launch-and-existing-controls' },
  { id: 'outlook', name: 'Outlook', description: 'Open mail and calendar', url: 'https://outlook.live.com/mail', capability: 'launch' },
  { id: 'drive', name: 'Google Drive', description: 'Open your files', url: 'https://drive.google.com', capability: 'launch' },
  { id: 'github', name: 'GitHub', description: 'Open repositories', url: 'https://github.com', capability: 'launch' },
]

const BIRTHDAY_KEY = 'visionary_profile_birthday'

export function getStoredBirthday(): string {
  try { return window.localStorage.getItem(BIRTHDAY_KEY) || '' } catch { return '' }
}

export function saveBirthday(value: string): void {
  try {
    if (value) window.localStorage.setItem(BIRTHDAY_KEY, value)
    else window.localStorage.removeItem(BIRTHDAY_KEY)
  } catch { /* browser storage may be unavailable */ }
}

export function getNextBirthday(value: string, now = new Date()): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const makeDate = (year: number) => {
    const candidate = new Date(year, month - 1, day)
    if (candidate.getMonth() !== month - 1) {
      if (month === 2 && day === 29) return new Date(year, 1, 28)
      return null
    }
    return candidate
  }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  let next = makeDate(today.getFullYear())
  if (!next) return null
  if (next < today) next = makeDate(today.getFullYear() + 1)
  return next
}

export function answerBirthdayQuestion(message: string, now = new Date()): string | null {
  const normalized = message.toLowerCase().replace(/[’']/g, '').replace(/[?!.,]/g, ' ').replace(/\s+/g, ' ').trim()
  const asksDate = /^(?:when is|when s|whens|whats|what is) my birthday$/.test(normalized) ||
    /^(?:how many days until|days until|countdown to) my birthday$/.test(normalized)
  if (!asksDate) return null
  const saved = getStoredBirthday()
  if (!saved) return 'I do not have your birthday saved yet. Add it in Settings → Personal Details. Calendar account reading requires a separate authorised connection.'
  const next = getNextBirthday(saved, now)
  if (!next) return 'The saved birthday date looks invalid. Please update it in Settings → Personal Details.'
  const formatted = next.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
  const days = Math.round((new Date(next.getFullYear(), next.getMonth(), next.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86400000)
  return normalized.startsWith('how many') || normalized.startsWith('days until') || normalized.startsWith('countdown')
    ? days === 0 ? 'Your birthday is today!' : 'Your next birthday is ' + formatted + ' — ' + days + ' day' + (days === 1 ? '' : 's') + ' from today.'
    : 'Your next birthday is ' + formatted + '.'
}

export function matchAppLaunchCommand(message: string): AppEntry | null {
  const normalized = message.toLowerCase().replace(/[?!.,]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(?:please |can you |could you )+/, '')
  const match = normalized.match(/^(?:open|launch|start|go to|switch to) (?:the )?(?:my )?(.+?)(?: app| website)?$/)
  if (!match) return null
  const target = match[1].trim().replace(/\/$/, '')
  const aliases: Record<AppId, string[]> = {
    calendar: ['calendar', 'google calendar', 'my calendar'],
    gmail: ['gmail', 'email', 'inbox'],
    youtube: ['youtube', 'you tube'],
    maps: ['maps', 'google maps'],
    whatsapp: ['whatsapp', 'whats app'],
    spotify: ['spotify'],
    outlook: ['outlook', 'microsoft outlook'],
    drive: ['drive', 'google drive'],
    github: ['github'],
  }
  const knownApp = APP_DIRECTORY.find(app => aliases[app.id].includes(target) || app.url.replace(/^https?:\/\//, '').replace(/\/$/, '') === target)
  if (knownApp) return knownApp
  // Support direct website commands such as "open www.gmail.com" or "go to example.com".
  const domain = target.replace(/^https?:\/\//, '').split('/')[0]
  if (/^(?:www\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(domain)) {
    return { id: 'github', name: domain, description: 'Website', url: 'https://' + target.replace(/^https?:\/\//, ''), capability: 'launch' }
  }
  return null
}

export function openApp(entry: AppEntry, reservedWindow?: Window | null): void {
  if (reservedWindow && !reservedWindow.closed) reservedWindow.location.href = entry.url
  else window.open(entry.url, '_blank', 'noopener,noreferrer')
}

/**
 * Convert conversational Gmail navigation requests into Gmail's own search
 * URL. This only pre-fills Gmail search in the user's existing browser
 * session; it does not read inbox data or require Gmail API authorization.
 */
export function matchGmailConversationCommand(message: string): string | null {
  const cleaned = message
    .replace(/[’']/g, "'")
    .replace(/[?!,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  const patterns: Array<{ pattern: RegExp; prefix?: string }> = [
    { pattern: /^(?:please\s+)?(?:open|show|find)\s+(?:my\s+)?(?:chat|conversation|email thread|message thread)\s+(?:with|from)\s+(.+?)(?:\s+in\s+(?:gmail|my\s+gmail))?$/i },
    { pattern: /^(?:please\s+)?(?:open|show|find)\s+(?:the\s+)?(?:latest|most recent)\s+(?:email|message|conversation)\s+from\s+(.+?)(?:\s+in\s+gmail)?$/i, prefix: "from:(" },
    { pattern: /^(?:please\s+)?(?:search|find|look up|look for)\s+(?:my\s+)?(?:gmail|inbox|emails?)\s+(?:for|from)\s+(.+)$/i },
    { pattern: /^(?:please\s+)?(?:search|find|look up|look for)\s+(?:my\s+)?(?:emails?|messages?)\s+from\s+(.+)$/i, prefix: "from:(" },
  ]

  for (const { pattern, prefix = "" } of patterns) {
    const match = cleaned.match(pattern)
    const person = match?.[1]?.trim().replace(/[?!,]+$/, "")
    if (person) return prefix ? `${prefix}${person})` : person
  }
  return null
}

export function openGmailSearch(query: string, reservedWindow?: Window | null): void {
  const url = "https://mail.google.com/mail/u/0/#search/" + encodeURIComponent(query)
  if (reservedWindow && !reservedWindow.closed) {
    reservedWindow.location.href = url
  } else {
    window.open(url, "_blank", "noopener,noreferrer")
  }
}
