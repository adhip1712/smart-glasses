export type WebAppId =
  | "youtube" | "spotify" | "x" | "gmail" | "google-maps"
  | "google" | "wikipedia" | "reddit" | "github" | "twitch"
  | "google-drive" | "google-calendar" | "outlook" | "notion"
  | "linkedin" | "instagram" | "pinterest" | "stack-overflow"
  | "khan-academy" | "canva"

type WebAppDefinition = {
  label: string
  aliases: string[]
  home: string
  search: (query: string) => string
  vocabulary: string[]
}

const WEB_APPS: Record<WebAppId, WebAppDefinition> = {
  youtube: {
    label: "YouTube", aliases: ["youtube", "yt"],
    home: "https://www.youtube.com/",
    search: q => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
    vocabulary: ["videos", "channels", "playlists", "subscriptions", "shorts"],
  },
  spotify: {
    label: "Spotify", aliases: ["spotify"],
    home: "https://open.spotify.com/",
    search: q => `https://open.spotify.com/search/${encodeURIComponent(q)}`,
    vocabulary: ["tracks", "songs", "artists", "albums", "playlists", "queue"],
  },
  x: {
    label: "X", aliases: ["x", "twitter"],
    home: "https://x.com/",
    search: q => `https://x.com/search?q=${encodeURIComponent(q)}`,
    vocabulary: ["posts", "tweets", "reposts", "likes", "replies"],
  },
  gmail: {
    label: "Gmail", aliases: ["gmail", "google mail"],
    home: "https://mail.google.com/",
    search: q => `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(q)}`,
    vocabulary: ["emails", "inbox", "labels", "drafts"],
  },
  "google-maps": {
    label: "Google Maps", aliases: ["google maps", "maps"],
    home: "https://maps.google.com/",
    search: q => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`,
    vocabulary: ["places", "routes", "directions", "nearby"],
  },
  google: {
    label: "Google", aliases: ["google", "search"],
    home: "https://www.google.com/",
    search: q => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
    vocabulary: ["web pages", "images", "news", "results"],
  },
  wikipedia: {
    label: "Wikipedia", aliases: ["wikipedia", "wiki"],
    home: "https://www.wikipedia.org/",
    search: q => `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`,
    vocabulary: ["articles", "topics", "references"],
  },
  reddit: {
    label: "Reddit", aliases: ["reddit"],
    home: "https://www.reddit.com/",
    search: q => `https://www.reddit.com/search/?q=${encodeURIComponent(q)}`,
    vocabulary: ["communities", "posts", "comments"],
  },
  github: {
    label: "GitHub", aliases: ["github"],
    home: "https://github.com/",
    search: q => `https://github.com/search?q=${encodeURIComponent(q)}`,
    vocabulary: ["repositories", "code", "issues", "pull requests"],
  },
  twitch: {
    label: "Twitch", aliases: ["twitch"],
    home: "https://www.twitch.tv/",
    search: q => `https://www.twitch.tv/search?term=${encodeURIComponent(q)}`,
    vocabulary: ["streams", "channels", "categories"],
  },
  "google-drive": {
    label: "Google Drive", aliases: ["google drive", "drive"],
    home: "https://drive.google.com/drive/u/0/my-drive",
    search: q => `https://drive.google.com/drive/search?q=${encodeURIComponent(q)}`,
    vocabulary: ["files", "folders", "documents", "shared drives"],
  },
  "google-calendar": {
    label: "Google Calendar", aliases: ["google calendar", "calendar"],
    home: "https://calendar.google.com/calendar/u/0/r",
    search: q => `https://calendar.google.com/calendar/u/0/r/search?q=${encodeURIComponent(q)}`,
    vocabulary: ["events", "meetings", "schedules", "reminders"],
  },
  outlook: {
    label: "Outlook", aliases: ["outlook", "microsoft outlook"],
    home: "https://outlook.live.com/mail/",
    search: q => `https://outlook.live.com/mail/0/search?q=${encodeURIComponent(q)}`,
    vocabulary: ["emails", "inbox", "calendar", "contacts"],
  },
  notion: {
    label: "Notion", aliases: ["notion"],
    home: "https://www.notion.so/",
    search: q => `https://www.notion.so/search?query=${encodeURIComponent(q)}`,
    vocabulary: ["pages", "databases", "notes", "workspaces"],
  },
  linkedin: {
    label: "LinkedIn", aliases: ["linkedin", "linked in"],
    home: "https://www.linkedin.com/",
    search: q => `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(q)}`,
    vocabulary: ["profiles", "posts", "jobs", "connections"],
  },
  instagram: {
    label: "Instagram", aliases: ["instagram", "insta"],
    home: "https://www.instagram.com/",
    search: q => `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(q)}`,
    vocabulary: ["posts", "reels", "profiles", "stories"],
  },
  pinterest: {
    label: "Pinterest", aliases: ["pinterest"],
    home: "https://www.pinterest.com/",
    search: q => `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(q)}`,
    vocabulary: ["pins", "boards", "ideas", "collections"],
  },
  "stack-overflow": {
    label: "Stack Overflow", aliases: ["stack overflow", "stackoverflow"],
    home: "https://stackoverflow.com/",
    search: q => `https://stackoverflow.com/search?q=${encodeURIComponent(q)}`,
    vocabulary: ["questions", "answers", "tags", "code examples"],
  },
  "khan-academy": {
    label: "Khan Academy", aliases: ["khan academy"],
    home: "https://www.khanacademy.org/",
    search: q => `https://www.khanacademy.org/search?page_search_query=${encodeURIComponent(q)}`,
    vocabulary: ["lessons", "courses", "practice", "subjects"],
  },
  canva: {
    label: "Canva", aliases: ["canva"],
    home: "https://www.canva.com/",
    search: q => `https://www.canva.com/search?q=${encodeURIComponent(q)}`,
    vocabulary: ["designs", "presentations", "templates", "projects"],
  },
}

export type WebAppCommand = {
  app: WebAppId
  query: string
  action: "open" | "search"
}

export function parseWebAppCommand(command: string): WebAppCommand | null {
  const clean = command.trim()
  const searchFirst = clean.match(/^(?:please\s+)?(?:search|find)\s+(.+?)\s+(?:on|in)\s+(.+?)\s*[.!?]*$/i)
  const appFirst = clean.match(/^(?:please\s+)?(?:open|launch|go to|visit)\s+(?:the\s+)?(.+?)(?:\s+(?:and\s+)?(?:search|find)\s+(?:for\s+)?(.+?))?\s*[.!?]*$/i)
  const rawApp = (searchFirst?.[2] || appFirst?.[1] || "").trim().toLowerCase()
  if (!rawApp) return null
  const app = (Object.entries(WEB_APPS).find(([, definition]) =>
    definition.aliases.includes(rawApp)
  )?.[0] || null) as WebAppId | null
  if (!app) return null
  const query = (searchFirst?.[1] || appFirst?.[2] || "").trim()
  return { app, query, action: query ? "search" : "open" }
}

export function getWebAppDefinition(app: WebAppId): WebAppDefinition {
  return WEB_APPS[app]
}

export function getWebAppNextStep(app: WebAppId): string {
  const prompts: Record<WebAppId, string> = {
    youtube: "What would you like to watch?",
    spotify: "What would you like to listen to?",
    x: "What would you like to search for?",
    gmail: "Would you like to search for an email?",
    "google-maps": "What destination should I look up?",
    google: "What would you like to search for?",
    wikipedia: "Which topic should I look up?",
    reddit: "Which topic or community are you interested in?",
    github: "Which repository or project should I find?",
    twitch: "Which streamer or category should I look for?",
    "google-drive": "Which file or folder are you looking for?",
    "google-calendar": "Would you like to look up an event?",
    outlook: "Would you like to search for an email?",
    notion: "Which page or workspace are you looking for?",
    linkedin: "Would you like to search for a person, post, or job?",
    instagram: "Which account or topic are you looking for?",
    pinterest: "What kind of ideas or pins should I find?",
    "stack-overflow": "What programming question should I search for?",
    "khan-academy": "Which subject would you like to study?",
    canva: "What would you like to design?",
  }
  return prompts[app]
}

export function buildWebAppUrl(command: WebAppCommand): string {
  const definition = WEB_APPS[command.app]
  return command.query ? definition.search(command.query) : definition.home
}

/**
 * Opens a destination in a browser tab reserved synchronously from the user's
 * interaction. A website cannot inspect or click inside another origin; this
 * helper deliberately reports navigation handoff, not verified page actions.
 */
export function openWebDestination(url: string, reservedWindow?: Window | null): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false
  if (!reservedWindow || reservedWindow.closed) return false
  reservedWindow.opener = null
  reservedWindow.location.replace(parsed.href)
  return true
}

export function getWebAppCapabilityContext(): string {
  return Object.entries(WEB_APPS).map(([id, app]) =>
    `${id}: ${app.label}; aliases: ${app.aliases.join(", ")}; vocabulary: ${app.vocabulary.join(", ")}`
  ).join("\n")
}

/** Prevent browser navigation to inherently age-restricted or dangerous services. */
export function isRestrictedWebDestinationRequest(message: string): boolean {
  const restrictedTarget =
    /\\b(?:porn|pornography|adult videos?|xxx|onlyfans|xvideos|xhamster|redtube|brazzers|casino|gambling sites?|betting sites?|sportsbook|online betting|gun shop|firearm store|buy guns|ammunition|ammo store|vape shop|vaping|nicotine products|cigarette shop|tobacco shop|liquor store|buy alcohol|drug marketplace|buy drugs|weed shop|marijuana dispensary)\\b/i.test(message)
  const navigationIntent = /\\b(?:open|visit|launch|search|find|go to|browse)\\b/i.test(message)
  return restrictedTarget && navigationIntent
}
